import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

test("the equal-length constraint workflow has an owning task guide", () => {
  const guide = readFileSync("docs/guides/sketch-constraints.md", "utf8");
  assert.match(guide, /select(?:ing)? (?:the )?two (?:sketch )?segments/i);
  assert.match(guide, /Equal length/i);
  assert.match(guide, /equal length/i);
  assert.match(guide, /non-zero-length/i);
  assert.match(guide, /npm run test:browser/);
  assert.match(guide, /\.\.\/screenshots\/sketch-equal-length-constraint\.png/);
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

test("a user can constrain two selected sketch segments to have equal length", { timeout: 120_000 }, async () => {
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
      .find(({ first, second }) => Math.abs(first.x - second.x) < 1 && Math.abs(first.y - second.y) > 20);
    assert.ok(pair, "the rectangle should provide two opposite line segments");
    const x = (pair.first.x + pair.second.x) / 2;
    const minY = Math.min(pair.first.y, pair.second.y);
    const maxY = Math.max(pair.first.y, pair.second.y);
    await page.mouse.move(x - 2, minY - 4);
    await page.mouse.down();
    await page.mouse.move(x + 2, maxY + 4);
    await page.mouse.up();

    const selectedSegments = page.locator('[data-sketch-entity="segment"].selected');
    assert.equal(await selectedSegments.count(), 2, "the marquee selects two opposing line segments");
    const equalLengthButton = page.getByRole("button", { name: "Add equal length", exact: true });
    assert.equal(await equalLengthButton.isDisabled(), false, "Equal length is available for two non-degenerate lines");
    await equalLengthButton.click();
    await page.getByText("Equal length 2 segments", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Added Equal length sketch constraint", { exact: true }).waitFor({ state: "visible" });
    const selectedGeometry = await selectedSegments.evaluateAll((segments) => segments.map((segment) => {
      const matrix = segment.getScreenCTM();
      const start = segment.getPointAtLength(0);
      return { x: matrix.a * start.x + matrix.c * start.y + matrix.e, y: matrix.b * start.x + matrix.d * start.y + matrix.f };
    }));
    const points = await page.locator('[data-sketch-entity="point"]').evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    }));
    const draggedPoint = points.sort((first, second) => Math.hypot(first.x - selectedGeometry[0].x, first.y - selectedGeometry[0].y) - Math.hypot(second.x - selectedGeometry[0].x, second.y - selectedGeometry[0].y))[0];
    await page.mouse.move(draggedPoint.x, draggedPoint.y);
    await page.mouse.down();
    await page.mouse.move(draggedPoint.x + 32, draggedPoint.y + 18);
    await page.mouse.up();
    const lengths = await page.locator('[data-sketch-entity="segment"]').evaluateAll((segments) => segments.map((segment) => segment.getTotalLength()));
    assert.ok(Math.abs(lengths[0] - lengths[2]) < 0.1, `the constrained line lengths should remain equal after dragging; got ${lengths[0]} and ${lengths[2]}`);
    await page.getByText("Equal length 2 segments", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/sketch-equal-length-constraint.png" });
  } finally {
    await browser?.close();
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
});
