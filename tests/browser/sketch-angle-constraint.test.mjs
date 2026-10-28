import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

test("the angle constraint workflow has an owning task guide", () => {
  const guide = readFileSync("docs/guides/sketch-constraints.md", "utf8");
  assert.match(guide, /Set the angle between two segments/i);
  assert.match(guide, /Set angle/i);
  assert.match(guide, /0° to 180°/i);
  assert.match(guide, /\.\.\/screenshots\/sketch-angle-constraint\.png/);
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

test("a user can set the angle between two selected sketch segments", { timeout: 120_000 }, async () => {
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

    const centers = await page.locator('[data-sketch-entity="segment"]').evaluateAll((segments) => segments.map((segment) => {
      const bounds = segment.getBBox();
      const matrix = segment.getScreenCTM();
      const localX = bounds.x + bounds.width / 2;
      const localY = bounds.y + bounds.height / 2;
      return {
        x: matrix.a * localX + matrix.c * localY + matrix.e,
        y: matrix.b * localX + matrix.d * localY + matrix.f,
      };
    }));
    const pair = centers.flatMap((first, firstIndex) => centers.slice(firstIndex + 1).map((second) => ({ first, second })))
      .sort((left, right) => Math.hypot(left.first.x - left.second.x, left.first.y - left.second.y)
        - Math.hypot(right.first.x - right.second.x, right.first.y - right.second.y))[0];
    assert.ok(pair, "the rectangle should provide two adjoining line segments");
    const minX = Math.min(pair.first.x, pair.second.x) - 4;
    const maxX = Math.max(pair.first.x, pair.second.x) + 4;
    const minY = Math.min(pair.first.y, pair.second.y) - 4;
    const maxY = Math.max(pair.first.y, pair.second.y) + 4;
    await page.mouse.move(minX, minY);
    await page.mouse.down();
    await page.mouse.move(maxX, maxY);
    await page.mouse.up();

    const selectedSegments = page.locator('[data-sketch-entity="segment"].selected');
    assert.equal(await selectedSegments.count(), 2, "the marquee selects two adjoining line segments");
    const angleInput = page.getByRole("spinbutton", { name: "Angle (°)" });
    await angleInput.fill("45");
    const setAngle = page.getByRole("button", { name: "Set angle", exact: true });
    assert.equal(await setAngle.isDisabled(), false, "Set angle is available for two non-degenerate lines");
    await setAngle.click();
    await page.getByText("Angle 45° 2 segments", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Added Angle sketch constraint", { exact: true }).waitFor({ state: "visible" });

    const draggedPoint = page.locator('[data-sketch-entity="point"]').first();
    const bounds = await draggedPoint.boundingBox();
    assert.ok(bounds, "the sketch should expose a draggable point");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2 + 12);
    await page.mouse.up();
    await page.getByText("Angle 45° 2 segments", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Angle 45° 2 segments", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/sketch-angle-constraint.png" });
  } finally {
    await browser?.close();
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
});
