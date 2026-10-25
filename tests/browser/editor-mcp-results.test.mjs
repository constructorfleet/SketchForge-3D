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

/**
 * Issue #540, in an open editor. A fillet the editor applies to cap edges of a
 * straight sketch extrusion records the sketch segment and cap of each edge,
 * as the REST path does (#350), so editing the sketch afterwards rounds the
 * same edges of the rebuilt part instead of dropping the fillet.
 *
 * The treatment is applied through the editor's MCP bridge, which shares the
 * Fillet tool's recording, so the edges can be named by their geometry rather
 * than by clicks on a canvas. It lives in this file because it needs `next
 * dev` too, and two dev servers started at once by `node --test` would fight
 * over the same `.next-dev` directory; tests in one file run one at a time.
 *
 * The part is judged by the volume and the centre of mass of the exported
 * STL, never by its bounds, which a rounded edge does not change. Volume
 * alone cannot tell the caps apart either: rounding the two bottom edges
 * removes as much as rounding the two top ones. Where it is removed can --
 * the top fillets lower the centre below half the height, the bottom ones
 * would raise it -- so the height of the centre is checked against what
 * removing that volume `FILLET_CENTRE_DEPTH` below the top would give.
 * Exact volume and centre of mass of the replay, against a closed form, are
 * covered by tests/unit/editorEdgeTreatmentLineage.test.ts on the kernel.
 */

const SIDE = 20;
const HEIGHT = 10;
const RADIUS = 2;
/** Two straight fillets of `RADIUS` along X-running edges each `length` long. */
const removedBy = (length) => length * RADIUS * RADIUS * (1 - Math.PI / 4);
/** How far below the rounded edge's cap the centroid of the material a fillet removes lies. */
const FILLET_CENTRE_DEPTH = (RADIUS * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);

/**
 * The height of the centre of a part rounded on its top edges, from the
 * centre `plainCentre` and volume `plain` of the same outline unrounded and
 * the rounded part's own volume: the removed material sat just under the top.
 */
function topRoundedCentre(plain, plainCentre, rounded) {
  return (plain * plainCentre - (plain - rounded) * (HEIGHT - FILLET_CENTRE_DEPTH)) / rounded;
}

/**
 * Open the selected shape's sketch, drag its lower-right corner by the same
 * screen offset each time, and finish -- with a double click when `impatient`,
 * as someone does when the rebuild takes a moment.
 */
async function editSketchCorner(page, { impatient = false } = {}) {
  const edit = page.getByRole("button", { name: "Edit sketch", exact: true });
  if (!(await edit.isVisible())) await page.getByRole("tab", { name: "Sketch" }).click();
  await edit.click();
  await page.getByRole("button", { name: "Finish sketch", exact: true }).waitFor({ state: "visible" });
  const sketchCorners = () => page.locator('[data-sketch-entity="point"]').evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }));
  const corners = await sketchCorners();
  assert.equal(corners.length, 4, "the rectangle should have four editable corners");
  const corner = corners.reduce((best, point) => point.x + point.y > best.x + best.y ? point : best);
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 30, corner.y + 10, { steps: 6 });
  await page.mouse.up();
  const moved = await sketchCorners();
  assert.ok(moved.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) > 10), "the drag should move the corner");
  const finish = page.getByRole("button", { name: "Finish sketch", exact: true });
  if (impatient) await finish.dblclick();
  else await finish.click();
}

test("an editor fillet on sketch cap edges records lineage and survives a sketch edit, undo and redo", { timeout: 600_000 }, async () => {
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
    await page.route("**/api/app-update**", (route) => route.abort());
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Create new 3D design" }).click({ timeout: 240_000 });
    const editorDeadline = Date.now() + 120_000;
    while ((await callEditorMcp(baseURL, "sketchforge_list_editors", {})).editors?.length !== 1) {
      if (Date.now() > editorDeadline) throw new Error("the editor never registered with the MCP bridge");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const status = page.getByRole("status");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    const object = async (id) => ((scene) => scene.objects ?? scene)(await callEditorMcp(baseURL, "sketchforge_list_objects", {})).find((entry) => entry.id === id);
    const massProperties = async (id) => {
      const exported = await callEditorMcp(baseURL, "sketchforge_export_scene", { format: "stl", shapeIds: [id] });
      return stlMassProperties(new Uint8Array(Buffer.from(exported.base64, "base64")));
    };
    const volume = async (id) => (await massProperties(id)).volume;
    const volumeWhen = async (id, check, message) => {
      const until = Date.now() + 30_000;
      let last;
      while (Date.now() < until) {
        last = await volume(id);
        if (check(last)) return last;
        await page.waitForTimeout(250);
      }
      assert.fail(`${message}: ${last}`);
    };

    const half = SIDE / 2;
    const created = (await callEditorMcp(baseURL, "sketchforge_create_shape", {
      kind: "sketch", height: HEIGHT, profile: [[-half, -half], [half, -half], [half, half], [-half, half]],
    })).object;
    const bare = SIDE * SIDE * HEIGHT;
    const bareBody = await massProperties(created.id);
    assert.ok(Math.abs(bareBody.volume - bare) < 0.5, "the bare extrusion");
    // Which STL axis carries the height depends on the exporter's up axis: it
    // is the one whose centre is half the height, the footprint being centred.
    const up = bareBody.centre.findIndex((value) => Math.abs(Math.abs(value) - HEIGHT / 2) < 0.01);
    assert.ok(up >= 0, `one axis of the bare extrusion's centre is half its height: ${bareBody.centre}`);
    const centreHeight = async (id) => Math.abs((await massProperties(id)).centre[up]);

    // The same corner drag on the untreated part, then undone: what the edit
    // does to the solid before any fillet is replayed on it.
    await editSketchCorner(page);
    await status.getByText("Sketch updated", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    const plainEdited = await volumeWhen(created.id, (value) => Math.abs(value - bare) > 1, "the corner drag should change the extrusion");
    const plainEditedCentre = await centreHeight(created.id);
    assert.ok(Math.abs(plainEditedCentre - HEIGHT / 2) < 0.01, `an unrounded prism's centre is at half its height: ${plainEditedCentre}`);
    await undo.click();
    await volumeWhen(created.id, (value) => Math.abs(value - bare) < 0.5, "undo should restore the rectangle");

    // The two top edges that run along X: both ends on the top cap, at one z.
    const listed = await callEditorMcp(baseURL, "sketchforge_list_edges", { id: created.id });
    const ends = (edge) => [edge.points.slice(0, 3), edge.points.slice(-3)];
    const top = Math.max(...listed.edges.flatMap((edge) => ends(edge).map((point) => point[1])));
    const topAlongX = listed.edges.filter((edge) => listed.selectableEdgeIds.includes(edge.id) && ends(edge).every((point) => Math.abs(point[1] - top) < 1e-3)
      && Math.abs(ends(edge)[0][2] - ends(edge)[1][2]) < 1e-3);
    assert.equal(topAlongX.length, 2, `two top edges run along X: ${JSON.stringify(listed.edges.map(ends))}`);

    const applied = await callEditorMcp(baseURL, "sketchforge_apply_edge_treatment", {
      id: created.id, kind: "fillet", amount: RADIUS, edgeIds: topAlongX.map((edge) => edge.id),
    });
    const [feature] = applied.object.edgeTreatments;
    assert.equal(applied.object.edgeTreatments.length, 1);
    assert.equal(feature.edgeCount, 2);
    assert.ok(Array.isArray(feature.sourceEdges), `the fillet records sketch-segment lineage: ${JSON.stringify(feature)}`);
    assert.equal(feature.sourceEdges.length, 2);
    assert.deepEqual(feature.sourceEdges.map((edge) => edge.cap), ["top", "top"]);
    assert.equal(new Set(feature.sourceEdges.map((edge) => edge.segmentId)).size, 2, "two different segments");
    const filleted = bare - removedBy(2 * SIDE);
    const treatedVolume = await volumeWhen(created.id, (value) => Math.abs(value - filleted) < 2, `the fillet removes ${removedBy(2 * SIDE)} mm3`);
    const treatedCentre = await centreHeight(created.id);
    assert.ok(Math.abs(treatedCentre - topRoundedCentre(bare, HEIGHT / 2, treatedVolume)) < 0.005,
      `the fillet rounds the top edges, lowering the centre: ${treatedCentre}, expected ${topRoundedCentre(bare, HEIGHT / 2, treatedVolume)}`);

    // The same edit, now on the filleted part: the fillet is replayed on the
    // edited outline. Its removal is the plain edit less the same two rounded
    // edges, one of which the drag lengthened or shortened. Finish is pressed
    // twice while the replay runs; the edit must still be one undo step.
    await editSketchCorner(page, { impatient: true });
    await status.getByText("Sketch updated", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    const replayed = await volumeWhen(created.id, (value) => Math.abs(value - treatedVolume) > 1, "the sketch edit should rebuild the part");
    const removed = plainEdited - replayed;
    assert.ok(removed > removedBy(SIDE) * 1.2 && removed < removedBy(2 * SIDE) * 2,
      `the replayed fillet rounds two top edges of the edited part: removed ${removed}, plain ${plainEdited}, replayed ${replayed}`);
    // Replayed on the bottom cap it would remove as much, and raise the centre
    // by about as far as the top lowers it.
    const replayedCentre = await centreHeight(created.id);
    const expectedCentre = topRoundedCentre(plainEdited, plainEditedCentre, replayed);
    assert.ok(replayedCentre < HEIGHT / 2 - 0.02 && Math.abs(replayedCentre - expectedCentre) < 0.005,
      `the replay rounds the top edges of the edited part: centre ${replayedCentre}, expected ${expectedCentre}`);
    const replayedObject = await object(created.id);
    assert.equal(replayedObject.edgeTreatments.length, 1, "the fillet survives the sketch edit");
    assert.deepEqual(replayedObject.edgeTreatments[0].sourceEdges, feature.sourceEdges, "with the same lineage");
    assert.equal(replayedObject.edgeTreatments[0].edgeCount, 2);
    await page.screenshot({ path: path.join(process.env.SKETCHFORGE_SCREENSHOT_DIR ?? "test-results", "edge-treatment-lineage-replayed.png") });

    await undo.click();
    await volumeWhen(created.id, (value) => Math.abs(value - treatedVolume) < 0.5, "undo should restore the filleted rectangle");
    assert.deepEqual((await object(created.id)).edgeTreatments[0].sourceEdges, feature.sourceEdges, "undo keeps the lineage");
    await redo.click();
    await volumeWhen(created.id, (value) => Math.abs(value - replayed) < 0.5, "redo should restore the replayed fillet");
    assert.deepEqual((await object(created.id)).edgeTreatments[0].sourceEdges, feature.sourceEdges, "redo keeps the lineage");
  } finally {
    if (browser) await browser.close();
    if (server.exitCode === null) {
      try { if (process.platform === "win32") server.kill("SIGTERM"); else process.kill(-server.pid, "SIGTERM"); } catch { /* server already exited */ }
    }
  }
});
