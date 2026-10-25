import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright";

// Issue #333: persistent storage, the quota warning, Workspace Settings > Storage,
// and "Export all projects". Set SKETCHFORGE_SCREENSHOT_DIR to keep screenshots.
const SCREENSHOT_DIR = process.env.SKETCHFORGE_SCREENSHOT_DIR;

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, server, getLogs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${getLogs()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js did not become ready:\n${getLogs()}`);
}

async function screenshot(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

/**
 * Stands in for `navigator.storage` so the test controls the quota and can
 * count persistence requests. Usage is 85% of quota, past the 80% warning.
 */
function stubStorageManager() {
  window.__persistCalls = 0;
  const storage = {
    persisted: async () => window.localStorage.getItem("test.persisted") === "1",
    persist: async () => {
      window.__persistCalls += 1;
      return false;
    },
    estimate: async () => ({ usage: 850 * 1024 * 1024, quota: 1000 * 1024 * 1024 }),
  };
  Object.defineProperty(Navigator.prototype, "storage", { configurable: true, get: () => storage });
}

async function startNextServer(env = {}) {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  const stop = () => {
    if (server.exitCode !== null) return;
    try { if (process.platform === "win32") server.kill("SIGTERM"); else process.kill(-server.pid, "SIGTERM"); } catch { /* server already exited */ }
  };
  try {
    await waitForServer(baseURL, server, () => logs);
  } catch (error) {
    stop();
    throw error;
  }
  return { baseURL, stop };
}

async function importFixture(page, fixture) {
  await page.locator("input.hidden-file-input[accept^=\".skf,.stl\"]").setInputFiles(fixture);
  await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "Home dashboard" }).click();
}

test("the dashboard warns near quota and exports every project as one ZIP of .skf packages", { timeout: 240_000 }, async () => {
  const { baseURL, stop } = await startNextServer();
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(stubStorageManager);
    const page = await context.newPage();
    await page.goto(baseURL);

    // Nothing to export yet.
    const exportTile = page.locator(".dashboard-actions-band").getByRole("button", { name: "Export all projects" });
    await exportTile.waitFor({ state: "visible" });
    assert.equal(await exportTile.isDisabled(), true, "Export all projects is disabled with no projects");

    // Persistence is requested once per profile, not on every load.
    await page.waitForFunction(() => window.__persistCalls === 1);
    await page.reload();
    await exportTile.waitFor({ state: "visible" });
    await page.locator(".dashboard-storage-warning").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.__persistCalls), 0, "a later load does not ask again");

    const warning = page.getByRole("alert").filter({ hasText: "85%" });
    await warning.waitFor({ state: "visible" });

    // Two projects with geometry, each imported from a fixture.
    for (const fixture of ["tests/fixtures/svg/square.svg", "tests/fixtures/obj/triangle.obj"]) {
      await importFixture(page, fixture);
      await exportTile.waitFor({ state: "visible" });
    }

    // A reload empties the in-session copies, so the export has to read the
    // projects back from IndexedDB. Opening one puts it back in session; the
    // other is only in storage. A search then hides one of them.
    await page.reload();
    await page.locator(".project-card").filter({ hasText: "square" }).locator(".project-card-open").click();
    await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });
    await page.getByRole("button", { name: "Home dashboard" }).click();
    await exportTile.waitFor({ state: "visible" });
    const summary = JSON.parse(await page.locator("pre[data-codex-projects]").textContent());
    assert.equal(summary.length, 2, "both imports created a project");
    assert.deepEqual(summary.map((project) => [project.designShapes !== null, project.shapes > 0]).sort(), [[false, true], [true, true]],
      "one project is in session and the other is only in storage");
    await page.getByRole("textbox", { name: "Search projects" }).fill("square");
    await page.locator(".project-card").filter({ hasText: "triangle" }).waitFor({ state: "detached" });
    await screenshot(page, "dashboard-export-all-projects.png");
    const stored = summary;

    const [download] = await Promise.all([page.waitForEvent("download"), warning.getByRole("button", { name: "Export all projects" }).click()]);
    assert.match(download.suggestedFilename(), /^sketchforge-projects-\d{4}-\d{2}-\d{2}\.zip$/);
    await page.getByRole("status").filter({ hasText: "Exported 2 projects" }).waitFor({ state: "visible" });

    const archive = unzipSync(new Uint8Array(fs.readFileSync(await download.path())));
    const names = Object.keys(archive).sort();
    assert.deepEqual(names, ["square.skf", "triangle.skf"], "one .skf per project and nothing else");

    const exported = names.map((name) => {
      const packageFiles = unzipSync(archive[name]);
      assert.equal(Object.keys(packageFiles).some((file) => /thumbnail|\.png$/i.test(file)), false, `${name} carries no generated thumbnail`);
      const document = JSON.parse(strFromU8(packageFiles["project.json"]));
      const scene = document.states.find((state) => state.id === document.sceneStateId);
      return { shapes: scene.rootNodeIds.length, revision: Date.parse(document.metadata.modifiedAt) };
    });
    const expected = stored.map((project) => ({ shapes: project.shapes, revision: project.revision }))
      .sort((a, b) => a.revision - b.revision);
    assert.deepEqual([...exported].sort((a, b) => a.revision - b.revision), expected, "shape counts and revisions survive the export");
    assert.ok(exported.every((project) => project.shapes > 0), "each exported project has its geometry");

    // Workspace Settings > Storage shows persistence and usage.
    await page.locator(".project-card-open").first().click();
    await page.getByRole("button", { name: "Workspace settings" }).click();
    const settings = page.getByRole("dialog", { name: "Workspace settings" });
    await settings.getByRole("button", { name: "Storage" }).click();
    await settings.getByText("Off. The browser may clear your projects when the device runs low on space.").waitFor({ state: "visible" });
    await settings.getByText("850 MB of 1,000 MB (85%)").waitFor({ state: "visible" });
    assert.equal(await settings.getByRole("meter", { name: "Share of browser storage used" }).getAttribute("value"), "0.85");
    await screenshot(page, "workspace-settings-storage.png");
  } finally {
    if (browser) await browser.close();
    stop();
  }
});

test("with server project storage, nothing asks the browser to persist and Storage says where projects are", { timeout: 240_000 }, async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-backup-test-"));
  const { baseURL, stop } = await startNextServer({ SKETCHFORGE_PROJECTS_DIR: projectsDir });
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(stubStorageManager);
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByText("On server", { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 });

    await importFixture(page, "tests/fixtures/svg/square.svg");
    await page.locator(".dashboard-actions-band").getByRole("button", { name: "Export all projects" }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".dashboard-storage-warning").count(), 0, "server storage shows no browser quota warning");
    assert.equal(await page.evaluate(() => window.__persistCalls), 0, "server storage never asks the browser to persist");
    assert.equal(await page.evaluate(() => window.localStorage.getItem("sketchForge.storagePersistRequested")), null,
      "the once-per-profile request is not spent in server mode");

    await page.locator(".project-card-open").first().click();
    await page.getByRole("button", { name: "Workspace settings" }).click();
    const settings = page.getByRole("dialog", { name: "Workspace settings" });
    await settings.getByRole("button", { name: "Storage" }).click();
    await settings.getByText("Your projects are saved on the server, not in this browser", { exact: false }).waitFor({ state: "visible" });
    assert.equal(await settings.getByText("The browser may clear your projects", { exact: false }).count(), 0);
    assert.equal(await settings.getByRole("meter").count(), 0, "no browser usage meter in server mode");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
