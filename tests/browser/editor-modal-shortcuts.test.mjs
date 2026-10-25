import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";
import { chromium } from "playwright";

// The screenshot is evidence for review, not documentation, so it goes to the
// automation output rather than docs/screenshots.
const SCREENSHOT_DIR = "output/playwright";
const require = createRequire(import.meta.url);

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

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
    assert.equal(await settings.getAttribute("aria-modal"), "true");
    assert.equal(await settings.evaluate((dialog) => dialog.contains(document.activeElement)), true, "opening Settings should move focus into the dialog");
    assert.equal(await settings.getByRole("button", { name: "Appearance" }).evaluate((element) => element === document.activeElement), true, "Settings should initially focus its first section control");
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const settingsAxe = await page.evaluate(async () => window.axe.run(document.querySelector('[role="dialog"][aria-label="Workspace settings"]'), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    }));
    assert.deepEqual(settingsAxe.violations, [], `Settings dialog axe violations: ${JSON.stringify(settingsAxe.violations)}`);
    fs.mkdirSync("docs/screenshots", { recursive: true });
    await page.screenshot({ path: "docs/screenshots/editor-dialog-settings-focus.png", fullPage: true });
    const settingsFocusables = settings.locator(FOCUSABLE).filter({ visible: true });
    const settingsFirst = settingsFocusables.first();
    const settingsLast = settingsFocusables.last();
    await settingsLast.focus();
    await page.keyboard.press("Tab");
    assert.equal(await settingsFirst.evaluate((element) => element === document.activeElement), true, "Tab from the last Settings control should wrap to the first");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await settingsLast.evaluate((element) => element === document.activeElement), true, "Shift+Tab from the first Settings control should wrap to the last");
    await settings.getByRole("button", { name: "Workplane" }).click();
    const gridColorTrigger = settings.getByRole("button", { name: /Grid color/ });
    await gridColorTrigger.click();
    const colorPicker = page.getByRole("group", { name: "Grid color picker" });
    await colorPicker.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await colorPicker.waitFor({ state: "hidden" });
    assert.equal(await settings.isVisible(), true, "Escape inside the color picker should not close Settings");
    assert.equal(await gridColorTrigger.evaluate((element) => element === document.activeElement), true, "closing the color picker should return focus to its trigger");

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
    assert.equal(await page.getByRole("button", { name: "Workspace settings" }).evaluate((element) => element === document.activeElement), true, "closing Settings should return focus to its trigger");
    assert.equal(await selectedRows.count(), 1, "Escape closes the modal without also clearing the selection");

    await page.keyboard.press("?");
    const shortcutHelp = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await shortcutHelp.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await shortcutHelp.getByText("Shift+L", { exact: true }).isVisible(), true);
    assert.equal(await shortcutHelp.getByText("Shift+H", { exact: true }).isVisible(), true);
    assert.equal(await shortcutHelp.evaluate((dialog) => dialog.contains(document.activeElement)), true, "opening the shortcut list should move focus into it");
    const shortcutAxe = await page.evaluate(async () => window.axe.run(document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]'), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    }));
    assert.deepEqual(shortcutAxe.violations, [], `shortcut dialog axe violations: ${JSON.stringify(shortcutAxe.violations)}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/editor-keyboard-shortcuts.png` });
    await page.keyboard.press("Escape");
    await shortcutHelp.waitFor({ state: "hidden" });

    await page.keyboard.press("Shift+L");
    await page.getByRole("status").getByText("Selection locked", { exact: true }).waitFor({ state: "visible" });
    await page.keyboard.press("Shift+L");
    await page.getByRole("status").getByText("Selection unlocked", { exact: true }).waitFor({ state: "visible" });
    await page.keyboard.press("Shift+H");
    await page.getByRole("status").getByText("Selection hidden", { exact: true }).waitFor({ state: "visible" });
    await page.keyboard.press("Alt+Shift+H");
    await page.getByRole("status").getByText("Showed 1 hidden shape", { exact: true }).waitFor({ state: "visible" });

    const exportTrigger = page.getByRole("button", { name: "Export", exact: true });
    await exportTrigger.click();
    const exportDialog = page.getByRole("dialog", { name: "Export" });
    await exportDialog.waitFor({ state: "visible" });
    assert.equal(await exportDialog.getAttribute("aria-modal"), "true");
    assert.equal(await exportDialog.evaluate((dialog) => dialog.contains(document.activeElement)), true, "opening Export should move focus into the dialog");
    assert.equal(await exportDialog.getByLabel("File name").evaluate((element) => element === document.activeElement), true, "Export should initially focus the file name field");
    const exportAxe = await page.evaluate(async () => window.axe.run(document.querySelector('[role="dialog"][aria-label="Export"]'), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    }));
    assert.deepEqual(exportAxe.violations, [], `Export dialog axe violations: ${JSON.stringify(exportAxe.violations)}`);
    await page.screenshot({ path: "docs/screenshots/editor-dialog-export-focus.png", fullPage: true });
    const exportFocusables = exportDialog.locator(FOCUSABLE).filter({ visible: true });
    const exportFirst = exportFocusables.first();
    const exportLast = exportFocusables.last();
    await exportLast.focus();
    await page.keyboard.press("Tab");
    assert.equal(await exportFirst.evaluate((element) => element === document.activeElement), true, "Tab from the last Export control should wrap to the first");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await exportLast.evaluate((element) => element === document.activeElement), true, "Shift+Tab from the first Export control should wrap to the last");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await exportDialog.waitFor({ state: "hidden", timeout: 5_000 });
    assert.equal(await exportTrigger.evaluate((element) => element === document.activeElement), true, "closing Export should return focus to its trigger");

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
