import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

// The screenshot is evidence for review, not documentation, so it goes to the
// automation output rather than docs/screenshots.
const SCREENSHOT_DIR = "output/playwright";

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(url, server, getLogs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${getLogs()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js did not become ready:\n${getLogs()}`);
}

test("editor shortcuts stay inert while the Workspace Settings modal is open", { timeout: 120_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  let browser;

  try {
    await waitForServer(baseURL, server, () => logs);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();

    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Extrude sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish sketch" }).click();
    await page.getByRole("status").getByText("Exact sketch created at 10 mm height", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    const sceneRows = page.locator(".scene-inspector-list > li.scene-row");
    const selectedRows = page.locator(".scene-inspector-list > li.scene-row.selected");
    const holeTags = page.locator(".scene-inspector-list .scene-row-tag");
    await sceneRows.first().waitFor({ state: "visible", timeout: 30_000 });
    const shapeCount = await sceneRows.count();
    assert.ok(shapeCount > 0, "the extrusion should appear in the scene list");
    assert.equal(await selectedRows.count(), 1, "the new extrusion should be selected");
    assert.equal(await holeTags.count(), 0, "the new extrusion should be solid");

    await page.getByRole("button", { name: "Workspace settings" }).click();
    const settings = page.getByRole("dialog", { name: "Workspace settings" });
    await settings.waitFor({ state: "visible" });
    // Focus a non-input control inside the modal, as a keyboard user would.
    await settings.getByRole("button", { name: "Appearance" }).focus();

    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    await page.keyboard.press("h");
    await page.waitForTimeout(200);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/editor-modal-shortcuts.png` });

    assert.equal(await sceneRows.count(), shapeCount, "Backspace and Delete must not delete the selection under the modal");
    assert.equal(await selectedRows.count(), 1, "the selection should survive the modal");
    assert.equal(await holeTags.count(), 0, "h must not turn the selection into a hole under the modal");

    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden", timeout: 5_000 });
    assert.equal(await selectedRows.count(), 1, "Escape closes the modal without also clearing the selection");

    // With the modal closed the same key reaches the editor, which proves the
    // keypresses above were delivered and suppressed rather than lost.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("Backspace");
    await page.waitForFunction(
      (count) => document.querySelectorAll(".scene-inspector-list > li.scene-row").length < count,
      shapeCount,
      { timeout: 5_000 },
    );
  } finally {
    await browser?.close();
    if (server.pid) {
      if (process.platform === "win32") server.kill("SIGTERM");
      else {
        try { process.kill(-server.pid, "SIGTERM"); } catch { /* The server already exited. */ }
      }
      if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
});
