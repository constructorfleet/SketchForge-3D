import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";
import { createEngine, exportSkfProject, shapeFromRequest } from "@constructorfleet/sketchforge-engine";

// Issue #617: dimension fields take expressions. A bind shows the resolved value,
// marks the field as bound, shows the expression on focus, refuses errors inline,
// autocompletes parameter names, is one undo step, and a literal edit removes it.

const parameters = [
  { name: "wall", expression: "2", dimension: "length", value: 2 },
  { name: "width_total", expression: "wall * 20", dimension: "length", value: 40 },
  { name: "tilt", expression: "30 deg", dimension: "angle", value: 30 },
];

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startNextServer() {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  const stop = () => {
    if (server.exitCode !== null) return;
    try { if (process.platform === "win32") server.kill("SIGTERM"); else process.kill(-server.pid, "SIGTERM"); } catch { /* server already exited */ }
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
    try {
      if ((await fetch(baseURL)).ok) return { baseURL, stop };
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop();
  throw new Error(`Next.js did not become ready:\n${logs}`);
}

test("dimension fields bind to expressions, refuse inline, autocomplete, undo in one step, and lose the binding to a literal", { timeout: 240_000 }, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-expression-fields-"));
  const fixture = path.join(fixtureDir, "fields.skf");
  const box = shapeFromRequest({ kind: "box", width: 20, depth: 20, height: 20 });
  assert.ok(box);
  fs.writeFileSync(fixture, await exportSkfProject({
    projectName: "fields",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    shapes: [{ ...box, name: "Plate" }],
    history: [],
    historyIndex: 0,
    assets: [],
    workspace: undefined,
    snapGrid: "1.0 mm",
    placementElevation: 0,
    parameters,
  }));
  const { baseURL, stop } = await startNextServer();
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await page.locator("input.hidden-file-input[accept^=\".skf,.stl\"]").setInputFiles(fixture);
    await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });

    const shape = async () => (await page.locator("pre[data-codex-state]").evaluate((node) => JSON.parse(node.textContent).shapes))[0];
    const shapeWhen = async (check, message) => {
      const until = Date.now() + 30_000;
      let last;
      while (Date.now() < until) {
        last = await shape();
        if (check(last)) return last;
        await page.waitForTimeout(100);
      }
      assert.fail(`${message}: ${JSON.stringify(last)}`);
    };
    const select = async () => {
      await page.locator(".scene-inspector-list .scene-row-name").first().click({ force: true });
      await page.locator(".shape-inspector").first().waitFor();
    };
    await select();
    const width = page.getByRole("combobox", { name: "Width" });
    await width.waitFor();
    assert.equal(await width.inputValue(), "20.00");
    assert.equal(await width.getAttribute("aria-description"), null, "an unbound field has no binding description");

    // Autocomplete: typing a name prefix offers matching parameters; Enter accepts.
    await width.click();
    await width.fill("");
    await width.pressSequentially("wid");
    const options = page.getByRole("listbox", { name: "Parameter suggestions" });
    await options.getByRole("option", { name: /width_total/ }).waitFor();
    assert.equal(await width.getAttribute("aria-expanded"), "true");
    assert.ok(await width.getAttribute("aria-activedescendant"), "the active option is announced");
    await page.screenshot({ path: "docs/screenshots/expression-field-autocomplete.png" });
    await width.press("Enter");
    assert.equal(await width.inputValue(), "width_total");
    assert.equal(await width.getAttribute("aria-expanded"), "false");
    await width.pressSequentially(" / 2 + wall");
    await width.press("Enter");

    // The bind applies the resolved value and keeps the expression.
    const bound = await shapeWhen((current) => current.width === 22, "width follows width_total / 2 + wall");
    assert.deepEqual(bound.expressions, { width: "width_total / 2 + wall" });
    assert.equal(await width.inputValue(), "22.00", "at rest the field shows the resolved value");
    assert.equal(await width.getAttribute("aria-description"), "Follows the expression width_total / 2 + wall");
    assert.equal(await page.locator(".range-property.is-bound .expression-input-badge").count(), 1, "a bound field shows a marker that is not colour alone");
    await page.mouse.move(10, 10);
    await page.screenshot({ path: "docs/screenshots/expression-field-bound.png" });

    // Focus shows the expression.
    await width.focus();
    assert.equal(await width.inputValue(), "width_total / 2 + wall");
    await page.screenshot({ path: "docs/screenshots/expression-field-focus.png" });

    // An error appears inline and changes nothing.
    await width.fill("tilt * 2");
    await width.press("Enter");
    const alert = page.getByRole("alert").filter({ hasText: "needs a length" });
    await alert.waitFor();
    assert.equal(await width.getAttribute("aria-invalid"), "true");
    assert.equal(await width.getAttribute("aria-describedby"), await alert.getAttribute("id"));
    await alert.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/expression-field-inline-error.png" });
    const unchanged = await shape();
    assert.equal(unchanged.width, 22, "a refused expression leaves geometry alone");
    assert.deepEqual(unchanged.expressions, { width: "width_total / 2 + wall" });
    await width.focus();
    await width.press("Escape");
    assert.equal(await page.getByRole("alert").filter({ hasText: "needs a length" }).count(), 0, "Escape clears the refused draft");
    assert.equal(await width.inputValue(), "22.00");

    // One bind is one undo step.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    const undone = await shapeWhen((current) => current.width === 20, "undo restores the width");
    assert.equal(undone.expressions, undefined, "undo removes the binding in the same step");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await shapeWhen((current) => current.width === 22 && current.expressions?.width, "redo binds again");

    // A parameter change moves the bound field.
    await page.getByRole("button", { name: "Project parameters" }).click();
    const panel = page.getByRole("dialog", { name: "Parameters" });
    await panel.getByRole("textbox", { name: "Expression of wall" }).fill("3");
    await panel.getByRole("textbox", { name: "Expression of wall" }).press("Enter");
    await shapeWhen((current) => current.width === 33, "width follows wall: 60 / 2 + 3");
    await panel.getByRole("button", { name: "Close Parameters" }).click();

    // A plain number is a literal: it removes the binding, as one undo step.
    await select();
    await width.fill("25");
    await width.press("Enter");
    const literal = await shapeWhen((current) => current.width === 25, "a typed number sets the width");
    assert.equal(literal.expressions, undefined, "a typed number removes the binding");
    assert.equal(await width.getAttribute("aria-description"), null);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await shapeWhen((current) => current.width === 33 && current.expressions?.width, "one undo restores value and binding");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await shapeWhen((current) => current.width === 25 && !current.expressions, "redo the literal");

    // A placement field binds too, and a keyboard nudge drops that binding.
    const positionX = page.locator('[id^="placement-"]').getByRole("combobox", { name: "X", exact: true });
    await positionX.fill("wall * 4");
    await positionX.press("Enter");
    await shapeWhen((current) => current.x === 12 && current.expressions?.x === "wall * 4", "x follows wall * 4");
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("ArrowRight");
    const nudged = await shapeWhen((current) => current.x !== 12, "the nudge moves the shape");
    assert.equal(nudged.expressions, undefined, "a local edit to a bound field removes its binding");
    await page.getByRole("button", { name: "Project parameters" }).click();
    await panel.getByRole("textbox", { name: "Expression of wall" }).fill("5");
    await panel.getByRole("textbox", { name: "Expression of wall" }).press("Enter");
    await panel.getByRole("button", { name: "Close Parameters" }).click();
    await page.waitForTimeout(500);
    assert.equal((await shape()).x, nudged.x, "a later parameter change does not snap the nudge back");

    // Typing the number a bound field already shows still removes the binding.
    await select();
    const height = page.getByRole("combobox", { name: "Height" });
    await height.fill("wall * 4");
    await height.press("Enter");
    await shapeWhen((current) => current.height === 20 && current.expressions?.height === "wall * 4", "height follows wall * 4");
    await height.fill("20");
    await height.press("Enter");
    await shapeWhen((current) => current.height === 20 && !current.expressions, "the same number as a literal unbinds height");

    // A slider move is a local edit too.
    await height.fill("wall * 4");
    await height.press("Enter");
    await shapeWhen((current) => current.expressions?.height === "wall * 4", "height is bound again");
    const heightSlider = page.locator("label.range-property").filter({ has: height }).locator('input[type="range"]');
    await heightSlider.focus();
    await heightSlider.press("ArrowRight");
    await heightSlider.blur();
    const slid = await shapeWhen((current) => current.height !== 20, "the slider changes the height");
    assert.equal(slid.expressions, undefined, "a slider move removes the height binding");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("sketch dimension inputs bind constraints to expressions and a typed number unbinds them", { timeout: 240_000 }, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-expression-sketch-"));
  const fixture = path.join(fixtureDir, "sketch.skf");
  fs.writeFileSync(fixture, await exportSkfProject({
    projectName: "sketch",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    shapes: [],
    history: [],
    historyIndex: 0,
    assets: [],
    workspace: undefined,
    snapGrid: "1.0 mm",
    placementElevation: 0,
    parameters,
  }));
  const { baseURL, stop } = await startNextServer();
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await page.locator("input.hidden-file-input[accept^=\".skf,.stl\"]").setInputFiles(fixture);
    await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });
    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Extrude sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();

    const side = page.locator('[data-sketch-entity="segment"]').first();
    const bounds = await side.boundingBox();
    assert.ok(bounds, "the rectangle has a selectable side");
    await page.mouse.move(bounds.x - 6, bounds.y - 6);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width + 6, bounds.y + bounds.height + 6);
    await page.mouse.up();
    assert.equal(await page.locator('[data-sketch-entity="point"].selected').count(), 2, "the marquee selects the side's two endpoints");

    // A new constraint takes an expression, with name completion.
    const distance = page.getByRole("combobox", { name: "Distance (mm)" });
    await distance.fill("");
    await distance.pressSequentially("wa");
    await page.getByRole("option", { name: /wall/ }).waitFor();
    await distance.press("Enter");
    await distance.pressSequentially(" * 6");
    await page.getByRole("button", { name: "Set distance", exact: true }).click();
    const list = page.locator(".sketch-constraint-list");
    await list.getByText(/^Distance 12 mm /).waitFor();
    const rowValue = list.getByRole("combobox", { name: "Value of Distance" });
    assert.equal(await rowValue.getAttribute("aria-description"), "Follows the expression wall * 6");
    assert.equal(await rowValue.inputValue(), "12");

    // A refused entry stays inline and changes nothing.
    await rowValue.fill("tilt");
    await rowValue.press("Enter");
    await page.getByRole("alert").filter({ hasText: "needs a length" }).waitFor();
    await list.getByText(/^Distance 12 mm /).waitFor();

    // A typed number is a literal: the constraint keeps it and stops following wall.
    await rowValue.fill("15");
    await rowValue.press("Enter");
    await list.getByText(/^Distance 15 mm /).waitFor();
    assert.equal(await rowValue.getAttribute("aria-description"), null);

    // Rebinding the row resolves through the table again.
    await rowValue.fill("width_total / 2");
    await rowValue.press("Enter");
    await list.getByText(/^Distance 20 mm /).waitFor();
    assert.equal(await rowValue.getAttribute("aria-description"), "Follows the expression width_total / 2");
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/expression-field-sketch-constraint.png" });
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

/** Builds a ring revolved a full turn through the engine's own request path. */
async function revolveShape() {
  let document = { metadata: { revision: 0 }, projectName: "r", createdAt: 0, shapes: [], history: [], historyIndex: 0, assets: [] };
  const store = {
    read: async () => document,
    write: async (_id, next, shapes) => {
      document = { ...next, shapes };
      return { revision: 1 };
    },
    withLock: async (_id, work) => ({ busy: false, result: await work() }),
    list: async () => [],
  };
  const added = await createEngine(store).addShapes("r", [{ kind: "revolve", profile: [[5, -4], [10, -4], [10, 4], [5, 4]], sides: 48, name: "Ring" }]);
  assert.ok(added.ok, JSON.stringify(added));
  return document.shapes[0];
}

/** Opens a project holding `shapes` and the shared parameters, and hands the page to `run`. */
async function withEditor(shapes, run) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-expression-more-"));
  const fixture = path.join(fixtureDir, "more.skf");
  fs.writeFileSync(fixture, await exportSkfProject({
    projectName: "more", createdAt: Date.now(), modifiedAt: Date.now(), shapes, history: [], historyIndex: 0,
    assets: [], workspace: undefined, snapGrid: "1.0 mm", placementElevation: 0, parameters,
  }));
  const { baseURL, stop } = await startNextServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await page.locator("input.hidden-file-input[accept^=\".skf,.stl\"]").setInputFiles(fixture);
    await page.getByRole("button", { name: "Home dashboard" }).waitFor({ state: "visible", timeout: 60_000 });
    const all = async () => page.locator("pre[data-codex-state]").evaluate((node) => JSON.parse(node.textContent).shapes);
    const shapeWhen = async (index, check, message) => {
      const until = Date.now() + 30_000;
      let last;
      while (Date.now() < until) {
        last = (await all())[index];
        if (last && check(last)) return last;
        await page.waitForTimeout(100);
      }
      assert.fail(`${message}: ${JSON.stringify(last)}`);
    };
    const select = async (name) => {
      await page.locator(".scene-inspector-list .scene-row-name").filter({ hasText: name }).evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await page.locator(".shape-inspector-header").filter({ hasText: name }).first().waitFor();
      await page.locator(".shape-inspector").first().waitFor();
    };
    await run({ page, shapeWhen, select });
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test("revolve setting fields keep other bindings through a rebuild, and a typed number is one undo step", { timeout: 240_000 }, async () => {
  await withEditor([await revolveShape()], async ({ page, shapeWhen, select }) => {
    await select("Ring");
    const sweep = page.getByRole("combobox", { name: "Sweep" });
    // A server refusal also reaches the status line, which outlives the field.
    await sweep.fill("tilt * 20");
    await sweep.press("Enter");
    const outOfRange = "The expression gives 600, which is out of range for this field.";
    await page.getByRole("alert").filter({ hasText: outOfRange }).waitFor();
    await page.waitForFunction((text) => [...document.querySelectorAll("body *")].filter((node) => node.children.length === 0 && node.textContent?.trim() === text).length >= 2, outOfRange, { timeout: 15_000 });
    await sweep.focus();
    await sweep.press("Escape");
    await sweep.fill("tilt * 6");
    await sweep.press("Enter");
    await shapeWhen(0, (shape) => shape.sketchRevolve?.sweepAngle === 180 && shape.expressions?.["revolve.sweepAngle"] === "tilt * 6", "sweep follows tilt * 6");

    // Changing another revolve setting rebuilds the solid; the sweep binding survives it.
    const start = page.getByRole("combobox", { name: "Start Angle" });
    await start.fill("45");
    await start.press("Enter");
    const rebuilt = await shapeWhen(0, (shape) => shape.sketchRevolve?.startAngle === 45, "the start angle rebuilds the revolve");
    assert.deepEqual(rebuilt.expressions, { "revolve.sweepAngle": "tilt * 6" }, "an unrelated rebuild keeps the sweep binding");

    // A typed number on the bound sweep unbinds it with the new value, as one undo step.
    await sweep.fill("90");
    await sweep.press("Enter");
    const literal = await shapeWhen(0, (shape) => shape.sketchRevolve?.sweepAngle === 90, "the typed sweep rebuilds the revolve");
    assert.equal(literal.expressions, undefined, "a typed number removes the sweep binding");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await shapeWhen(0, (shape) => shape.sketchRevolve?.sweepAngle === 180 && shape.expressions?.["revolve.sweepAngle"] === "tilt * 6", "one undo restores the sweep and its binding");
  });
});

test("field state follows the selected shape, and a shape-wide edit drops the binding it changes", { timeout: 240_000 }, async () => {
  const box = shapeFromRequest({ kind: "box", width: 20, depth: 20, height: 20 });
  assert.ok(box);
  const first = { ...box, id: "first", name: "First" };
  const second = { ...box, id: "second", name: "Second", x: 40 };
  await withEditor([first, second], async ({ page, shapeWhen, select }) => {
    // A refused entry on the first shape does not follow the selection to the second.
    await select("First");
    const width = page.getByRole("combobox", { name: "Width" });
    await width.fill("tilt");
    await width.press("Enter");
    await page.getByRole("alert").filter({ hasText: "needs a length" }).waitFor();
    await select("Second");
    await page.getByRole("alert").filter({ hasText: "needs a length" }).waitFor({ state: "detached" });
    assert.equal(await width.getAttribute("aria-invalid"), null, "the second shape's field is not marked invalid");
    assert.equal(await width.inputValue(), "20.00");
    await width.focus();
    await width.blur();
    await page.waitForTimeout(300);
    const untouched = await shapeWhen(1, () => true, "read the second shape");
    assert.equal(untouched.expressions, undefined, "a plain blur does not bind the second shape to the first shape's text");

    // Drop to workplane changes a bound elevation through the editor's commit path, which drops the binding.
    const elevation = page.locator('[id^="placement-"]').getByRole("combobox", { name: "Y", exact: true });
    await elevation.fill("wall * 5");
    await elevation.press("Enter");
    await shapeWhen(1, (shape) => shape.elevation === 10 && shape.expressions?.elevation === "wall * 5", "elevation follows wall * 5");
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("d");
    const dropped = await shapeWhen(1, (shape) => shape.elevation === 0, "drop to workplane lowers the shape");
    assert.equal(dropped.expressions, undefined, "a shape-wide edit removes the binding it changed");
  });
});
