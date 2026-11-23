import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// Issue #670: two tabs share one browser project list. A tab still holding a
// deleted project wrote it back into that list, the deleting tab took it in
// again, and its delete mark was lifted. A delete is now shared by every tab.

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function withTwoTabs(t) {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.pid) {
      try {
        if (process.platform === "win32") server.kill("SIGTERM");
        else process.kill(-server.pid, "SIGTERM");
      } catch {
        // The server already exited.
      }
    }
  });
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/api/app-update**", (route) => route.abort());
  const first = await context.newPage();
  const second = await context.newPage();
  return { baseURL, first, second };
}

async function until(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

const cards = (page) => page.locator(".project-card");
const listedIds = (page) => page.evaluate(() => JSON.parse(window.localStorage.getItem("sketchForge.projects") ?? "[]").map((project) => project.id));

async function addBox(page) {
  await page.getByRole("button", { name: "Add shape" }).click();
  await page.getByText("Box", { exact: true }).first().click();
}

test("a project deleted in one tab stays deleted when another tab writes an older list", { timeout: 180_000 }, async (t) => {
  const { baseURL, first, second } = await withTwoTabs(t);
  await first.goto(baseURL);
  await first.getByRole("button", { name: "Create new 3D design" }).click();
  await first.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
  await addBox(first);
  await until(async () => (await storedPackageIds(first)).length === 1, "the first edit was never stored");
  const [projectId] = await storedPackageIds(first);

  await second.goto(baseURL);
  await cards(second).first().waitFor({ state: "visible", timeout: 60_000 });
  const olderList = await second.evaluate(() => window.localStorage.getItem("sketchForge.projects"));

  // Edit, then delete before the edit's save publishes.
  await first.clock.install();
  await first.clock.pauseAt(await first.evaluate(() => Date.now()) + 500);
  await addBox(first);
  await first.getByRole("button", { name: "Home dashboard" }).click();
  await first.getByRole("button", { name: /^Project options for / }).first().click();
  await first.getByRole("menuitem", { name: "Delete" }).click();
  await first.locator(".dashboard-confirm-delete").click();

  // The second tab, which had not caught up, writes the list it holds.
  await second.evaluate((list) => window.localStorage.setItem("sketchForge.projects", list), olderList);
  await first.clock.resume();
  await first.waitForTimeout(3_000);

  assert.deepEqual(await storedPackageIds(first), [], "a late save stored the deleted project again");
  assert.equal(await cards(first).count(), 0, "the deleted project is back in the deleting tab");
  await until(async () => (await cards(second).count()) === 0, "the deleted project stays in the other tab");
  // Either tab writing its list again keeps the project out.
  await second.getByRole("button", { name: "Create new 3D design" }).click();
  await second.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
  await until(async () => (await listedIds(second)).length === 1, "the other tab's new project is listed");
  assert.equal((await listedIds(second)).includes(projectId), false, "the other tab's list brings the deleted project back");
  await first.reload();
  await first.getByRole("button", { name: "Create new 3D design" }).waitFor({ state: "visible", timeout: 60_000 });
  assert.equal((await listedIds(first)).includes(projectId), false, "the deleted project is listed after a reload");
});
