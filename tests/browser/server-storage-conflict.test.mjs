import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright";

// Issue #650: clients sharing one server project directory must not overwrite each
// other's newer package. Set SKETCHFORGE_SCREENSHOT_DIR to keep screenshots.
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

async function screenshot(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

async function importFixture(page, fixture) {
  await page.locator("input.hidden-file-input[accept^=\".skf,.stl\"]").setInputFiles(fixture);
  await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "Home dashboard" }).click();
}

function assertSameBytes(actual, expected, message) {
  assert.ok(actual, `${message}: nothing stored`);
  assert.ok(Buffer.from(actual).equals(Buffer.from(expected)), `${message}: ${actual.byteLength} stored bytes differ from the ${expected.byteLength} expected`);
}

function projectSummary(page) {
  return page.locator("pre[data-codex-projects]").textContent().then((text) => JSON.parse(text));
}

/** Gives the first shape definition in `project.json` a kind no release knows. */

function rootNodeCount(bytes) {
  const document = JSON.parse(strFromU8(unzipSync(bytes)["project.json"]));
  return document.states.find((state) => state.id === document.sceneStateId).rootNodeIds.length;
}

function sceneRows(page) {
  return page.locator(".scene-inspector-list > li.scene-row").count();
}

async function addBox(page) {
  const before = await sceneRows(page);
  await page.getByRole("button", { name: "Add shape" }).click();
  await page.getByText("Box", { exact: true }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll(".scene-inspector-list > li.scene-row").length === count + 1, before, { timeout: 15_000 });
}

/** Waits until the file at `filePath` differs from `previous`, and returns its bytes. */
async function nextSave(filePath, previous, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = fs.existsSync(filePath) ? new Uint8Array(fs.readFileSync(filePath)) : null;
    if (current && !Buffer.from(current).equals(Buffer.from(previous))) return current;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${path.basename(filePath)} was not saved again within ${timeout} ms`);
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return new Uint8Array(fs.readFileSync(filePath));
}

/** One server directory, two browser profiles, the same project open in both. */
async function twoClients(t) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-server-conflict-test-"));
  const { baseURL, stop } = await startNextServer({ SKETCHFORGE_PROJECTS_DIR: projectsDir });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    stop();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });
  const open = async () => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByText("On server", { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 });
    return page;
  };
  const clientA = await open();
  await importFixture(clientA, "tests/fixtures/svg/square.svg");
  const [{ id: projectId }] = await projectSummary(clientA);
  const packagePath = path.join(projectsDir, `${projectId}.skf`);
  const imported = await waitForFile(packagePath);
  await clientA.locator(".project-card-open").first().click();
  await clientA.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });

  const clientB = await open();
  await clientB.locator(".project-card-open").first().click();
  await clientB.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
  return { clientA, clientB, packagePath, imported };
}

test("a server-storage client does not save its copy over a newer one another client saved", { timeout: 300_000 }, async (t) => {
  const { clientA, clientB, packagePath, imported } = await twoClients(t);

  await addBox(clientB);
  const fromB = await nextSave(packagePath, imported);
  assert.equal(rootNodeCount(fromB), 2, "client B saved the square and its box");

  // Client A, whose clock is later, edits the copy it loaded before B saved.
  await addBox(clientA);
  const conflict = clientA.getByRole("alert").filter({ hasText: "was changed elsewhere" });
  // Long enough for autosave to have written, had it been allowed to.
  await clientA.waitForTimeout(5_000);
  assertSameBytes(new Uint8Array(fs.readFileSync(packagePath)), fromB, "client B's newer package is kept");
  await conflict.waitFor({ state: "visible" });
  assert.equal(await clientA.getByRole("button", { name: "Add shape" }).count(), 0, "client A's editor closes");
  assert.equal(await conflict.getByRole("button", { name: "Start over" }).count(), 0, "nothing offers to replace the newer copy");
  await screenshot(clientA, "server-storage-conflict.png");

  // A's unsaved copy can still be downloaded.
  const [download] = await Promise.all([
    clientA.waitForEvent("download"),
    conflict.getByRole("button", { name: "Download my copy: square", exact: true }).click(),
  ]);
  const mine = new Uint8Array(fs.readFileSync(await download.path()));
  assert.equal(rootNodeCount(mine), 2, "the download holds client A's square and box");
  assert.ok(!Buffer.from(mine).equals(Buffer.from(fromB)), "the download is client A's copy, not B's");

  // Opening the newer copy shows B's work, and A's next edit saves on top of it.
  await conflict.getByRole("button", { name: "Open the newer copy: square", exact: true }).click();
  await clientA.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
  await clientA.waitForFunction(() => document.querySelectorAll(".scene-inspector-list > li.scene-row").length === 2, null, { timeout: 15_000 });
  await addBox(clientA);
  const fromA = await nextSave(packagePath, fromB);
  assert.equal(rootNodeCount(fromA), 3, "client A's save keeps B's box and adds its own");
});

test("a server-storage client that comes back into view picks up a newer copy before editing", { timeout: 300_000 }, async (t) => {
  const { clientA, clientB, packagePath, imported } = await twoClients(t);

  await addBox(clientB);
  const fromB = await nextSave(packagePath, imported);

  await clientA.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await clientA.waitForFunction(() => document.querySelectorAll(".scene-inspector-list > li.scene-row").length === 2, null, { timeout: 15_000 });
  await addBox(clientA);
  const fromA = await nextSave(packagePath, fromB);
  assert.equal(rootNodeCount(fromA), 3, "client A edits on top of B's copy");
});

test("a server project whose package is missing or a symlink does not open empty", { timeout: 300_000 }, async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-missing-package-test-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-missing-package-target-"));
  const { baseURL, stop } = await startNextServer({ SKETCHFORGE_PROJECTS_DIR: projectsDir });
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByText("On server", { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 });
    await importFixture(page, "tests/fixtures/svg/square.svg");
    const [{ id: projectId }] = await projectSummary(page);
    const packagePath = path.join(projectsDir, `${projectId}.skf`);
    const stored = await waitForFile(packagePath);

    // An operator moved the package elsewhere and left a symlink, which the server will not follow.
    const target = path.join(outside, "moved.skf");
    fs.writeFileSync(target, stored);
    fs.rmSync(packagePath);
    fs.symlinkSync(target, packagePath);
    await page.reload();

    await page.locator(".project-card-open").first().click();
    const failure = page.getByRole("alert").filter({ hasText: "has no stored package" });
    const editor = page.getByRole("button", { name: "Add shape" });
    await failure.or(editor).first().waitFor({ state: "visible", timeout: 60_000 });
    if (await editor.isVisible()) {
      await addBox(page);
      await page.waitForTimeout(4_000);
    }
    assert.ok(fs.lstatSync(packagePath).isSymbolicLink(), "the symlink is not replaced");
    assertSameBytes(new Uint8Array(fs.readFileSync(target)), stored, "the moved package is unchanged");
    await failure.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Add shape" }).count(), 0, "the editor stays closed");
    assert.equal(await failure.getByRole("button", { name: "Download stored copy" }).count(), 0, "there is nothing to download");
    await screenshot(page, "server-storage-missing-package.png");

    await failure.getByRole("button", { name: "Start over: square", exact: true }).click();
    await page.getByRole("dialog", { name: "Start square over?" }).getByRole("button", { name: "Replace with empty project" }).click();
    await editor.waitFor({ state: "visible", timeout: 60_000 });
    const deadline = Date.now() + 30_000;
    while (fs.lstatSync(packagePath).isSymbolicLink() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(fs.lstatSync(packagePath).isFile(), "a confirmed start over writes a regular package");
    assertSameBytes(new Uint8Array(fs.readFileSync(target)), stored, "the symlink's target is left alone");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
