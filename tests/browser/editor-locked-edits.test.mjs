import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { chromium } from "playwright";

/** Issue #645: a lock refuses sketch edits and edge treatments from every editor entry point. */

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function withEditor(run) {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  let browser;
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try { if ((await fetch(baseURL)).ok) break; } catch { /* server starting */ }
      if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
      if (Date.now() > deadline) throw new Error(`Next.js did not start:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    // A newer upstream release can open a modal that intercepts clicks.
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();
    await run(page, baseURL);
  } finally {
    await browser?.close();
    if (server.pid) {
      if (process.platform === "win32") server.kill("SIGTERM");
      else {
        try { process.kill(-server.pid, "SIGTERM"); } catch { /* The server already exited. */ }
      }
      if (server.exitCode === null) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
}

const status = (page, text) => page.getByRole("status").getByText(text, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

test("a locked sketch extrusion cannot be reopened from the toolbar or the object panel", { timeout: 240_000 }, async () => {
  await withEditor(async (page) => {
    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Extrude sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish sketch" }).click();
    await page.getByText("Sketch extrusion").first().waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("tab", { name: "Sketch" }).click();
    const toolbarEdit = page.getByRole("button", { name: "Edit Sketch to 3D", exact: true });
    const panelEdit = page.getByRole("button", { name: "Edit sketch", exact: true });
    assert.equal(await toolbarEdit.isDisabled(), false, "an unlocked sketch extrusion can be reopened from the toolbar");
    assert.equal(await panelEdit.isDisabled(), false, "and from the object panel");

    await page.keyboard.press("Shift+L");
    await status(page, "Selection locked");
    assert.equal(await toolbarEdit.isDisabled(), true, "the toolbar refuses a locked sketch extrusion");
    assert.equal(await panelEdit.isDisabled(), true, "as the object panel does");
    fs.mkdirSync("docs/screenshots", { recursive: true });
    await page.screenshot({ path: "docs/screenshots/editor-locked-sketch-edit.png" });

    await page.keyboard.press("Shift+L");
    await status(page, "Selection unlocked");
    assert.equal(await toolbarEdit.isDisabled(), false, "unlocking restores the toolbar button");
  });
});

/** Rewrites `project.json` in an `.skf`, locking the first child of the first top-level group. */
function lockFirstGroupChild(bytes) {
  const files = unzipSync(bytes);
  const project = JSON.parse(strFromU8(files["project.json"]));
  const scene = project.states.find((state) => state.nodes.some((node) => node.groupedShapeNodeIds?.length));
  const group = scene.nodes.find((node) => scene.rootNodeIds.includes(node.nodeId) && node.groupedShapeNodeIds?.length);
  assert.ok(group, "the saved scene holds a group");
  const childObjectId = scene.nodes.find((node) => node.nodeId === group.groupedShapeNodeIds[0]).objectId;
  let locked = 0;
  for (const state of project.states) {
    for (const node of state.nodes) {
      if (node.objectId !== childObjectId) continue;
      node.definition.locked = true;
      locked += 1;
    }
  }
  assert.ok(locked > 0, "the child node was found");
  files["project.json"] = strToU8(JSON.stringify(project));
  return zipSync(files);
}

test("a group holding a locked part refuses a fillet or chamfer, which would rewrite that part", { timeout: 300_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-locked-child-"));
  try {
    await withEditor(async (page, baseURL) => {
      const addBox = async () => {
        await page.getByRole("button", { name: "Add shape" }).click();
        await page.getByText("Box", { exact: true }).first().click();
      };
      const rows = page.locator(".scene-inspector-list > li.scene-row");
      const select = (index, shiftKey = false) => rows.nth(index).locator(".scene-row-name")
        .evaluate((element, shift) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: shift })), shiftKey);
      await addBox();
      await rows.first().waitFor({ state: "visible" });
      await addBox();
      await rows.nth(1).waitFor({ state: "visible" });
      await select(1);
      await select(0, true);
      await page.locator('button.toolbar-icon[aria-label="Group"]').click();
      await status(page, "Grouped 2 shapes");
      const fillet = page.locator('button.toolbar-icon[aria-label="Fillet"]');
      const chamfer = page.locator('button.toolbar-icon[aria-label="Chamfer"]');
      assert.equal(await fillet.isDisabled(), false, "a group of unlocked parts can be filleted");

      await page.getByRole("button", { name: "Export" }).click();
      await page.getByRole("radio", { name: "SKF: Editable project" }).click();
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Save SketchForge Project" }).click();
      const saved = path.join(tempDir, "group.skf");
      await (await downloadPromise).saveAs(saved);
      const edited = path.join(tempDir, "group-locked-child.skf");
      fs.writeFileSync(edited, lockFirstGroupChild(fs.readFileSync(saved)));

      await page.goto(baseURL);
      await page.getByRole("button", { name: "Open SKF or import geometry" }).click();
      await page.locator('input[type="file"][accept*=".skf"]').setInputFiles(edited);
      await rows.first().waitFor({ state: "visible", timeout: 120_000 });
      assert.equal(await rows.count(), 1, "the reopened project holds the one group");
      await select(0);
      await page.locator(".scene-inspector-list > li.scene-row.selected").first().waitFor({ state: "visible" });
      assert.equal(await fillet.isDisabled(), true, "the toolbar refuses to fillet a group holding a locked part");
      assert.equal(await chamfer.isDisabled(), true, "or to chamfer it");
      await page.screenshot({ path: "docs/screenshots/editor-locked-group-fillet.png" });
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
