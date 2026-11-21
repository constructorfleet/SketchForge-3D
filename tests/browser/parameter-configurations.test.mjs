import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";
import { exportSkfProject, shapeFromRequest } from "@constructorfleet/sketchforge-engine";

// Issue #618: the parameter panel picks the active configuration, edits its
// overrides and manages configurations. Each change is one undo step, and a
// refusal shows inline with the model unchanged.

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

test("configurations switch, override, undo and manage from the parameter panel", { timeout: 240_000 }, async () => {
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
    configurations: [{ name: "Large", overrides: { w: "30" } }],
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
    let panel;
    const openPanel = async () => {
      await page.getByRole("button", { name: "Project parameters" }).click();
      panel = page.getByRole("dialog", { name: "Parameters" });
      await panel.waitFor();
    };
    const closePanel = () => panel.getByRole("button", { name: "Close Parameters" }).click();
    const undo = () => page.getByRole("button", { name: "Undo", exact: true }).click();
    const picker = () => panel.getByRole("combobox", { name: "Active configuration" });
    const override = () => panel.getByRole("textbox", { name: "Override of w in Large" });

    // Activating a configuration recomputes bound geometry, as one undo step.
    await openPanel();
    assert.equal(await picker().inputValue(), "");
    await picker().selectOption("Large");
    await shapeWhen((current) => current.width === 30 && current.x === 15, "Large drives the bound box");
    await panel.locator("output[aria-label=\"w = 30 mm\"]").waitFor();
    assert.equal(await panel.getByRole("textbox", { name: "Expression of w" }).inputValue(), "10", "the base expression stays");
    assert.equal(await override().inputValue(), "30");
    await closePanel();
    await undo();
    await shapeWhen((current) => current.width === 10, "undo returns to the base table");
    await openPanel();
    assert.equal(await picker().inputValue(), "", "undo restores the base table in the picker");
    await picker().selectOption("Large");
    await shapeWhen((current) => current.width === 30, "activate again");

    // An override the bound field cannot take is refused inline; the model is unchanged.
    await override().fill("-5");
    await override().press("Enter");
    await panel.getByRole("alert").filter({ hasText: "out of range" }).waitFor();
    assert.equal((await shape()).width, 30, "a refused override leaves geometry alone");

    // Setting and clearing an override move the geometry; clearing falls back to the base expression.
    await override().fill("40");
    await override().press("Enter");
    await shapeWhen((current) => current.width === 40, "the new override applies");
    assert.equal(await panel.getByRole("alert").count(), 0, "a committed override clears the error");
    await override().fill("");
    await override().press("Enter");
    await shapeWhen((current) => current.width === 10, "a cleared override uses the base expression");
    await closePanel();
    await undo();
    await shapeWhen((current) => current.width === 40, "undo restores the cleared override");

    // Create, rename and delete configurations.
    await openPanel();
    await panel.getByRole("textbox", { name: "New configuration name" }).fill("Small");
    await panel.getByRole("button", { name: "Add configuration" }).click();
    await panel.getByRole("option", { name: "Small" }).waitFor({ state: "attached" });
    const rename = panel.getByRole("textbox", { name: "Name of configuration Large" });
    await rename.fill("Big");
    await rename.press("Enter");
    await panel.getByRole("option", { name: "Big" }).waitFor({ state: "attached" });
    assert.equal(await picker().inputValue(), "Big", "the active name follows a rename");
    await panel.getByRole("button", { name: "Delete configuration Big" }).click();
    await shapeWhen((current) => current.width === 10, "deleting the active configuration returns to the base table");
    assert.equal(await picker().inputValue(), "");
    assert.equal(await panel.getByRole("option", { name: "Big" }).count(), 0);
    await closePanel();
    await undo();
    await shapeWhen((current) => current.width === 40, "undo brings the deleted configuration back, still active");
  } finally {
    if (browser) await browser.close();
    stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
