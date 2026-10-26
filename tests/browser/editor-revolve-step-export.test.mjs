import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  try { process.kill(-server.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    server.once("exit", resolve);
    setTimeout(() => { try { process.kill(-server.pid, "SIGKILL"); } catch {} resolve(); }, 5_000).unref();
  });
}

test("editor STEP export rebuilds a plain revolve and reports success", { timeout: 180_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(), detached: process.platform !== "win32", stdio: "ignore",
  });
  let browser;

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}`);
      try { if ((await fetch(baseURL)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Revolve sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish revolve" }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("radio", { name: /^STEP:/ }).click();

    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/editor/cad")
      && response.request().method() === "POST"
      && JSON.parse(response.request().postData() ?? "{}").format === "step", { timeout: 120_000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name: "Export STEP", exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["x-sketchforge-exported-count"], "1");
    assert.equal(response.headers()["x-sketchforge-skipped-count"], "0");
    const download = await downloadPromise;
    const filePath = await download.path();
    const step = await (await import("node:fs/promises")).readFile(filePath, "utf8");
    assert.match(step, /CYLINDRICAL_SURFACE/);
    await page.getByRole("status").getByText("Exported STEP B-Rep with 1 body", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: "docs/screenshots/editor-step-revolve.png", fullPage: true });
    await context.close();
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
});
