import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

let server;
let browser;
let page;
let logs = "";
let projectsDir;
let baseURL;

before(async () => {
  const port = await unusedPort();
  baseURL = `http://127.0.0.1:${port}`;
  projectsDir = mkdtempSync(join(tmpdir(), "sketchforge-workspace-limits-browser-"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "workspace-limits-browser-token" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
    try {
      if ((await fetch(baseURL)).ok) break;
    } catch { /* wait for the production server */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
});

after(async () => {
  if (browser) await browser.close();
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  try {
    if (process.platform === "win32") server.kill("SIGTERM");
    else process.kill(-server.pid, "SIGTERM");
  } catch (error) { if (error.code !== "ESRCH") throw error; }
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
});

async function newDesign() {
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Create new 3D design" }).click();
  await page.locator(".editor-toast[role=status]").waitFor({ state: "visible" });
}

async function addBox() {
  const before = await page.locator(".scene-inspector-list > li.scene-row").count();
  await page.getByRole("button", { name: "Add shape" }).click();
  await page.getByText("Box", { exact: true }).first().click();
  await page.waitForFunction((count) => document.querySelectorAll(".scene-inspector-list > li.scene-row").length === count + 1, before, { timeout: 15_000 });
}

async function shapes() {
  return page.locator("pre[data-codex-state]").evaluate((node) => JSON.parse(node.textContent).shapes);
}

async function drag(from, to, button = "left") {
  await page.mouse.move(...from);
  await page.mouse.down({ button });
  for (let step = 1; step <= 20; step += 1) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * step) / 20, from[1] + ((to[1] - from[1]) * step) / 20);
    await page.waitForTimeout(20);
  }
  await page.mouse.up({ button });
  await page.waitForTimeout(400);
}

async function zoomOut(notches) {
  await page.mouse.move(720, 500);
  for (let notch = 0; notch < notches; notch += 1) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
}

async function placementInputs() {
  const placement = page.getByRole("button", { name: "Placement" });
  if (await placement.getAttribute("aria-expanded") === "false") await placement.click();
  const rows = page.locator('[id^="placement-"] .range-property');
  return {
    x: { text: rows.nth(0).locator('input[type="text"]'), slider: rows.nth(0).locator('input[type="range"]') },
    y: { text: rows.nth(1).locator('input[type="text"]'), slider: rows.nth(1).locator('input[type="range"]') },
  };
}

// The default build plate is 200 mm square, so its edge is 100 mm from the origin.
const PLATE_HALF = 100;

test("a part drags past the edge of the build plate", { timeout: 120_000 }, async () => {
  await newDesign();
  await addBox();
  await zoomOut(6);
  const [start] = await shapes();
  assert.deepEqual([start.x, start.z], [0, 0]);

  // The box sits at the origin, mid-canvas; the drop point is well off the plate.
  await drag([720, 520], [1050, 900]);
  const [dropped] = await shapes();
  assert.ok(dropped.x > PLATE_HALF + 20, `x stopped at ${dropped.x}, inside the ${PLATE_HALF} mm plate edge`);
  assert.ok(dropped.z > PLATE_HALF - 30, `z ${dropped.z} did not follow the pointer`);
  await page.screenshot({ path: "docs/screenshots/workspace-drag-past-plate.png" });
});

test("the camera pans away from the build plate", { timeout: 120_000 }, async () => {
  await newDesign();
  await zoomOut(6);
  for (let pass = 0; pass < 6; pass += 1) await drag([300, 300], [1000, 800], "middle");

  // With the plate panned out of view the viewport is one flat colour, so
  // equal-size clips are byte-identical; a pinned plate fills the lower right.
  const clip = (x, y) => page.screenshot({ clip: { x, y, width: 300, height: 250 } });
  const empty = await clip(250, 300);
  for (const [x, y] of [[700, 300], [250, 650], [700, 650]]) {
    assert.ok(empty.equals(await clip(x, y)), `the build plate is still in view near ${x},${y}`);
  }
});

test("position sliders reach a part placed beyond the build plate", { timeout: 120_000 }, async () => {
  await newDesign();
  await addBox();
  const { x, y } = await placementInputs();
  assert.equal(Number(await x.slider.getAttribute("max")), PLATE_HALF);

  // Dragging the thumb off the end stops at the range held during the drag,
  // and the range widens once the thumb is released.
  await x.slider.scrollIntoViewIfNeeded();
  const track = await x.slider.boundingBox();
  const middle = track.y + track.height / 2;
  await drag([track.x + track.width / 2, middle], [track.x + track.width + 60, middle]);
  assert.equal((await shapes())[0].x, PLATE_HALF);
  assert.equal(Number(await x.slider.getAttribute("max")), PLATE_HALF * 2);
  await drag([track.x + track.width * 0.75, middle], [track.x + track.width + 60, middle]);
  assert.equal((await shapes())[0].x, PLATE_HALF * 2);

  await x.text.fill("400");
  await x.text.press("Enter");
  assert.equal((await shapes())[0].x, 400);
  const reach = Number(await x.slider.getAttribute("max"));
  assert.ok(reach >= 400, `slider stops at ${reach} with the part at 400`);
  assert.equal(Number(await x.slider.getAttribute("min")), -reach);
  assert.equal(Number(await x.slider.inputValue()), 400);

  await x.text.fill("-650");
  await x.text.press("Enter");
  assert.equal((await shapes())[0].x, -650);
  assert.ok(Number(await x.slider.getAttribute("min")) <= -650);

  await y.text.fill("900");
  await y.text.press("Enter");
  assert.equal((await shapes())[0].elevation, 900);
  assert.ok(Number(await y.slider.getAttribute("max")) >= 900);
  await page.screenshot({ path: "docs/screenshots/workspace-position-sliders.png" });
});
