import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";

/**
 * Issue #505, in an open editor. The editor's MCP bridge is the only place
 * `create_shape` had to change for `hole`: local mode already stored it. The
 * bridge route answers 404 under `next start`, so this suite runs `next dev`,
 * which builds into its own `.next-dev` and leaves the production build the
 * other browser tests use alone.
 *
 * The cut is checked by the volume and centre of mass of the exported STL, not
 * by its bounds: a cutter that came back solid would be unioned in, and the
 * bounding box of plate-plus-cylinder differs from the bored plate's only in
 * height, which a mirrored or misplaced bore would not change at all.
 */

const MCP_SERVER = path.join(process.cwd(), "packages/sketchforge-client/mcp/server.mjs");
const SCREENSHOT = "docs/screenshots/editor-mcp-results.png";

/** A 20x20x10 plate at the origin, bored through at x = 5 by a radius-3 cylinder. */
const PLATE = 20 * 20 * 10;
const REMOVED = Math.PI * 3 * 3 * 10;

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/** One MCP tool call through the stdio server, aimed at the editor at `url`. */
function callEditorMcp(url, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SKETCHFORGE_API_TOKEN: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const responses = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
      const response = responses.find((entry) => entry.id === 2);
      if (!response) return reject(new Error(`MCP returned no result for ${name}: ${stdout} ${stderr}`));
      if (response.result?.isError) return reject(new Error(`${name} failed: ${response.result.content?.[0]?.text}`));
      resolve(JSON.parse(response.result.content[0].text));
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { ...args, url } } }),
    ].join("\n") + "\n");
  });
}

/** Volume and centre of mass of a closed binary STL, by the divergence theorem. */
function stlMassProperties(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  assert.equal(bytes.byteLength, 84 + count * 50, "a binary STL");
  let volume = 0;
  const moment = [0, 0, 0];
  for (let index = 0; index < count; index += 1) {
    const base = 84 + index * 50 + 12;
    const [a, b, c] = [0, 1, 2].map((vertex) => [0, 1, 2].map((axis) => view.getFloat32(base + vertex * 12 + axis * 4, true)));
    const signed = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    volume += signed;
    for (let axis = 0; axis < 3; axis += 1) moment[axis] += signed * (a[axis] + b[axis] + c[axis]) / 4;
  }
  return { volume, centre: moment.map((value) => value / volume) };
}

async function exportedBody(url, shapeId) {
  const exported = await callEditorMcp(url, "sketchforge_export_scene", { format: "stl", shapeIds: [shapeId] });
  return stlMassProperties(new Uint8Array(Buffer.from(exported.base64, "base64")));
}

/**
 * The plate with the bore removed. The bore sits at +x, so the centre of mass
 * moves to -x by REMOVED * 5 / (PLATE - REMOVED), about 0.98 mm. Which STL axis
 * carries the plate's height depends on the exporter's up axis, so the test
 * finds the axis whose centre is 5 (half the 10 mm plate) and expects the
 * remaining horizontal axis to stay centred.
 */
function assertBoredPlate({ volume, centre }, label) {
  assert.ok(Math.abs(volume - (PLATE - REMOVED)) < REMOVED * 0.05, `${label}: volume ${volume} should be the plate less the bore, ${PLATE - REMOVED}`);
  const [cx, cy, cz] = centre;
  const expectedX = (-REMOVED * 5) / (PLATE - REMOVED);
  assert.ok(Math.abs(cx - expectedX) < 0.1, `${label}: centre x ${cx} should move away from the bore to ${expectedX}`);
  const [up, across] = Math.abs(cy - 5) < Math.abs(cz - 5) ? [cy, cz] : [cz, cy];
  assert.ok(Math.abs(Math.abs(up) - 5) < 0.1, `${label}: centre height ${up} should be half the plate`);
  assert.ok(Math.abs(across) < 0.1, `${label}: centre ${across} should stay on the plate's other axis`);
}

test("an editor creates any kind as a hole and names and colours group and cut results", { timeout: 600_000 }, async () => {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "apps/web", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: process.cwd(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8_000); });
  let browser;
  try {
    const deadline = Date.now() + 240_000;
    for (;;) {
      try { if ((await fetch(baseURL)).ok) break; } catch { /* server starting */ }
      if (server.exitCode !== null) throw new Error(`Next.js exited with ${server.exitCode}:\n${logs}`);
      if (Date.now() > deadline) throw new Error(`Next.js dev did not start:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click({ timeout: 240_000 });
    const editorDeadline = Date.now() + 120_000;
    while ((await callEditorMcp(baseURL, "sketchforge_list_editors", {})).editors?.length !== 1) {
      if (Date.now() > editorDeadline) throw new Error("the editor never registered with the MCP bridge");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const create = async (args) => (await callEditorMcp(baseURL, "sketchforge_create_shape", args)).object;
    const plateAndBore = async (bore) => ({
      plate: await create({ kind: "box", width: 20, depth: 20, height: 10, elevation: 0 }),
      bore: await create({ kind: "cylinder", width: 6, depth: 6, height: 20, x: 5, elevation: -5, ...bore }),
    });

    // A box and a cylinder are not revolves: before #505 the editor dropped
    // their `hole`, and grouping unioned the cutter in.
    const boxCutter = await create({ kind: "box", width: 2, depth: 2, height: 2, x: 40, hole: true });
    assert.equal(boxCutter.hole, true, "a box created with hole: true is a cutter");
    await callEditorMcp(baseURL, "sketchforge_delete_objects", { ids: [boxCutter.id] });

    const first = await plateAndBore({ hole: true });
    assert.equal(first.bore.hole, true, "a cylinder created with hole: true is a cutter");
    const grouped = (await callEditorMcp(baseURL, "sketchforge_group_objects", {
      ids: [first.plate.id, first.bore.id], name: "Socket plate", color: "#2a9d8f",
    })).object;
    assert.equal(grouped.name, "Socket plate");
    assert.equal(grouped.color, "#2a9d8f");
    assertBoredPlate(await exportedBody(baseURL, grouped.id), "group_objects");
    await callEditorMcp(baseURL, "sketchforge_update_object", { id: grouped.id, x: -30 });

    const second = await plateAndBore({});
    const cut = (await callEditorMcp(baseURL, "sketchforge_boolean_cut", {
      solidIds: [second.plate.id], holeIds: [second.bore.id], name: "Bored plate", color: "#264653",
    })).object;
    assert.equal(cut.name, "Bored plate");
    assert.equal(cut.color, "#264653");
    assertBoredPlate(await exportedBody(baseURL, cut.id), "boolean_cut");

    const scene = await callEditorMcp(baseURL, "sketchforge_list_objects", {});
    const names = (scene.objects ?? scene).map((object) => object.name);
    assert.deepEqual([...names].sort(), ["Bored plate", "Socket plate"]);

    fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true });
    await page.getByText("Socket plate").first().waitFor({ state: "visible" });
    await page.screenshot({ path: SCREENSHOT, fullPage: true });
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      try { if (process.platform === "win32") server.kill("SIGTERM"); else process.kill(-server.pid, "SIGTERM"); } catch { /* server already exited */ }
    }
  }
});
