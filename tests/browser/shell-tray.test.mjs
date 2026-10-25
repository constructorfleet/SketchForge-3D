import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
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

function startServer(port) {
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  return { server, logs: () => logs };
}

async function stopServer(server) {
  if (!server.pid) return;
  if (process.platform === "win32") server.kill("SIGTERM");
  else {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* The server already exited. */ }
  }
  if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** The inspector's size readouts, in mm, for the selected shape. */
async function size(page) {
  const values = await page.locator('input[type="text"]').evaluateAll((inputs) => Object.fromEntries(inputs.flatMap((input) => {
    const label = (input.labels?.[0]?.innerText ?? "").replace(/\s+/g, " ").trim();
    const match = /^(Length|Width|Height) mm$/.exec(label);
    return match ? [[match[1], Number(input.value)]] : [];
  })));
  return { length: values.Length, width: values.Width, height: values.Height };
}

/** The material card's volume readout, in cm3. */
async function volume(page) {
  const text = await page.locator(".exact-properties .material-readout div").filter({ hasText: "Volume" }).locator("dd").innerText();
  const value = Number.parseFloat(text.replace(",", "."));
  assert.ok(Number.isFinite(value), `the exact CAD volume readout should be a number: ${text}`);
  return value / 1000;
}

/** Poll the volume until `check` holds, so a commit has landed before it is judged. */
async function volumeWhen(page, check, message) {
  const deadline = Date.now() + 15_000;
  let last;
  while (Date.now() < deadline) {
    last = await volume(page).catch(() => undefined);
    if (last !== undefined && check(last)) return last;
    await page.waitForTimeout(200);
  }
  assert.fail(`${message}: ${last}`);
}

const near = (left, right) => Math.abs(left - right) <= 0.011;

test("a box is hollowed into a tray from the inspector, undone, redone, and kept through .skf", { timeout: 240_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const { server, logs } = startServer(port);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-shell-"));
  let browser;

  try {
    await waitForServer(baseURL, server, logs);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    // A newer upstream release can open a blocking modal on the second visit
    // to the dashboard; this workflow is about the shell, not release discovery.
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await page.getByRole("button", { name: "Add shape" }).click();
    await page.getByText("Box", { exact: true }).first().click();

    const status = page.getByRole("status");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });

    // A material makes the inspector weigh the shape, which is the measure here:
    // a hollow and the solid it came from have the same outside dimensions.
    await page.getByRole("button", { name: "Material", exact: true }).click();
    await page.getByLabel("Shape material").selectOption({ index: 1 });
    const outside = await size(page);
    const solid = await volumeWhen(page, (value) => value > 0, "a solid box should have a volume");
    assert.ok(near(solid, outside.length * outside.width * outside.height / 1000), `the solid box weighs its dimensions: ${solid}`);

    const shell = page.getByRole("region", { name: "Shell" });
    await shell.getByRole("button", { name: "Shell", exact: true }).click();
    const thickness = shell.getByLabel(/Wall thickness/);
    const apply = shell.getByRole("button", { name: "Hollow shape" });

    // Too thick a wall is refused in words, and the box is left alone.
    await thickness.fill(String(Math.min(outside.length, outside.width, outside.height)));
    await apply.click();
    await status.getByText("That wall is too thick for this shape", { exact: false }).waitFor({ state: "visible", timeout: 60_000 });
    assert.ok(near(await volume(page), solid), "a refused shell must not change the box");

    // A 2 mm wall with the top left open: a tray.
    await thickness.fill("2");
    await shell.getByRole("checkbox", { name: "Top" }).check();
    await apply.click();
    await status.getByText("Shape hollowed", { exact: false }).waitFor({ state: "visible", timeout: 60_000 });
    const expected = (outside.length * outside.width * outside.height
      - (outside.length - 4) * (outside.width - 4) * (outside.height - 2)) / 1000;
    const tray = await volumeWhen(page, (value) => value < solid, "hollowing should take material away");
    assert.ok(near(tray, expected), `the tray weighs a 2 mm wall with the top open: ${tray}, expected ${expected}`);
    const traySize = await size(page);
    assert.ok(near(traySize.length, outside.length) && near(traySize.width, outside.width) && near(traySize.height, outside.height),
      `the wall is measured inwards, so the outside keeps its size: ${JSON.stringify([traySize, outside])}`);
    await shell.getByText("Hollowed to a 2 mm wall.", { exact: true }).waitFor({ state: "visible" });
    await shell.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/shell-tray.png" });

    // Undo puts the solid back; redo the tray.
    await undo.click();
    await volumeWhen(page, (value) => near(value, solid), "undo should restore the solid box");
    await redo.click();
    await volumeWhen(page, (value) => near(value, tray), "redo should restore the tray");

    // Through .skf and back.
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("radio", { name: "SKF: Editable project" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save SketchForge Project" }).click();
    const download = await downloadPromise;
    const packagePath = path.join(tempDir, "tray.skf");
    await download.saveAs(packagePath);

    await page.goto(baseURL);
    await page.getByRole("button", { name: "Open SKF or import geometry" }).click();
    await page.locator('input[type="file"][accept*=".skf"]').setInputFiles(packagePath);
    await page.getByRole("button", { name: "Box", exact: true }).click({ timeout: 120_000 });
    const reopened = page.getByRole("region", { name: "Shell" });
    await reopened.getByRole("button", { name: "Shell", exact: true }).click();
    await reopened.getByText("Hollowed to a 2 mm wall.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    if (await page.locator(".material-readout").count() === 0) await page.getByRole("button", { name: "Material", exact: true }).click();
    await volumeWhen(page, (value) => near(value, tray), "the reopened project should hold the tray");
    await context.close();
  } finally {
    await browser?.close();
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
