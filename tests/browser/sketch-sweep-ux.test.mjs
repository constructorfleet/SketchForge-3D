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
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/**
 * The sweep workflow used to jump the first spine point to the plane origin
 * with no marker, gave no 3D feedback until Finish, and left Finish enabled
 * when the profile could not be swept. This drives the whole flow in the
 * editor and checks each of those.
 */
test("a sweep sketch marks its start, previews in 3D, and only finishes when ready", { timeout: 240_000 }, async () => {
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
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(baseURL)).ok) break;
      } catch {
        // The production server is still starting.
      }
      if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Sweep sketch/ }).click();

    const guide = page.locator(".sketch-sweep-guide");
    await guide.waitFor({ state: "visible" });
    assert.equal(await guide.getAttribute("data-sweep-status"), "section");
    assert.equal(await page.getByRole("button", { name: "Finish sweep" }).isDisabled(), true, "nothing drawn yet");
    await page.getByText("Draw and close a section loop.", { exact: true }).waitFor({ state: "visible" });

    // A closed primitive advances to the spine and places the pinned start at
    // the origin, instead of waiting for a first click to teleport there.
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.waitForFunction(() => document.querySelector(".sketch-sweep-guide")?.getAttribute("data-sweep-status") === "spine");
    assert.equal(await page.getByRole("button", { name: "Finish sweep" }).isDisabled(), true, "a section alone cannot finish a sweep");

    const marker = page.locator('[data-sweep-start="origin"] circle');
    await marker.waitFor({ state: "visible" });
    const startPoint = page.locator('[data-sketch-entity="point"][data-sweep-start="true"]');
    await startPoint.waitFor({ state: "visible" });

    const plateBox = await page.locator("svg.sketch-plate").boundingBox();
    assert.ok(plateBox, "the sketch plate is on screen");
    const origin = { x: plateBox.x + plateBox.width / 2, y: plateBox.y + plateBox.height / 2 };
    const startBox = await startPoint.boundingBox();
    assert.ok(startBox, "the start point is on screen");
    assert.ok(Math.abs((startBox.x + startBox.width / 2) - origin.x) < 2, "the start point sits at the plane origin");
    assert.ok(Math.abs((startBox.y + startBox.height / 2) - origin.y) < 2, "the start point sits at the plane origin");

    // The start is pinned: dragging it keeps it on the origin and explains why.
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    await page.mouse.move(origin.x + 70, origin.y + 35);
    await page.mouse.up();
    await page.getByText("The sweep starts at the section origin, so that point stays put", { exact: true }).waitFor({ state: "visible" });
    const afterDrag = await startPoint.boundingBox();
    assert.ok(afterDrag, "the start point is still on screen");
    assert.ok(Math.abs((afterDrag.x + afterDrag.width / 2) - origin.x) < 2, "the start did not move");

    // Draw one spine segment to the right. The first segment snaps to
    // screen-right, so the section stays perpendicular to it.
    await page.getByRole("button", { name: "Line", exact: true }).click();
    await page.mouse.click(origin.x, origin.y);
    await page.mouse.click(origin.x + 220, origin.y);
    await page.waitForFunction(() => document.querySelector(".sketch-sweep-guide")?.getAttribute("data-sweep-status") === "ready");
    assert.equal(await page.getByRole("button", { name: "Finish sweep" }).isDisabled(), false, "a section and one spine can finish");
    await page.getByText("Ready to finish the sweep.", { exact: true }).waitFor({ state: "visible" });

    // The 3D inset renders the swept solid before the sketch is finished.
    const preview = page.locator('aside[aria-label="Sweep 3D preview"] canvas');
    await preview.waitFor({ state: "visible", timeout: 60_000 });
    await page.screenshot({ path: "docs/screenshots/sketch-sweep-ux.png" });

    await page.getByRole("button", { name: "Finish sweep" }).click();
    await page.getByRole("status").getByText("Planar sweep created", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      try {
        if (process.platform === "win32") server.kill("SIGTERM");
        else process.kill(-server.pid, "SIGTERM");
      } catch {
        // The server already exited.
      }
    }
  }
});
