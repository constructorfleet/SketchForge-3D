import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

async function waitForServer(url, server, getLogs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${getLogs()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js did not become ready:\n${getLogs()}`);
}

test("a new user can sketch, extrude, save, and export a model", { timeout: 120_000 }, async () => {
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
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();

    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Extrude sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish sketch" }).click();
    await page.getByRole("status").getByText("Exact sketch created at 10 mm height", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("Sketch extrusion").first().waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "Edit sketch", exact: true }).click();
    await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: "docs/screenshots/parametric-extrusion-edit-sketch.png" });
    await page.getByRole("button", { name: "Finish sketch", exact: true }).click();
    await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
    await page.screenshot({ path: "docs/screenshots/parametric-extrusion-rebuilt-solid.png" });

    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Revolve sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish revolve" }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Edit sketch", exact: true }).click();
    await page.getByRole("button", { name: "Finish revolve", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: "docs/screenshots/parametric-revolve-edit-sketch.png" });
    await page.getByRole("button", { name: "Finish revolve", exact: true }).click();
    await page.getByRole("button", { name: "Finish revolve", exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: "docs/screenshots/parametric-revolve-rebuilt-solid.png" });

    const projectName = page.getByRole("textbox", { name: "Project name" });
    await projectName.fill("Quick-start block");
    await projectName.press("Enter");
    const reloadResponse = await page.reload();
    assert.equal(reloadResponse?.status(), 200, "Reloading the saved project should return a successful editor page");
    await page.getByText("Sketch extrusion").first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByRole("textbox", { name: "Project name" }).inputValue(), "Quick-start block");

    await page.getByRole("button", { name: "Sketch extrusion", exact: true }).click();
    await page.getByRole("button", { name: "Center view on selection" }).click();
    await page.mouse.click(160, 170);
    await page.screenshot({ path: "docs/screenshots/editor-quickstart-solid.png" });

    await page.getByRole("button", { name: "Export" }).click();
    const skfFormat = page.getByRole("radio", { name: "SKF: Editable project" });
    await skfFormat.click();
    assert.equal(await skfFormat.getAttribute("aria-checked"), "true");
    await page.waitForTimeout(200);
    await page.screenshot({ path: "docs/screenshots/editor-quickstart-export.png" });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save SketchForge Project" }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.skf$/);
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server.pid) {
      if (process.platform === "win32") server.kill("SIGTERM");
      else {
        try { process.kill(-server.pid, "SIGTERM"); } catch { /* The server already exited. */ }
      }
      if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
});
