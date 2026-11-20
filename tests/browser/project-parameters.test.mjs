import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright";
import { exportSkfProject, shapeFromRequest } from "@constructorfleet/sketchforge-engine";

// Issue #609: the browser keeps a project's parameter table through opening an
// .skf, editor autosave, a reload, and "Export all projects". No editor UI
// changes the table yet, so every save must carry it through unchanged.

const parameters = [
  { name: "wall", expression: "2", dimension: "length", value: 2 },
  { name: "depth", expression: "wall * 5", dimension: "length", value: 10 },
];

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startNextServer() {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: process.env,
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
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
    try {
      if ((await fetch(baseURL)).ok) return { baseURL, stop };
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop();
  throw new Error(`Next.js did not become ready:\n${logs}`);
}

async function addShape(page) {
  await page.locator(".toolbar-section-label", { hasText: "Shapes" }).locator("xpath=..").locator("button").first().click();
  await page.locator(".shape-menu-item").first().click();
}

async function goHomeAndWaitForShapes(page, shapes) {
  await page.getByRole("button", { name: "Home dashboard" }).click();
  await page.waitForFunction((count) => {
    const summary = JSON.parse(document.querySelector("pre[data-codex-projects]")?.textContent ?? "[]");
    return summary.length === 1 && summary[0].shapes === count;
  }, shapes, { timeout: 60_000 });
}

test("an opened .skf keeps its parameter table through autosave, reload and Export all projects", { timeout: 240_000 }, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-parameters-"));
  const fixture = path.join(fixtureDir, "parameters.skf");
  const box = shapeFromRequest({ kind: "box", width: 10 });
  assert.ok(box);
  fs.writeFileSync(fixture, await exportSkfProject({
    projectName: "parameters",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    shapes: [box],
    history: [],
    historyIndex: 0,
    assets: [],
    workspace: undefined,
    snapGrid: "1.0 mm",
    placementElevation: 0,
    parameters,
  }));
  const { baseURL, stop } = await startNextServer();
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(baseURL);

    // Opening the file goes straight to the editor; a new shape makes it autosave.
    await page.locator("input.hidden-file-input[accept^=\".skf,.stl\"]").setInputFiles(fixture);
    await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });
    await addShape(page);
    await goHomeAndWaitForShapes(page, 2);

    // After a reload the editor starts from the stored package.
    await page.reload();
    await page.locator(".project-card-open").first().click();
    await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });
    await addShape(page);
    await goHomeAndWaitForShapes(page, 3);

    await page.reload();
    const exportTile = page.locator(".dashboard-actions-band").getByRole("button", { name: "Export all projects" });
    await exportTile.waitFor({ state: "visible" });
    const [download] = await Promise.all([page.waitForEvent("download"), exportTile.click()]);
    const archive = unzipSync(new Uint8Array(fs.readFileSync(await download.path())));
    assert.deepEqual(Object.keys(archive), ["parameters.skf"]);
    const document = JSON.parse(strFromU8(unzipSync(archive["parameters.skf"])["project.json"]));
    const scene = document.states.find((state) => state.id === document.sceneStateId);

    assert.deepEqual(document.parameters, parameters, "the table survives every browser save");
    assert.equal(document.formatVersion, 3);
    assert.equal(scene.rootNodeIds.length, 3, "both added shapes were saved");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
