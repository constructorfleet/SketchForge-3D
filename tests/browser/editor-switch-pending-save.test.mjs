import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright";

// Issue #668: an edit publishes 120 ms after it is made. Opening another
// project in that gap cancelled the publish, so the first project lost the
// edit. Timers are paused so the switch lands in the gap.

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startNextServer() {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  const stop = () => {
    if (server.exitCode !== null || !server.pid) return;
    try {
      if (process.platform === "win32") server.kill("SIGTERM");
      else process.kill(-server.pid, "SIGTERM");
    } catch {
      // The server already exited.
    }
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
    try {
      if ((await fetch(baseURL)).ok) return { baseURL, stop };
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop();
  throw new Error(`Next.js did not become ready:\n${logs}`);
}

async function pollUntil(read, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

/** Returns each stored project's root shape count by project name; null when no package is stored. */
async function storedRootCounts(page) {
  const { names, packages } = await page.evaluate(() => new Promise((resolve) => {
    const names = Object.fromEntries(JSON.parse(window.localStorage.getItem("sketchForge.projects") ?? "[]").map((project) => [project.id, project.name]));
    const opened = indexedDB.open("sketchForge.projectShapes");
    opened.onerror = () => resolve({ names, packages: [] });
    opened.onsuccess = () => {
      if (!opened.result.objectStoreNames.contains("projectShapes")) return resolve({ names, packages: [] });
      const read = opened.result.transaction("projectShapes").objectStore("projectShapes").getAll();
      read.onerror = () => resolve({ names, packages: [] });
      read.onsuccess = () => resolve({ names, packages: read.result.map((record) => [record.id, Array.from(new Uint8Array(record.skfPackage))]) });
    };
  }));
  const counts = Object.fromEntries(Object.values(names).map((name) => [name, null]));
  for (const [id, bytes] of packages) {
    const document = JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))["project.json"]));
    counts[names[id]] = document.states.find((state) => state.id === document.sceneStateId).rootNodeIds.length;
  }
  return counts;
}

async function storedRootPositions(page) {
  const { names, packages } = await page.evaluate(() => new Promise((resolve) => {
    const names = Object.fromEntries(JSON.parse(window.localStorage.getItem("sketchForge.projects") ?? "[]").map((project) => [project.id, project.name]));
    const opened = indexedDB.open("sketchForge.projectShapes");
    opened.onerror = () => resolve({ names, packages: [] });
    opened.onsuccess = () => {
      if (!opened.result.objectStoreNames.contains("projectShapes")) return resolve({ names, packages: [] });
      const read = opened.result.transaction("projectShapes").objectStore("projectShapes").getAll();
      read.onerror = () => resolve({ names, packages: [] });
      read.onsuccess = () => resolve({ names, packages: read.result.map((record) => [record.id, Array.from(new Uint8Array(record.skfPackage))]) });
    };
  }));
  const positions = {};
  for (const [id, bytes] of packages) {
    const document = JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))["project.json"]));
    const scene = document.states.find((state) => state.id === document.sceneStateId);
    const roots = new Set(scene.rootNodeIds);
    positions[names[id]] = scene.nodes.filter((node) => roots.has(node.nodeId)).map((node) => ({ x: node.definition.x, z: node.definition.z }));
  }
  return positions;
}

async function addBox(page) {
  await page.getByRole("button", { name: "Add shape" }).click();
  await page.getByText("Box", { exact: true }).first().click();
}

async function createAndName(page, name) {
  await page.getByRole("button", { name: "Create new 3D design" }).click();
  await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "Home dashboard" }).click();
  // The newest project is first.
  await page.getByRole("button", { name: /^Project options for / }).first().click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await page.locator(".project-card").filter({ hasText: name }).waitFor();
}

async function open(page, name) {
  await page.locator(".project-card").filter({ hasText: name }).locator(".project-card-open").click();
}

/** Edits Alpha, then opens Beta before that edit's save publishes. */
async function editAlphaThenOpenBeta({ betaLoaded }) {
  const { baseURL, stop } = await startNextServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);

    await createAndName(page, "Alpha");
    await open(page, "Alpha");
    await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
    await addBox(page);
    const saved = await pollUntil(() => storedRootCounts(page), (counts) => counts.Alpha === 1);
    assert.equal(saved.Alpha, 1, "Alpha's first box was never stored");
    await page.getByRole("button", { name: "Home dashboard" }).click();
    await createAndName(page, "Beta");

    await open(page, "Alpha");
    await page.locator(".scene-inspector-list > li.scene-row").first().waitFor({ timeout: 60_000 });
    if (!betaLoaded) {
      // After a reload only Alpha is loaded, so opening Beta unmounts the editor while Beta loads.
      await page.reload();
      const home = page.getByRole("button", { name: "Home dashboard" });
      const card = page.locator(".project-card").filter({ hasText: "Alpha" });
      await home.or(card).first().waitFor({ state: "visible", timeout: 60_000 });
      if (!(await home.isVisible())) await open(page, "Alpha");
      await page.locator(".scene-inspector-list > li.scene-row").first().waitFor({ timeout: 60_000 });
    }
    await page.clock.install();
    // From the page's clock: a target already past throws "Cannot fast-forward to the past".
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 500);
    await addBox(page);
    await page.getByRole("button", { name: "Home dashboard" }).click();
    await open(page, "Beta");
    await page.clock.resume();

    const counts = await pollUntil(() => storedRootCounts(page), (current) => current.Alpha === 2, 10_000);
    assert.equal(counts.Alpha, 2, "Alpha lost the box added just before Beta opened");
    assert.ok(counts.Beta === null || counts.Beta === 0, `Beta took Alpha's edit: ${counts.Beta} shapes`);
    await page.getByText("Nothing in the scene", { exact: true }).waitFor({ timeout: 10_000 });
  } finally {
    await browser?.close();
    stop();
  }
}

test("an edit made just before opening another project is saved to the project it was made in", { timeout: 180_000 }, async () => {
  await editAlphaThenOpenBeta({ betaLoaded: true });
});

test("an edit made just before opening a project not loaded yet is saved to the project it was made in", { timeout: 180_000 }, async () => {
  await editAlphaThenOpenBeta({ betaLoaded: false });
});

test("a drag that ends just before opening another project saves its final position to the original project", { timeout: 180_000 }, async () => {
  const { baseURL, stop } = await startNextServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await createAndName(page, "Alpha");
    await open(page, "Alpha");
    await page.getByRole("button", { name: "Add shape" }).waitFor({ state: "visible", timeout: 60_000 });
    await addBox(page);
    await pollUntil(() => storedRootCounts(page), (counts) => counts.Alpha === 1);
    await page.getByRole("button", { name: "Home dashboard" }).click();
    await createAndName(page, "Beta");
    await open(page, "Alpha");
    await page.locator(".scene-inspector-list > li.scene-row").first().waitFor({ timeout: 60_000 });

    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 500);
    const canvas = page.locator("canvas").first();
    const bounds = await canvas.boundingBox();
    assert.ok(bounds, "the editor viewport should be visible");
    const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 45, start.y + 30, { steps: 8 });
    await page.mouse.up();
    const moved = await pollUntil(
      () => page.locator("pre[data-codex-state]").evaluate((node) => JSON.parse(node.textContent).shapes[0]),
      (shape) => Math.abs(shape.x) > 0.1 || Math.abs(shape.z) > 0.1,
    );
    assert.ok(Math.abs(moved.x) > 0.1 || Math.abs(moved.z) > 0.1, "the pointer drag should move the box");
    await page.screenshot({ path: "docs/screenshots/editor-drag-before-project-switch.png" });

    await page.getByRole("button", { name: "Home dashboard" }).click();
    await open(page, "Beta");
    await page.clock.resume();
    const saved = await pollUntil(() => storedRootPositions(page), (positions) => positions.Alpha?.length === 1 && positions.Alpha[0].x === moved.x && positions.Alpha[0].z === moved.z, 10_000);
    assert.equal(saved.Alpha[0].x, moved.x, "Alpha should retain the final dragged x position");
    assert.equal(saved.Alpha[0].z, moved.z, "Alpha should retain the final dragged z position");
    assert.ok(saved.Beta === undefined || saved.Beta.length === 0, "Beta must not receive Alpha's shape");
  } finally {
    await browser?.close();
    stop();
  }
});
