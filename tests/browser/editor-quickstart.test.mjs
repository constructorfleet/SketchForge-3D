import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopNextServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform === "win32") server.kill(name);
      else process.kill(-server.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };

  signal("SIGTERM");
  if (!(await waitForChildExit(server, 5_000))) {
    signal("SIGKILL");
    await waitForChildExit(server, 5_000);
  }
  assert.ok(server.exitCode !== null || server.signalCode !== null, "Next.js server process should exit after termination");
}

async function waitForServer(url, server, getLogs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${getLogs()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js did not become ready:\n${getLogs()}`);
}

test("a new user can sketch, extrude, save, and export a model", { timeout: 120_000 }, async () => {
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
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click();

    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Extrude sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish sketch" }).click();
    await page.getByRole("status").getByText("Exact sketch created at 10 mm height", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("Sketch extrusion").first().waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "Edit sketch", exact: true }).click();
    await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "visible" });
    const sketchSegments = page.locator('[data-sketch-entity="segment"]');
    assert.equal(await sketchSegments.count(), 4, "the initial rectangle is made of four sketch segments");
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Circle" }).click();
    assert.ok(await sketchSegments.count() > 4, "adding a circle should add sketch segments");
    await page.getByRole("button", { name: "Finish sketch", exact: true }).click();
    await page.getByRole("status").getByText("Sketch updated", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
    await page.screenshot({ path: "docs/screenshots/parametric-extrusion-rebuilt-solid.png" });

    await page.getByRole("tab", { name: "Sketch" }).click();
    await page.getByRole("button", { name: "Sketch to 3D options" }).click();
    await page.getByRole("menuitem", { name: /Revolve sketch/ }).click();
    await page.getByRole("button", { name: "Add sketch shape" }).click();
    await page.getByRole("menuitem", { name: "Rectangle" }).click();
    await page.getByRole("button", { name: "Finish revolve" }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Edit sketch", exact: true }).click();
    await page.getByRole("button", { name: "Finish revolve", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: "docs/screenshots/parametric-revolve-edit-sketch.png" });
    await page.getByRole("button", { name: "Finish revolve", exact: true }).click();
    await page.getByRole("button", { name: "Finish revolve", exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByRole("button", { name: "Sketch revolve", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: "docs/screenshots/parametric-revolve-rebuilt-solid.png" });

    const projectName = page.getByRole("textbox", { name: "Project name" });
    await projectName.fill("Quick-start block");
    await projectName.press("Enter");
    const reloadResponse = await page.reload();
    assert.equal(reloadResponse?.status(), 200, "Reloading the saved project should return a successful editor page");
    await page.getByText("Sketch extrusion").first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByRole("textbox", { name: "Project name" }).inputValue(), "Quick-start block");

    await page.getByRole("button", { name: "Sketch extrusion", exact: true }).click();
    await page.getByRole("button", { name: "Center view on selection" }).click();
    await page.getByRole("button", { name: "Edit sketch", exact: true }).click();
    await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "visible" });
    assert.ok(await page.locator('[data-sketch-entity="segment"]').count() > 4, "the added circle should remain after reloading the saved project");
    await page.screenshot({ path: "docs/screenshots/parametric-extrusion-edit-sketch.png" });
    await page.getByRole("button", { name: "Finish sketch", exact: true }).click();
    await page.getByRole("status").getByText("Sketch updated", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.mouse.click(160, 170);
    await page.screenshot({ path: "docs/screenshots/editor-quickstart-solid.png" });

    await page.getByRole("button", { name: "Export" }).click();
    const skfFormat = page.getByRole("radio", { name: "SKF: Editable project" });
    await skfFormat.click();
    assert.equal(await skfFormat.getAttribute("aria-checked"), "true");
    await page.waitForTimeout(200);
    await page.screenshot({ path: "docs/screenshots/editor-quickstart-export.png" });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save SketchForge Project" }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.skf$/);
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server.pid) await stopNextServer(server);
  }
});

test("a STEP assembly exported from the editor can be imported and exploded through local MCP", { timeout: 300_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-step-editor-mcp-"));
  const projectsDir = path.join(tempDir, "mcp-projects");
  const packagePath = path.join(projectsDir, "nested-assembly.skf");
  const fixturePath = path.join(process.cwd(), "tests/fixtures/step/nested-assembly.step");
  fs.mkdirSync(projectsDir, { recursive: true });
  const allowedFixturePath = path.join(projectsDir, path.basename(fixturePath));
  fs.copyFileSync(fixturePath, allowedFixturePath);
  const mcpServer = path.join(process.cwd(), "packages/sketchforge-client/mcp/server.mjs");
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  let browser;

  const callLocalMcp = (id, name, args) => {
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    ].join("\n") + "\n";
    const result = spawnSync(process.execPath, [mcpServer], {
      cwd: process.cwd(),
      input,
      encoding: "utf8",
      env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_MCP_FILES_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "http://127.0.0.1:1" },
      timeout: 180_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const responses = result.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
    assert.ok(responses.length > 1, `MCP returned no tool result; stdout: ${result.stdout}; stderr: ${result.stderr}`);
    const response = responses.find((entry) => entry.id === id);
    assert.ok(response, `MCP omitted response id ${id}: ${result.stdout}`);
    assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
    return JSON.parse(response.result.content[0].text);
  };

  try {
    await waitForServer(baseURL, server, () => logs);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Open SKF or import geometry" }).click();
    await page.locator('input[type="file"][accept*=".step"]').setInputFiles(allowedFixturePath);
    await page.getByRole("textbox", { name: "Project name" }).waitFor({ state: "visible", timeout: 120_000 });
    assert.equal(await page.getByRole("textbox", { name: "Project name" }).inputValue(), "nested-assembly");
    await page.getByRole("button", { name: "nested-assembly", exact: true }).click();
    await page.getByRole("button", { name: "Center view on selection" }).click();
    await page.screenshot({ path: "docs/screenshots/step-assembly-editor-import.png" });

    await page.getByRole("button", { name: "Export" }).click();
    const skfFormat = page.getByRole("radio", { name: "SKF: Editable project" });
    await skfFormat.click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save SketchForge Project" }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.skf$/);
    await download.saveAs(packagePath);
    assert.ok(fs.statSync(packagePath).size > 0, "the editor should produce the package passed to MCP");
    await context.close();

    const imported = callLocalMcp(2, "sketchforge_import_project", { filePath: packagePath, name: "Nested STEP assembly" });
    assert.equal(imported.shapeCount, 1);
    const scene = callLocalMcp(3, "sketchforge_read_scene", { projectId: imported.projectId });
    assert.equal(scene.objects.length, 1);
    const exploded = callLocalMcp(4, "sketchforge_explode_step_assembly", {
      projectId: imported.projectId,
      shapeId: scene.objects[0].id,
    });
    assert.equal(exploded.shapes.length, 1);
    const rootGroup = exploded.shapes[0];
    assert.equal(rootGroup.name, "MainAssembly");
    assert.deepEqual(rootGroup.groupedShapes.map((part) => part.name), ["Frame", "Sensors"]);
    const sensors = rootGroup.groupedShapes.find((part) => part.name === "Sensors");
    assert.deepEqual(sensors.groupedShapes.map((part) => part.name), ["SensorLeft", "SensorRight"]);
    const leaves = [rootGroup.groupedShapes[0], ...sensors.groupedShapes];
    const leafMetadata = Object.fromEntries(leaves.map(({ name, importedMesh, stepComponent }) => [name, {
      hasBrepStep: importedMesh?.hasBrepStep,
      componentId: stepComponent?.id,
      occurrenceId: stepComponent?.occurrenceId,
      path: stepComponent?.path,
    }]));
    assert.deepEqual(leafMetadata, {
      Frame: {
        hasBrepStep: true,
        componentId: "step-occurrence:2/solid-1",
        occurrenceId: "step-occurrence:2",
        path: [
          { id: "step-node:1", name: "MainAssembly" },
          { id: "step-occurrence:2", name: "Frame" },
        ],
      },
      SensorLeft: {
        hasBrepStep: true,
        componentId: "step-occurrence:4/solid-1",
        occurrenceId: "step-occurrence:4",
        path: [
          { id: "step-node:1", name: "MainAssembly" },
          { id: "step-occurrence:7", name: "Sensors" },
          { id: "step-occurrence:4", name: "SensorLeft" },
        ],
      },
      SensorRight: {
        hasBrepStep: true,
        componentId: "step-occurrence:6/solid-1",
        occurrenceId: "step-occurrence:6",
        path: [
          { id: "step-node:1", name: "MainAssembly" },
          { id: "step-occurrence:7", name: "Sensors" },
          { id: "step-occurrence:6", name: "SensorRight" },
        ],
      },
    });
    assert.ok(fs.existsSync(path.join(projectsDir, `${imported.projectId}.skf`)));
    assert.ok(fs.existsSync(path.join(projectsDir, `${imported.projectId}.json`)));
  } finally {
    if (browser) await browser.close();
    try {
      if (server.pid) await stopNextServer(server);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      assert.equal(fs.existsSync(tempDir), false, "the editor download and local MCP projects should be cleaned up");
    }
  }
});

test("an imported STEP assembly explodes into nested groups from the shape inspector, as one undo step", { timeout: 300_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--port", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fixturePath = path.join(process.cwd(), "tests/fixtures/step/nested-assembly.step");
  let logs = "";
  const keepLogs = (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); };
  server.stdout.on("data", keepLogs);
  server.stderr.on("data", keepLogs);
  let browser;

  try {
    await waitForServer(baseURL, server, () => logs);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Open SKF or import geometry" }).click();
    await page.locator('input[type="file"][accept*=".step"]').setInputFiles(fixturePath);
    await page.getByRole("textbox", { name: "Project name" }).waitFor({ state: "visible", timeout: 120_000 });

    const scene = page.getByRole("complementary", { name: "Scene" });
    const sceneLabels = () => scene.locator(".scene-row-label").allInnerTexts();
    await scene.getByRole("button", { name: "nested-assembly", exact: true }).click();
    const explode = page.getByRole("button", { name: "Explode Assembly", exact: true });
    await explode.waitFor({ state: "visible" });
    await explode.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/screenshots/step-assembly-editor-explode-action.png" });
    await explode.click();
    await page.getByRole("status").getByText("Exploded nested-assembly into nested groups", { exact: true }).waitFor({ state: "visible", timeout: 120_000 });

    // The imported mesh is replaced by one root group; its members are rows
    // the scene inspector shows as each group is expanded.
    assert.deepEqual(await sceneLabels(), ["MainAssembly"]);
    // The selected group's settings fill the column; minimize them to give
    // the scene list room for the expanded tree.
    await page.getByRole("button", { name: "Minimize shape settings", exact: true }).click();
    await scene.getByRole("button", { name: "Show what MainAssembly groups", exact: true }).click();
    assert.deepEqual(await sceneLabels(), ["MainAssembly", "Frame", "Sensors"]);
    await scene.getByRole("button", { name: "Show what Sensors groups", exact: true }).click();
    assert.deepEqual(await sceneLabels(), ["MainAssembly", "Frame", "Sensors", "SensorLeft", "SensorRight"]);
    await page.getByRole("button", { name: "Center view on selection" }).click();
    await page.screenshot({ path: "docs/screenshots/step-assembly-editor-exploded.png" });

    // One undo returns the imported assembly; one redo brings the groups back.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await scene.getByRole("button", { name: "nested-assembly", exact: true }).waitFor({ state: "visible" });
    assert.deepEqual(await sceneLabels(), ["nested-assembly"]);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await scene.locator(".scene-row-label", { hasText: "MainAssembly" }).waitFor({ state: "visible" });
    const redone = await sceneLabels();
    assert.equal(redone[0], "MainAssembly");
    assert.ok(!redone.includes("nested-assembly"), `redo should replace the imported assembly: ${redone.join(", ")}`);
  } finally {
    if (browser) await browser.close();
    if (server.pid) await stopNextServer(server);
  }
});
