import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

// Issue #672: a save sent before a delete can reach the server after it.
// Holds the next project POST that carries `field` until released.
async function holdNextPost(page, field) {
  let release = () => {};
  const released = new Promise((resolve) => { release = resolve; });
  let markHeld = () => {};
  const held = new Promise((resolve) => { markHeld = resolve; });
  let armed = true;
  await page.route("**/api/projects?*", async (route) => {
    const request = route.request();
    const body = request.method() === "POST" ? request.postDataBuffer()?.toString("latin1") ?? "" : "";
    if (armed && body.includes(`name="${field}"`)) {
      armed = false;
      markHeld(new URL(request.url()).searchParams.get("projectId"));
      await released;
    }
    await route.continue();
  });
  return { held, release };
}

async function deleteFromDashboard(page, options = /^Project options for /) {
  const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("/api/projects?"));
  await page.getByRole("button", { name: options }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.locator(".dashboard-confirm-delete").click();
  assert.equal((await deleted).status(), 200, "the delete must reach the server");
}

async function releaseAfterDelete(page, post, options) {
  await deleteFromDashboard(page, options);
  const late = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/projects?"));
  post.release();
  await late;
  // Room for any write the late answer sets off.
  await page.waitForTimeout(1_500);
  // The user deleted it: a refused late save is expected, not a failure to report.
  assert.equal(await page.getByText(/deleted before this save|not on the server|could not save/i).count(), 0, "a refused late save was reported as an error");
}

async function withServerProject(run) {
  const projectsDir = mkdtempSync(join(tmpdir(), "sketchforge-delete-held-"));
  try {
    await withEditor({ SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "delete-held-token" }, async ({ page, baseURL }) => {
      const listed = async () => (await (await fetch(`${baseURL}/api/projects`)).json()).projects?.map((record) => record.projectId) ?? [];
      const stored = () => readdirSync(projectsDir).filter((name) => name.endsWith(".skf") || name.endsWith(".json"));
      await openNewDesign(page, baseURL);
      await pollUntil(() => page.evaluate(() => window.localStorage.getItem("sketchForge.projects") === null), Boolean, 30_000);
      await addBox(page);
      assert.equal((await pollUntil(stored, (names) => names.length === 2)).length, 2, "the first edit was never stored on the server");
      // Let the edit's own writes finish, so only the next one is held.
      await page.waitForTimeout(2_000);
      await run({ page, listed, stored, baseURL, projectsDir });
    });
  } finally {
    rmSync(projectsDir, { recursive: true, force: true });
  }
}

test("a dashboard entry save held past a delete does not bring the project back", { timeout: 180_000 }, async () => {
  await withServerProject(async ({ page, listed, stored }) => {
    await page.getByRole("button", { name: "Home dashboard" }).click();
    const metadataPost = await holdNextPost(page, "metadata");
    await page.getByRole("button", { name: /^Project options for / }).first().click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Project name" }).fill("Renamed before delete");
    await page.locator(".dashboard-confirm-save").click();
    await metadataPost.held;

    await releaseAfterDelete(page, metadataPost);

    assert.deepEqual(await listed(), [], "the held metadata save recreated the deleted project");
    assert.deepEqual(stored(), [], "a project file is back on disk");
  });
});

test("a package save held past a delete does not bring the project back", { timeout: 180_000 }, async () => {
  await withServerProject(async ({ page, listed, stored }) => {
    const packagePost = await holdNextPost(page, "project");
    await addBox(page);
    await packagePost.held;
    await page.getByRole("button", { name: "Home dashboard" }).click();

    await releaseAfterDelete(page, packagePost);

    assert.deepEqual(await listed(), [], "the held package save recreated the deleted project");
    assert.deepEqual(stored(), [], "a project file is back on disk");
  });
});

test("a new project's first save held past its delete does not bring it back", { timeout: 180_000 }, async () => {
  await withServerProject(async ({ page, listed, stored }) => {
    await page.getByRole("button", { name: "Home dashboard" }).click();
    await page.getByRole("button", { name: /^Project options for / }).first().click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Project name" }).fill("Kept project");
    await page.locator(".dashboard-confirm-save").click();
    const kept = await pollUntil(listed, (ids) => ids.length === 1);
    await page.waitForTimeout(1_000);

    // A create carries no base, so the server cannot tell it from a late one.
    const createPost = await holdNextPost(page, "metadata");
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await createPost.held;
    await page.getByRole("button", { name: "Home dashboard" }).click();

    await releaseAfterDelete(page, createPost, /^Project options for (?!Kept project)/);

    assert.deepEqual(await listed(), kept, "the held first save recreated the deleted project");
    assert.deepEqual(stored().filter((name) => !name.startsWith(kept[0])), [], "a file of the deleted project is back on disk");
  });
});

// Holds the next DELETE until released; other requests go on to earlier handlers.
async function holdNextDelete(page) {
  let release = () => {};
  const released = new Promise((resolve) => { release = resolve; });
  let markHeld = () => {};
  const held = new Promise((resolve) => { markHeld = resolve; });
  let armed = true;
  await page.route("**/api/projects?*", async (route) => {
    if (!armed || route.request().method() !== "DELETE") return route.fallback();
    armed = false;
    markHeld();
    await released;
    await route.fallback();
  });
  return { held, release };
}

test("undoing a late save spares a copy another client saved in between", { timeout: 180_000 }, async () => {
  await withServerProject(async ({ page, listed, baseURL, projectsDir }) => {
    const packagePost = await holdNextPost(page, "project");
    await addBox(page);
    const projectId = await packagePost.held;
    await page.getByRole("button", { name: "Home dashboard" }).click();
    await deleteFromDashboard(page);

    // The late save lands; hold this tab's undo of it while another client saves the project back (#665).
    const undo = await holdNextDelete(page);
    packagePost.release();
    await undo.held;
    const otherCopy = new Uint8Array([9, 9, 9, 9]);
    const save = (fill) => {
      const body = new FormData();
      fill(body);
      return fetch(`${baseURL}/api/projects?projectId=${projectId}`, { method: "POST", headers: { Origin: baseURL }, body });
    };
    assert.ok((await save((body) => {
      body.append("project", new Blob([otherCopy]));
      body.append("revision", String(Date.now()));
      body.append("baseRevision", "1");
    })).ok, "the other client's package save must succeed");
    assert.ok((await save((body) => {
      body.append("metadata", JSON.stringify({ id: projectId, name: "Saved elsewhere", revision: Date.now(), updatedAt: Date.now() }));
      body.append("baseMetadataRevision", "0");
    })).ok, "the other client's entry save must succeed");

    const undone = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("/api/projects?"));
    undo.release();
    assert.equal((await undone).status(), 409, "the undo must be refused once the project changed");

    assert.deepEqual(await listed(), [projectId], "the other client's copy was deleted");
    assert.deepEqual([...readFileSync(join(projectsDir, `${projectId}.skf`))], [...otherCopy], "the other client's package was replaced");
  });
});
