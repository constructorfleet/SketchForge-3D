import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

test("the radius and diameter workflow has an owning task guide", () => {
  const guide = readFileSync("docs/guides/sketch-constraints.md", "utf8");
  assert.match(guide, /Set a radius or diameter/i);
  assert.match(guide, /Radius \(mm\)/i);
  assert.match(guide, /Diameter \(mm\)/i);
  assert.match(guide, /\.\.\/screenshots\/sketch-radius-diameter-constraint\.png/);
});

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

test("a user can size two opposite sketch points with a diameter", { timeout: 120_000 }, async () => {
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
    await page.getByRole("button", { name: "Edit sketch", exact: true }).click();
    await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "visible" });

    const side = page.locator('[data-sketch-entity="segment"]').first();
    const bounds = await side.boundingBox();
    assert.ok(bounds, "the rectangle should provide a selectable side");
    await page.mouse.move(bounds.x - 6, bounds.y - 6);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width + 6, bounds.y + bounds.height + 6);
    await page.mouse.up();

    assert.equal(await page.locator('[data-sketch-entity="point"].selected').count(), 2, "the marquee selects the side's two endpoints");
    await page.getByRole("spinbutton", { name: "Diameter (mm)" }).fill("30");
    const diameterButton = page.getByRole("button", { name: "Diameter", exact: true });
    assert.equal(await diameterButton.isDisabled(), false, "Diameter is available for two selected points");
    await diameterButton.click();
    await page.locator(".sketch-constraint-list").getByText(/^Diameter 30 mm /).waitFor({ state: "visible" });
    await page.getByText("Added Diameter sketch constraint", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".sketch-constraint-list").getByText(/^Diameter 30 mm /).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/sketch-radius-diameter-constraint.png" });
  } finally {
    await browser?.close();
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
});
