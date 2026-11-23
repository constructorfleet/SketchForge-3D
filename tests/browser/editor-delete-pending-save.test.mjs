import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// Issue #665: an edit publishes 120 ms after it is made. A project deleted in
// that gap got its stored copy back from the late save. Timers are paused so
// the delete lands in the gap.

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function withEditor(env, run) {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  let browser;
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
      assert.ok(Date.now() < deadline, `Next.js did not become ready:\n${logs}`);
      try {
        if ((await fetch(baseURL)).ok) break;
      } catch {
        // The production server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());
    await run({ page, baseURL });
  } finally {
    await browser?.close();
    if (server.pid) {
      try {
        if (process.platform === "win32") server.kill("SIGTERM");
        else process.kill(-server.pid, "SIGTERM");
      } catch {
        // The server already exited.
      }
    }
  }
}

async function pollUntil(read, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

function storedPackageIds(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const opened = indexedDB.open("sketchForge.projectShapes");
    opened.onerror = () => resolve([]);
    opened.onsuccess = () => {
      if (!opened.result.objectStoreNames.contains("projectShapes")) return resolve([]);
      const read = opened.result.transaction("projectShapes").objectStore("projectShapes").getAllKeys();
      read.onerror = () => resolve([]);
      read.onsuccess = () => resolve(read.result);
    };
  }));
}

async function addBox(page) {
  await page.getByRole("button", { name: "Add shape" }).click();
  await page.getByText("Box", { exact: true }).first().click();
}

// Adds a box, then deletes the project before that edit's save publishes.
async function editThenDelete(page) {
  await page.clock.install();
  // From the page's clock: a target already past throws "Cannot fast-forward to the past".
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 500);
  await addBox(page);
  await page.getByRole("button", { name: "Home dashboard" }).click();
  await page.getByRole("button", { name: /^Project options for / }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.locator(".dashboard-confirm-delete").click();
  await page.clock.resume();
  // Long enough for the 120 ms publish and an idle-time save to run.
  await page.waitForTimeout(3_000);
}

async function openNewDesign(page, baseURL) {
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Create new 3D design" }).click();
  await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
}

test("a project deleted just after an edit stays deleted in browser storage", { timeout: 180_000 }, async () => {
  await withEditor({}, async ({ page, baseURL }) => {
    await openNewDesign(page, baseURL);
    await addBox(page);
    const before = await pollUntil(() => storedPackageIds(page), (ids) => ids.length === 1);
    assert.equal(before.length, 1, "the first edit was never stored");

    await editThenDelete(page);

    assert.deepEqual(await storedPackageIds(page), [], "the late save stored the deleted project again");
    await page.reload();
    await page.getByRole("button", { name: "Create new 3D design" }).waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await page.locator(".project-card").count(), 0, "the deleted project is back in the list");
  });
});

test("a project deleted just after an edit stays deleted in server storage", { timeout: 180_000 }, async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "sketchforge-delete-pending-"));
  try {
    await withEditor({ SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "delete-pending-token" }, async ({ page, baseURL }) => {
      const listed = async () => (await (await fetch(`${baseURL}/api/projects`)).json()).projects?.map((record) => record.projectId) ?? [];
      await openNewDesign(page, baseURL);
      // Edits made before the switch go to the browser; wait until they go to the server.
      await pollUntil(() => page.evaluate(() => window.localStorage.getItem("sketchForge.projects") === null), Boolean, 30_000);
      await addBox(page);
      const before = await pollUntil(listed, (ids) => ids.length === 1);
      assert.equal(before.length, 1, "the first edit was never stored on the server");

      await editThenDelete(page);

      assert.deepEqual(await listed(), [], "the late save stored the deleted project on the server again");
      assert.deepEqual(readdirSync(projectsDir).filter((name) => name.endsWith(".skf")), [], "a package file is back on disk");
    });
  } finally {
    rmSync(projectsDir, { recursive: true, force: true });
  }
});
