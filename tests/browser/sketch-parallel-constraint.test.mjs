import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

test("the parallel constraint workflow has an owning task guide", () => {
  const guide = readFileSync("docs/guides/sketch-constraints.md", "utf8");
  assert.match(guide, /select(?:ing)? (?:the )?two (?:sketch )?segments/i);
  assert.match(guide, /Parallel/i);
  assert.match(guide, /(?:aligns? .{0,40}directions?|directions? .{0,40}aligns?)/i);
  assert.match(guide, /offset[\s\S]{0,60}(?:does not|doesn't|not changed|unchanged)|(?:does not|doesn't)[\s\S]{0,60}offset/i);
  assert.match(guide, /npm run test:browser/);
  assert.match(guide, /\.\.\/screenshots\/sketch-parallel-constraint\.png/);
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

test("a user can constrain two selected sketch segments to remain parallel", { timeout: 120_000 }, async () => {
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
    assert.ok(pair, "the rectangle should provide two opposite parallel sides");
    const x = (pair.first.x + pair.second.x) / 2;
    const minY = Math.min(pair.first.y, pair.second.y);
    const maxY = Math.max(pair.first.y, pair.second.y);
    await page.mouse.move(x - 2, minY - 4);
    await page.mouse.down();
    await page.mouse.move(x + 2, maxY + 4);
    await page.mouse.up();

    const selectedSegments = page.locator('[data-sketch-entity="segment"].selected');
    assert.equal(await selectedSegments.count(), 2, "the marquee selects only the opposing side pair");
    const parallelButton = page.getByRole("button", { name: "Parallel", exact: true });
    assert.equal(await parallelButton.isDisabled(), false, "Parallel is available for a two-segment selection");
    await parallelButton.click();
    await page.getByText("Parallel 2 segments", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: "docs/screenshots/sketch-parallel-constraint.png" });
  } finally {
    await browser?.close();
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
});

test("a user can constrain two selected sketch segments to be perpendicular", { timeout: 120_000 }, async () => {
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

    const points = page.locator('[data-sketch-entity="point"]');
    const corners = await points.evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    }));
    assert.equal(corners.length, 4, "the rectangle should have four editable corners");
    const corner = corners[0];
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x + 55, corner.y - 35);
    await page.mouse.up();

    const geometry = await page.locator('[data-sketch-entity="segment"]').evaluateAll((segments) => segments.map((segment) => {
      const start = segment.getPointAtLength(0);
      const end = segment.getPointAtLength(segment.getTotalLength());
      const midpoint = segment.getPointAtLength(segment.getTotalLength() / 2);
      const matrix = segment.getScreenCTM();
      const toScreen = (point) => ({
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f,
      });
      return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, midpoint: toScreen(midpoint) };
    }));
    const pointDistance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
    const selectedCorner = await points.evaluateAll((elements) => {
      const element = elements[0];
      return { x: Number(element.getAttribute("cx")), y: Number(element.getAttribute("cy")) };
    });
    const adjacent = geometry.filter(({ start, end }) => pointDistance(start, selectedCorner) < 0.001 || pointDistance(end, selectedCorner) < 0.001);
    assert.equal(adjacent.length, 2, "the moved corner should join exactly two segments");
    const initialVector = (segment) => ({ x: segment.end.x - segment.start.x, y: segment.end.y - segment.start.y });
    const firstVector = initialVector(adjacent[0]);
    const secondVector = initialVector(adjacent[1]);
    const angleDegrees = (first, second) => Math.acos(Math.min(1, Math.abs((first.x * second.x + first.y * second.y) / (Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y))))) * 180 / Math.PI;
    const initialAngle = angleDegrees(firstVector, secondVector);
    assert.ok(Math.abs(initialAngle - 90) > 5, `dragging one corner should create a visibly non-perpendicular angle; got ${initialAngle}`);

    const selectedMidpoints = adjacent.map(({ midpoint }) => midpoint);
    await page.mouse.move(Math.min(...selectedMidpoints.map(({ x }) => x)) - 3, Math.min(...selectedMidpoints.map(({ y }) => y)) - 3);
    await page.mouse.down();
    await page.mouse.move(Math.max(...selectedMidpoints.map(({ x }) => x)) + 3, Math.max(...selectedMidpoints.map(({ y }) => y)) + 3);
    await page.mouse.up();

    const selectedSegments = page.locator('[data-sketch-entity="segment"].selected');
    assert.equal(await selectedSegments.count(), 2, "the marquee selects the two segments meeting at the moved corner");
    const perpendicularButton = page.getByRole("button", { name: "Perpendicular", exact: true });
    assert.equal(await perpendicularButton.isDisabled(), false, "Perpendicular is available for a two-segment selection");
    await perpendicularButton.click();
    await page.getByText("Perpendicular 2 segments", { exact: true }).waitFor({ state: "visible" });

    const resultVectors = await selectedSegments.evaluateAll((segments) => segments.map((segment) => {
      const start = segment.getPointAtLength(0);
      const end = segment.getPointAtLength(segment.getTotalLength());
      return { x: end.x - start.x, y: end.y - start.y };
    }));
    const resultAngle = angleDegrees(resultVectors[0], resultVectors[1]);
    assert.ok(Math.abs(resultAngle - 90) < 1, `the constrained segments should meet at 90 degrees; got ${resultAngle}`);
    await page.screenshot({ path: "docs/screenshots/sketch-perpendicular-constraint.png" });
  } finally {
    await browser?.close();
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
});
