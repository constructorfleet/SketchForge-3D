import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";
import { exportSkfProject, shapeFromRequest } from "@constructorfleet/sketchforge-engine";

// Issue #618: the parameter panel edits any configuration, active or not, and
// activates one only on an explicit action. Each change is one undo step; a
// refusal shows inline, changes nothing, and adds no undo step.

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

test("configurations are edited apart from activation, and undo with the panel open", { timeout: 300_000 }, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-configurations-"));
  const fixture = path.join(fixtureDir, "configured.skf");
  const box = shapeFromRequest({ kind: "box", width: 10, depth: 10, height: 10 });
  assert.ok(box);
  fs.writeFileSync(fixture, await exportSkfProject({
    projectName: "configured",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    shapes: [{ ...box, name: "Bound box", x: 5, expressions: { width: "w", x: "w / 2" } }],
    history: [],
    historyIndex: 0,
    assets: [],
    workspace: undefined,
    snapGrid: "1.0 mm",
    placementElevation: 0,
    parameters: [{ name: "w", expression: "10", dimension: "length", value: 10 }],
    configurations: [
      { name: "Large", overrides: { w: "30" } },
      // A bound width cannot take -5, so activating Broken is refused until it is fixed.
      { name: "Broken", overrides: { w: "-5" } },
      // Stale on load: the override names nothing.
      { name: "Stale", overrides: { w: "missing * 2" } },
    ],
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
    await page.getByRole("button", { name: "Project parameters" }).click();
    const panel = page.getByRole("dialog", { name: "Parameters" });
    await panel.waitFor();
    // The panel stays open: undo and redo are pressed in the toolbar beside it.
    const undo = () => page.getByRole("button", { name: "Undo", exact: true }).click();
    const redo = () => page.getByRole("button", { name: "Redo", exact: true }).click();
    const editing = panel.getByRole("combobox", { name: "Edit configuration" });
    const status = panel.locator(".parameters-configuration-status");
    const override = (name) => panel.getByRole("textbox", { name: `Override of w in ${name}` });
    const activate = (name) => panel.getByRole("button", { name: `Activate ${name}` });

    // Choosing a configuration to edit does not activate it.
    await editing.selectOption("Large");
    assert.match(await status.textContent(), /Active: base table/);
    assert.equal(await override("Large").inputValue(), "30");
    await panel.locator("output[aria-label=\"w = 10 mm\"]").waitFor();
    assert.equal((await shape()).width, 10, "editing a configuration moves nothing");

    // Activation is explicit, one undo step, and the panel follows undo and redo while open.
    await activate("Large").click();
    await shapeWhen((current) => current.width === 30 && current.x === 15, "Large drives the bound box");
    assert.match(await status.textContent(), /Active: Large/);
    await undo();
    await shapeWhen((current) => current.width === 10, "undo returns to the base table");
    await panel.locator("output[aria-label=\"w = 10 mm\"]").waitFor();
    assert.match(await status.textContent(), /Active: base table/, "the open panel follows undo");
    assert.equal(await override("Large").inputValue(), "30", "the override column still shows the selected configuration");
    await redo();
    await shapeWhen((current) => current.width === 30, "redo activates Large again");
    await panel.locator("output[aria-label=\"w = 30 mm\"]").waitFor();
    assert.match(await status.textContent(), /Active: Large/, "the open panel follows redo");

    // A refused activation shows inline, changes nothing and adds no undo step.
    await editing.selectOption("Broken");
    await activate("Broken").click();
    await panel.getByRole("alert").filter({ hasText: "out of range" }).waitFor();
    assert.equal((await shape()).width, 30);
    assert.match(await status.textContent(), /Active: Large/);
    await undo();
    await shapeWhen((current) => current.width === 10, "the one undo step left is the Large activation");
    await redo();
    await shapeWhen((current) => current.width === 30, "redo again");

    // The refused configuration can be fixed while it is not active; that moves nothing.
    await override("Broken").fill("20");
    await override("Broken").press("Enter");
    await panel.locator("output[aria-label=\"w = 30 mm\"]").waitFor();
    assert.equal((await shape()).width, 30, "an inactive override does not recompute");
    await activate("Broken").click();
    await shapeWhen((current) => current.width === 20, "the fixed configuration activates");

    // A stale configuration lists its issue and can be renamed and deleted.
    await editing.selectOption("Stale");
    await panel.locator(".parameters-configuration-issues", { hasText: "w" }).waitFor();
    const rename = panel.getByRole("textbox", { name: "Name of configuration Stale" });
    await rename.fill("Older");
    await rename.press("Enter");
    await panel.getByRole("option", { name: "Older" }).waitFor({ state: "attached" });
    assert.equal(await editing.inputValue(), "Older", "the selection follows a rename");
    await panel.getByRole("button", { name: "Delete configuration Older" }).click();
    await panel.getByRole("option", { name: "Older" }).waitFor({ state: "detached" });
    assert.equal((await shape()).width, 20, "deleting an inactive configuration moves nothing");

    // A refused rename marks its field.
    await editing.selectOption("Large");
    const largeName = panel.getByRole("textbox", { name: "Name of configuration Large" });
    await largeName.fill("Broken");
    await largeName.press("Enter");
    await panel.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
    assert.equal(await largeName.getAttribute("aria-invalid"), "true");

    // Back to the base table, explicitly.
    await panel.getByRole("button", { name: "Use base table" }).click();
    await shapeWhen((current) => current.width === 10, "the base table applies");
    assert.equal(await panel.getByRole("alert").count(), 0, "a committed change clears the error");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
