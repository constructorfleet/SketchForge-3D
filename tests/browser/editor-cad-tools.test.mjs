import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("measure two boxes exactly 10 mm apart and expose kernel drawing exports", { timeout: 180_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  let browser;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(baseURL)).ok) break; } catch { /* server starting */ }
      if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    const addBox = async () => {
      await page.getByRole("button", { name: "Add shape" }).click();
      await page.getByText("Box", { exact: true }).first().click();
    };
    const setInput = async (label, value) => {
      const input = page.locator("label").filter({ hasText: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(" ", "\\s*") ) }).locator("input").first();
      await input.fill(String(value));
      await input.press("Enter");
    };
    await addBox();
    await setInput("Width mm", 10);
    const rows = page.locator(".scene-inspector-list > li.scene-row");
    await rows.first().waitFor({ state: "visible" });
    await addBox();
    await setInput("Width mm", 10);
    await setInput("X mm", 20);
    await rows.nth(1).locator(".scene-row-name").evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await rows.first().locator(".scene-row-name").evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    assert.equal(await page.locator(".scene-inspector-list > li.scene-row.selected").count(), 2, "shift selecting the first box keeps the second selected");
    await page.getByRole("button", { name: "Measure selected shapes" }).click();
    const dialog = page.getByRole("dialog", { name: "Measure 3D entities" });
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Measure distance and angle" }).click();
    await page.getByRole("status").getByText(/Exact distance: 10\.00 mm/).waitFor({ state: "visible", timeout: 30_000 });
    fs.mkdirSync("docs/screenshots", { recursive: true });
    await page.screenshot({ path: "docs/screenshots/editor-cad-measurement.png", fullPage: true });
    await rows.nth(1).locator(".scene-row-name").evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await page.getByRole("button", { name: "Material" }).click({ force: true });
    const exactProperties = page.locator(".exact-properties");
    await exactProperties.waitFor({ state: "visible", timeout: 30_000 });
    await exactProperties.getByText("Exact B-rep").waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: "docs/screenshots/editor-cad-properties.png", fullPage: true });
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("radio", { name: /DXF/ }).waitFor({ state: "visible" });
    await page.getByRole("radio", { name: /SVG/ }).click();
    await page.getByLabel("Hidden-line (kernel)").check();
    fs.mkdirSync("output/playwright", { recursive: true });
    await page.screenshot({ path: "output/playwright/editor-cad-tools.png", fullPage: true });
    await page.screenshot({ path: "docs/screenshots/editor-cad-tools.png", fullPage: true });
    const dxfRadio = page.getByRole("radio", { name: /DXF/ });
    await dxfRadio.click();
    await page.waitForFunction(() => document.querySelector('.export-format-slider button[aria-label^="DXF"]')?.getAttribute("aria-checked") === "true");
    await page.waitForTimeout(200);
    await page.screenshot({ path: "docs/screenshots/editor-cad-dxf.png", fullPage: true });
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      try { if (process.platform === "win32") server.kill("SIGTERM"); else process.kill(-server.pid, "SIGTERM"); } catch { /* server already exited */ }
    }
  }
});
