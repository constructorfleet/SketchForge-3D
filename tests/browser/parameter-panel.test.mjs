import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";
import { exportSkfProject, shapeFromRequest } from "@constructorfleet/sketchforge-engine";

// Issue #616: the parameter panel edits the table, refuses bad expressions
// inline, recomputes bound geometry, undoes as one step, and warns before
// deleting a parameter that shapes or parameters use.

const parameters = [
  { name: "w", expression: "10", dimension: "length", value: 10 },
  { name: "half", expression: "w / 2", dimension: "length", value: 5 },
  { name: "stale", expression: "missing * 2", dimension: "length", value: 7 },
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

test("the parameter panel edits, refuses inline, recomputes, undoes in one step, and warns before deleting", { timeout: 240_000 }, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-parameter-panel-"));
  const fixture = path.join(fixtureDir, "bound.skf");
  const box = shapeFromRequest({ kind: "box", width: 10, depth: 10, height: 10 });
  assert.ok(box);
  const bound = { ...box, name: "Bound box", x: 5, expressions: { width: "w", x: "half" } };
  fs.writeFileSync(fixture, await exportSkfProject({
    projectName: "bound",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    shapes: [bound, { ...box, id: `${box.id}-free`, name: "Free box", x: -30 }],
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
    const openPanel = async () => {
      await page.getByRole("button", { name: "Project parameters" }).click();
      return page.getByRole("dialog", { name: "Parameters" });
    };

    let panel = await openPanel();
    const expressionOf = (name) => panel.getByRole("textbox", { name: `Expression of ${name}` });
    const valueOf = (name) => panel.locator(`output[aria-label^="${name} = "]`);
    assert.equal(await valueOf("half").getAttribute("aria-label"), "half = 5 mm");

    // A stale entry's error is described, not announced as a new alert.
    const staleExpression = expressionOf("stale");
    assert.equal(await staleExpression.getAttribute("aria-invalid"), "true");
    const staleDescription = await staleExpression.getAttribute("aria-describedby");
    assert.match(await panel.locator(`[id="${staleDescription}"]`).textContent(), /not a parameter/);
    assert.equal(await panel.getByRole("alert").count(), 0, "opening the panel raises no alert");

    // A rename keeps focus in the row, so Tab moves on to its expression.
    await panel.getByRole("textbox", { name: "Name of half" }).fill("mid");
    await panel.getByRole("textbox", { name: "Name of half" }).press("Tab");
    await panel.getByRole("textbox", { name: "Name of mid" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Expression of mid", "focus survives the rename");

    // An invalid expression and a cycle are refused inline; the model is unchanged.
    await expressionOf("w").fill("2 +");
    await expressionOf("w").press("Enter");
    await panel.getByRole("alert").filter({ hasText: "incomplete or has a typo" }).waitFor();
    assert.equal(await expressionOf("w").getAttribute("aria-invalid"), "true");
    await expressionOf("w").fill("mid * 2");
    await expressionOf("w").press("Enter");
    await panel.getByRole("alert").filter({ hasText: "w → mid → w" }).waitFor();
    // An undo underneath clears the row's error and draft.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await panel.getByRole("textbox", { name: "Name of half" }).waitFor();
    assert.equal(await panel.getByRole("alert").count(), 0, "undo clears the edit error");
    assert.equal(await expressionOf("w").inputValue(), "10", "undo clears the draft");
    assert.equal((await shape()).width, 10, "a refused edit leaves geometry alone");
    assert.equal(await valueOf("half").getAttribute("aria-label"), "half = 5 mm");

    // A valid edit recomputes both bound fields, through a dependent parameter too.
    await expressionOf("w").fill("24");
    await expressionOf("w").press("Enter");
    const grown = await shapeWhen((current) => current.width === 24, "the bound width follows w");
    assert.equal(grown.x, 12, "x follows half = w / 2");
    await panel.locator("output[aria-label=\"half = 12 mm\"]").waitFor();
    assert.equal(await panel.getByRole("alert").count(), 0, "a committed edit clears the error");

    // One undo restores the value and the geometry.
    await panel.getByRole("button", { name: "Close Parameters" }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    const undone = await shapeWhen((current) => current.width === 10, "undo restores the width");
    assert.equal(undone.x, 5, "undo restores x in the same step");
    panel = await openPanel();
    assert.equal(await expressionOf("w").inputValue(), "10", "undo restores the expression");
    await panel.locator("output[aria-label=\"half = 5 mm\"]").waitFor();
    await panel.getByRole("button", { name: "Close Parameters" }).click();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await shapeWhen((current) => current.width === 24 && current.x === 12, "redo reapplies the edit");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await shapeWhen((current) => current.width === 10, "undo again");

    // A refused recompute reaches the status line even after the panel closes.
    let releaseRecompute;
    const recomputeHeld = new Promise((resolve) => { releaseRecompute = resolve; });
    let postedShapes = -1;
    await page.route("**/api/editor/parameters", async (route) => {
      postedShapes = JSON.parse(route.request().postData() ?? "{}").shapes?.length ?? -1;
      await recomputeHeld;
      await route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ code: "limit_exceeded" }) });
    });
    panel = await openPanel();
    await expressionOf("w").fill("40");
    await expressionOf("w").press("Enter");
    await panel.getByRole("status").filter({ hasText: "Updating bound shapes" }).waitFor();
    await panel.getByRole("button", { name: "Close Parameters" }).click();
    releaseRecompute();
    await page.locator(".editor-toast", { hasText: "The project is too large to send for a recompute." }).waitFor();
    assert.equal(postedShapes, 1, "only the bound tree is sent");
    assert.equal((await shape()).width, 10, "a refused recompute leaves geometry alone");
    await page.unroute("**/api/editor/parameters");

    // Adding is one undo step too.
    panel = await openPanel();
    await panel.getByRole("textbox", { name: "New parameter name" }).fill("lip");
    await panel.getByRole("textbox", { name: "New parameter expression" }).fill("w / 4");
    await panel.getByRole("button", { name: "Add parameter" }).click();
    await panel.locator("output[aria-label=\"lip = 2.5 mm\"]").waitFor();
    await panel.getByRole("button", { name: "Close Parameters" }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    panel = await openPanel();
    await panel.getByRole("textbox", { name: "Expression of w" }).waitFor();
    assert.equal(await panel.getByRole("textbox", { name: "Expression of lip" }).count(), 0, "undo removes the added parameter");

    // Deleting a parameter in use warns and names its dependents.
    await panel.getByRole("button", { name: "Delete w" }).click();
    let warning = panel.locator(".parameters-delete-warning");
    await warning.waitFor();
    assert.match(await warning.textContent(), /w is still in use/);
    assert.match(await warning.textContent(), /Parameters using it: half/);
    assert.match(await warning.textContent(), /Bound box: width/);
    assert.equal(await warning.getByRole("button", { name: "Delete and keep shape values" }).count(), 0, "a parameter dependent blocks the delete");
    await warning.getByRole("button", { name: "Cancel" }).click();

    await panel.getByRole("button", { name: "Delete half" }).click();
    warning = panel.locator(".parameters-delete-warning");
    assert.match(await warning.textContent(), /Bound box: x/);
    await warning.getByRole("button", { name: "Delete and keep shape values" }).click();
    await panel.getByRole("textbox", { name: "Expression of half" }).waitFor({ state: "detached" });
    assert.equal((await shape()).x, 5, "a released shape keeps its value");

    // The release is one undo step: the parameter and the binding return.
    await panel.getByRole("button", { name: "Close Parameters" }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    panel = await openPanel();
    await panel.getByRole("textbox", { name: "Expression of half" }).waitFor();
    await panel.getByRole("textbox", { name: "Expression of w" }).fill("30");
    await panel.getByRole("textbox", { name: "Expression of w" }).press("Enter");
    await shapeWhen((current) => current.width === 30 && current.x === 15, "the restored binding follows w again");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
