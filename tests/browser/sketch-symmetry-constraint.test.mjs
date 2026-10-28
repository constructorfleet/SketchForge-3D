import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

test("the symmetry constraint workflow has an owning task guide", () => {
  const guide = readFileSync("docs/guides/sketch-constraints.md", "utf8");
  assert.match(guide, /Make two points symmetric/i);
  assert.match(guide, /Mirror axis/i);
  assert.match(guide, /\.\.\/screenshots\/sketch-symmetry-constraint\.png/);
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

test("a user can mirror two selected sketch points about a segment", { timeout: 120_000 }, async () => {
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
    await page.getByRole("button", { name: "Line", exact: true }).click();

    const plate = page.locator(".sketch-plate-wrap svg");
    const bounds = await plate.boundingBox();
    assert.ok(bounds, "the sketch plate should be visible");
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const drawLine = async (fromX, fromY, toX, toY) => {
      await page.mouse.click(centerX + fromX, centerY + fromY);
      await page.mouse.click(centerX + toX, centerY + toY);
    };
    await drawLine(-160, 90, 160, 90);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: "Line", exact: true }).click();
    await drawLine(-40, -70, 30, 40);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    assert.equal(await page.locator('[data-sketch-entity="segment"]').count(), 2, "two lines were drawn");

    const mirror = page.locator('[data-sketch-entity="segment"]').nth(1);
    const mirrorBounds = await mirror.boundingBox();
    assert.ok(mirrorBounds, "the mirror pair line should be visible");
    await page.mouse.move(mirrorBounds.x - 5, mirrorBounds.y - 5);
    await page.mouse.down();
    await page.mouse.move(mirrorBounds.x + mirrorBounds.width + 5, mirrorBounds.y + mirrorBounds.height + 5);
    await page.mouse.up();

    assert.equal(await page.locator('[data-sketch-entity="segment"].selected').count(), 1, "the marquee selects the mirror pair line");
    const symmetryButton = page.getByRole("button", { name: "Symmetry", exact: true });
    assert.equal(await symmetryButton.isDisabled(), false, "Symmetry is available for two points and a non-degenerate axis");
    await symmetryButton.click();
    await page.locator(".sketch-constraint-list").getByText(/^Symmetry /).waitFor({ state: "visible" });
    await page.getByText("Added Symmetry sketch constraint", { exact: true }).waitFor({ state: "visible" });
    await page.locator(".sketch-constraint-list").getByText(/^Symmetry /).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/sketch-symmetry-constraint.png" });
  } finally {
    await browser?.close();
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
});
