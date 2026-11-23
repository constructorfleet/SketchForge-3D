import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { chromium } from "playwright";

// Issue #622: a project whose stored package cannot be read must not open as an
// empty editor that autosaves over it. Set SKETCHFORGE_SCREENSHOT_DIR to keep screenshots.
const SCREENSHOT_DIR = process.env.SKETCHFORGE_SCREENSHOT_DIR;
const BROKEN_KIND = "no-such-shape";

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
function corruptPackage(bytes) {
  const files = unzipSync(bytes);
  const document = JSON.parse(strFromU8(files["project.json"]));
  let corrupted = false;
  const visit = (value) => {
    if (corrupted || !value || typeof value !== "object") return;
    if (!Array.isArray(value) && typeof value.kind === "string" && typeof value.color === "string" && typeof value.name === "string") {
      value.kind = BROKEN_KIND;
      corrupted = true;
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(document);
  assert.ok(corrupted, "the stored package has a shape definition to corrupt");
  files["project.json"] = strToU8(JSON.stringify(document));
  return zipSync(files);
}

async function readIndexedDbPackage(page, projectId) {
  const values = await page.evaluate((id) => new Promise((resolve, reject) => {
    const open = indexedDB.open("sketchForge.projectShapes");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("projectShapes", "readonly").objectStore("projectShapes").get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        database.close();
        const record = request.result;
        resolve(record?.skfPackage ? { revision: record.revision, bytes: Array.from(new Uint8Array(record.skfPackage)) } : null);
      };
    };
  }), projectId);
  return values ? { revision: values.revision, bytes: Uint8Array.from(values.bytes) } : null;
}

async function writeIndexedDbPackage(page, projectId, revision, bytes) {
  await page.evaluate(({ id, revision, bytes }) => new Promise((resolve, reject) => {
    const open = indexedDB.open("sketchForge.projectShapes");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("projectShapes", "readwrite");
      transaction.objectStore("projectShapes").put({ id, revision, skfPackage: Uint8Array.from(bytes), updatedAt: Date.now() });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), { id: projectId, revision, bytes: Array.from(bytes) });
}

/**
 * Opens the broken project and, if any editor appears, edits it and waits long
 * enough for autosave to have written.
 */
async function openAndTryToEdit(page, open) {
  await open();
  const failure = page.getByRole("alert").filter({ hasText: "could not be read" });
  const editor = page.getByRole("button", { name: "Add shape" });
  await failure.or(editor).first().waitFor({ state: "visible", timeout: 60_000 });
  if (await editor.isVisible()) {
    await editor.click();
    await page.getByText("Box", { exact: true }).first().click();
    await page.waitForTimeout(4_000);
  }
  return failure;
}

test("browser storage keeps an unreadable project's stored package and offers retry, download, and start over", { timeout: 300_000 }, async () => {
  const { baseURL, stop } = await startNextServer();
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(baseURL);
    await importFixture(page, "tests/fixtures/svg/square.svg");
    await importFixture(page, "tests/fixtures/obj/triangle.obj");
    const summary = await projectSummary(page);
    assert.equal(summary.length, 2, "both imports created a project");
    // Newer projects come first, so the first import is last.
    const projectId = summary[1].id;
    const brokenName = "square";

    const stored = await readIndexedDbPackage(page, projectId);
    assert.ok(stored, "the imported project has a stored package");
    const corrupt = corruptPackage(stored.bytes);
    await writeIndexedDbPackage(page, projectId, stored.revision, corrupt);
    await page.reload();

    const card = page.locator(".project-card").filter({ hasText: brokenName });
    const failure = await openAndTryToEdit(page, () => card.locator(".project-card-open").click());
    assertSameBytes((await readIndexedDbPackage(page, projectId))?.bytes, corrupt, "the stored package is unchanged after opening it");
    await failure.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Add shape" }).count(), 0, "the editor stays closed");
    await failure.getByText(BROKEN_KIND, { exact: false }).waitFor({ state: "visible" });
    await screenshot(page, "project-load-failure.png");

    // A reload straight into the editor takes the same path.
    await openAndTryToEdit(page, () => page.goto(`${baseURL}/?editor=1&project=${encodeURIComponent(projectId)}`));
    await failure.waitFor({ state: "visible" });
    assertSameBytes((await readIndexedDbPackage(page, projectId))?.bytes, corrupt, "a direct editor link leaves it unchanged too");

    // Retrying reads it again and fails again.
    await openAndTryToEdit(page, () => failure.getByRole("button", { name: "Try again" }).click());
    await failure.waitFor({ state: "visible" });

    // The stored bytes download as they are, for repair.
    const [download] = await Promise.all([page.waitForEvent("download"), failure.getByRole("button", { name: "Download stored copy" }).click()]);
    assert.equal(download.suggestedFilename(), `${brokenName}.skf`);
    assertSameBytes(new Uint8Array(fs.readFileSync(await download.path())), corrupt, "the download is the stored package byte for byte");

    // The backup includes what it can and names what it skipped.
    await page.locator(".dashboard-actions-band").getByRole("button", { name: "Export all projects" }).click();
    await page.getByRole("status").filter({ hasText: `Could not include: ${brokenName}.` }).waitFor({ state: "visible" });
    assertSameBytes((await readIndexedDbPackage(page, projectId))?.bytes, corrupt, "exporting all projects leaves it unchanged");

    // Start over asks first; cancelling changes nothing.
    await failure.getByRole("button", { name: "Start over" }).click();
    const dialog = page.getByRole("dialog", { name: `Start ${brokenName} over?` });
    await dialog.waitFor({ state: "visible" });
    await screenshot(page, "project-load-failure-start-over.png");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assertSameBytes((await readIndexedDbPackage(page, projectId))?.bytes, corrupt, "cancelling start over leaves it unchanged");

    await failure.getByRole("button", { name: "Start over" }).click();
    await dialog.getByRole("button", { name: "Replace with empty project" }).click();
    await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
    const replaced = await readIndexedDbPackage(page, projectId);
    assert.ok(!Buffer.from(replaced.bytes).equals(Buffer.from(corrupt)), "confirming start over replaces the stored package");
    assert.ok(!strFromU8(unzipSync(replaced.bytes)["project.json"]).includes(BROKEN_KIND), "the replacement is readable");
  } finally {
    if (browser) await browser.close();
    stop();
  }
});

test("server storage keeps an unreadable project's package file untouched", { timeout: 300_000 }, async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-load-failure-test-"));
  const { baseURL, stop } = await startNextServer({ SKETCHFORGE_PROJECTS_DIR: projectsDir });
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByText("On server", { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 });
    await importFixture(page, "tests/fixtures/svg/square.svg");
    const [{ id: projectId }] = await projectSummary(page);
    const packagePath = path.join(projectsDir, `${projectId}.skf`);
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(packagePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const corrupt = corruptPackage(new Uint8Array(fs.readFileSync(packagePath)));
    fs.writeFileSync(packagePath, corrupt);
    await page.reload();

    const failure = await openAndTryToEdit(page, () => page.locator(".project-card-open").first().click());
    assertSameBytes(new Uint8Array(fs.readFileSync(packagePath)), corrupt, "the server package file is unchanged");
    await failure.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Add shape" }).count(), 0, "the editor stays closed");

    const [download] = await Promise.all([page.waitForEvent("download"), failure.getByRole("button", { name: "Download stored copy" }).click()]);
    assertSameBytes(new Uint8Array(fs.readFileSync(await download.path())), corrupt, "the download is the server's package byte for byte");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
