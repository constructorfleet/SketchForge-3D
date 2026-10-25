import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, statSync } from "node:fs";
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
  projectsDir = mkdtempSync(join(tmpdir(), "sketchforge-primitive-browser-"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "primitive-browser-token" },
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

async function setPositionX(row, value) {
  await row.locator(".scene-row-name").click({ force: true });
  const placement = page.getByRole("button", { name: "Placement" });
  if (await placement.getAttribute("aria-expanded") === "false") await placement.click();
  const x = page.locator('[id^="placement-"] .range-property input').first();
  await x.fill(String(value));
  await x.press("Enter");
  return x;
}

async function debugShapes() {
  return page.locator("pre[data-codex-state]").evaluate((node) => JSON.parse(node.textContent).shapes);
}

async function selectSceneRows(rows, indexes) {
  await rows.nth(indexes[0]).locator(".scene-row-name").evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  for (const index of indexes.slice(1)) {
    await rows.nth(index).locator(".scene-row-name").evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
  }
}

test("STL, OBJ, and SVG imports create named scene objects with an import notice", { timeout: 180_000 }, async () => {
  const fixtures = [
    { name: "tetrahedron.stl", mimeType: "model/stl", text: "solid tetrahedron\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 10 0 0\n   vertex 0 10 0\n  endloop\n endfacet\nendsolid tetrahedron\n" },
    { name: "tetrahedron.obj", mimeType: "text/plain", text: "o tetrahedron\nv 0 0 0\nv 10 0 0\nv 0 10 0\nv 0 0 10\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n" },
    { name: "profile.svg", mimeType: "image/svg+xml", text: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M1 1 H19 V19 H1 Z"/></svg>' },
  ];
  for (const fixture of fixtures) {
    await newDesign();
    const sceneRows = page.locator(".scene-inspector-list > li.scene-row");
    const rowsBefore = await sceneRows.count();
    const shapesBefore = await debugShapes();
    const trianglesBefore = shapesBefore.reduce((sum, shape) => sum + (shape.importedTriangles ?? 0), 0);
    await page.getByRole("button", { name: "Import" }).click();
    await page.locator('input[type="file"]').last().setInputFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: Buffer.from(fixture.text) });
    await page.locator(".editor-toast").getByText(`Imported ${fixture.name}.`, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction((count) => document.querySelectorAll(".scene-inspector-list > li.scene-row").length > count, rowsBefore, { timeout: 15_000 });
    const shapesAfter = await debugShapes();
    assert.ok(shapesAfter.length > shapesBefore.length, `${fixture.name} should add an object to the scene model`);
    if (/\.(stl|obj)$/i.test(fixture.name)) {
      const trianglesAfter = shapesAfter.reduce((sum, shape) => sum + (shape.importedTriangles ?? 0), 0);
      assert.ok(trianglesAfter > trianglesBefore, `${fixture.name} should add measurable imported triangles`);
    }
  }
  await page.screenshot({ path: "docs/screenshots/primitive-file-import.png" });
});

test("STL, 3MF, and OBJ exports download geometry and report completion", { timeout: 180_000 }, async () => {
  for (const [format, label, extension] of [["stl", "STL", "stl"], ["3mf", "3MF", "3mf"], ["obj", "OBJ", "obj"]]) {
    await newDesign();
    await addBox();
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("radio", { name: new RegExp(`^${label}:`) }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: new RegExp(`Save .*${label}|Export .*${label}`, "i") }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), new RegExp(`\\.${extension}$`, "i"));
    const output = join(projectsDir, download.suggestedFilename());
    await download.saveAs(output);
    assert.ok(statSync(output).size > 100, `${label} export should contain serialized geometry`);
    await page.locator(".editor-toast").getByText(new RegExp(`Exported .*${label}`, "i")).waitFor({ state: "visible", timeout: 60_000 });
  }
  await newDesign();
  await addBox();
  await page.screenshot({ path: "docs/screenshots/primitive-export-workflow.png" });
});

test("Repeat creates a three-item pattern and updates the scene tree", { timeout: 60_000 }, async () => {
  await newDesign();
  await addBox();
  const before = await page.getByRole("button", { name: /^Box/ }).count();
  await page.getByRole("button", { name: "Repeat" }).click();
  const dialog = page.getByRole("dialog", { name: "Repeat" });
  await dialog.getByLabel("Copies").fill("3");
  await dialog.getByRole("button", { name: "Repeat", exact: true }).click();
  await page.locator(".editor-toast").getByText("Repeated the selection into 2 copies", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const afterCount = await page.getByRole("button", { name: /^Box/ }).count();
  assert.equal(afterCount, before + 2, "the scene tree should contain the original plus two copies requested as a three-item pattern");
  await page.screenshot({ path: "docs/screenshots/primitive-repeat-workflow.png" });
});

test("a box with chamfered edges remains in the scene and reports the treatment", { timeout: 90_000 }, async () => {
  await newDesign();
  await addBox();
  await page.getByRole("button", { name: "Chamfer", exact: true }).click();
  await page.getByRole("button", { name: "All sharp edges" }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.locator(".editor-toast").getByText(/Chamfered 12 edges/).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("region", { name: "Faces" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.locator(".scene-inspector-list > li.scene-row").count(), 1, "chamfering must keep the treated solid in the scene");
  await page.screenshot({ path: "docs/screenshots/primitive-chamfer-workflow.png" });
});

test("a solid and offset hole group into one cut shape", { timeout: 120_000 }, async () => {
  await newDesign();
  await addBox();
  await addBox();
  const rows = page.locator(".scene-inspector-list > li.scene-row");
  await setPositionX(rows.nth(1), 5);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press("h");
  await page.locator(".scene-inspector-list .scene-row-tag").getByText("Hole", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await selectSceneRows(rows, [0, 1]);
  await page.waitForFunction(() => document.querySelectorAll(".scene-inspector-list > li.scene-row.selected").length === 2, null, { timeout: 5_000 });
  await page.locator('.toolbar-icon[aria-label="Group"]').click();
  await page.locator(".editor-toast").getByText(/Grouped|hole consumed solid/i).waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForFunction(() => document.querySelectorAll(".scene-inspector-list > li.scene-row").length === 1, null, { timeout: 15_000 });
  const [group] = await debugShapes();
  assert.ok(group.groupedCount > 0, "the cut result should retain grouped operands in the scene model");
  await page.screenshot({ path: "docs/screenshots/primitive-hole-group-workflow.png" });
});

test("two selected shapes can be aligned through an alignment handle", { timeout: 90_000 }, async () => {
  await newDesign();
  await addBox();
  await addBox();
  const rows = page.locator(".scene-inspector-list > li.scene-row");
  await setPositionX(rows.nth(1), 5);
  await selectSceneRows(rows, [0, 1]);
  const before = await debugShapes();
  await page.getByRole("button", { name: "Align", exact: true }).click();
  await page.locator(".align-overlay").getByRole("button", { name: "Align left" }).click();
  await page.locator(".editor-toast").getByText(/Aligned 1 shape/, { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await rows.count(), 2, "alignment should preserve both scene objects");
  assert.notEqual((await debugShapes())[1].x, before[1].x, "the measured X position should change after aligning to the left");
  await page.screenshot({ path: "docs/screenshots/primitive-align-workflow.png" });
});

test("three spaced shapes distribute their gaps without changing scene membership", { timeout: 90_000 }, async () => {
  await newDesign();
  for (const xValue of [0, 40, 120]) {
    await addBox();
    const rowsForPosition = page.locator(".scene-inspector-list > li.scene-row");
    await setPositionX(rowsForPosition.last(), xValue);
  }
  const rows = page.locator(".scene-inspector-list > li.scene-row");
  const beforePositions = (await debugShapes()).map((shape) => shape.x);
  assert.deepEqual(beforePositions, [0, 40, 120], "the fixture uses measured, unequal X positions with enough span for equal gaps");
  const before = beforePositions[1];
  await selectSceneRows(rows, [0, 1, 2]);
  assert.equal(await page.locator("pre[data-codex-state]").evaluate((node) => JSON.parse(node.textContent).selectedIds.length), 3);
  await page.getByRole("button", { name: "Distribute", exact: true }).click();
  await page.getByRole("menuitem", { name: /Equal gaps/ }).click();
  await page.waitForFunction(() => /Distributed|already evenly|Move the objects apart/.test(document.querySelector(".editor-toast")?.textContent ?? ""), null, { timeout: 30_000 });
  const noticeText = await page.locator(".editor-toast").innerText();
  assert.match(noticeText, /Distributed/, `expected the unequal spacing to be adjusted, received: ${noticeText}`);
  const after = (await debugShapes())[1].x;
  assert.equal(after, 60, `the measured middle position should be centred between the outer objects (was ${before})`);
  assert.equal(await rows.count(), 3, "distribution should preserve all three scene objects");
  await page.screenshot({ path: "docs/screenshots/primitive-distribute-workflow.png" });
});

test("Mirror acts on the selected shape and records the result in the scene tree", { timeout: 60_000 }, async () => {
  await newDesign();
  await addBox();
  const before = await debugShapes();
  await page.getByRole("button", { name: "Mirror", exact: true }).click();
  await page.locator(".mirror-overlay").getByRole("button", { name: "Mirror left-right" }).click();
  await page.locator(".editor-toast").getByText(/Mirrored 1 shape/, { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
  const after = await debugShapes();
  assert.equal(after.length, 1, "mirroring should preserve the selected scene object");
  assert.notEqual(after[0].mirrorX, before[0].mirrorX, "the persisted shape state should record the selected mirror axis");
  await page.screenshot({ path: "docs/screenshots/primitive-mirror-workflow.png" });
});

test("A touch user can add a primitive from the shape menu", { timeout: 60_000 }, async () => {
  const touchContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 900, height: 900 } });
  const touchPage = await touchContext.newPage();
  try {
    await touchPage.goto(baseURL);
    await touchPage.getByRole("button", { name: "Create new 3D design" }).tap();
    await touchPage.getByRole("button", { name: "Add shape" }).tap();
    await touchPage.getByText("Box", { exact: true }).first().tap();
    await touchPage.locator(".editor-toast").getByText("Box added", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await touchPage.locator(".scene-inspector-list > li.scene-row").count(), 1, "the touch action should add one scene object");
    await touchPage.screenshot({ path: "docs/screenshots/primitive-touch-workflow.png" });
  } finally {
    await touchContext.close();
  }
});
