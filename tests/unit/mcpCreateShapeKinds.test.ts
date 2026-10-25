import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { REQUESTABLE_SHAPE_KINDS, SHAPE_PARAMETER_NAMES } from "@constructorfleet/sketchforge-engine/shapeRequests";
// @ts-expect-error - the MCP bridge and its helpers are plain ESM scripts with no types.
import * as createShapeKinds from "../../packages/sketchforge-client/mcp/createShapeKinds.mjs";

const {
  LOCAL_SHAPE_KINDS,
  LOCAL_SOLID_KINDS,
  LOCAL_STORED_KINDS,
  STEP_KINDS,
  TAPER_KINDS,
} = createShapeKinds as Record<string, string[]>;

/**
 * `sketchforge_create_shape` advertises one schema for both modes (issue #502).
 * Every claim it makes about a kind -- that local mode builds it as a solid,
 * exports it, tapers it -- is checked here against what the local engine
 * actually does with it, by measuring the result rather than by trusting that
 * the create call returned without an error: creating a shape only stores its
 * parameters, and the solid is built when something measures or exports it.
 */

const root = path.resolve(__dirname, "../..");
const server = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const temporaryDirectories: string[] = [];

type ToolResult = { isError?: boolean; content: { text: string }[] };

function runMcp(projectsDir: string, messages: Record<string, unknown>[]) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    ...messages,
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    input,
    encoding: "utf8",
    // An STL of a torus is well over the default megabyte of captured output.
    maxBuffer: 1 << 30,
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "" },
    timeout: 240_000,
  });
  expect(run.status, run.stderr).toBe(0);
  const responses = run.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  return new Map(responses.map((response) => [response.id, response]));
}

function projectDirectory() {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-create-shape-kinds-"));
  temporaryDirectories.push(projectsDir);
  fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Kinds", createdAt: 1, revision: 1 }));
  return projectsDir;
}

function createShapeTool(projectsDir: string) {
  const tools = runMcp(projectsDir, [{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]).get(2).result.tools;
  return tools.find((tool: { name: string }) => tool.name === "sketchforge_create_shape");
}

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function text(result: ToolResult | undefined) {
  return result?.content?.[0]?.text ?? "no response";
}

/**
 * Create one shape per case, each in a project of its own, then make each of
 * the follow-up calls against every case.
 *
 * One project per case because the server answers calls concurrently, and one
 * project would turn every call after the first into a busy refusal; one
 * process per follow-up for the same reason.
 */
function createThen(cases: Record<string, Record<string, unknown>>, followUps: Record<string, (shapeId: string) => [string, Record<string, unknown>]>) {
  const projectsDir = projectDirectory();
  const labels = Object.keys(cases);
  labels.forEach((label, index) => fs.writeFileSync(path.join(projectsDir, `case-${index}.json`), JSON.stringify({ name: label, createdAt: 1, revision: 1 })));
  const created = runMcp(projectsDir, labels.map((label, index) => call(10 + index, "sketchforge_create_shape", { projectId: `case-${index}`, ...cases[label] })));
  const results = new Map<string, Record<string, ToolResult>>();
  labels.forEach((label, index) => {
    const result: ToolResult = created.get(10 + index)?.result;
    results.set(label, { create: result });
  });
  for (const [step, request] of Object.entries(followUps)) {
    const ready = labels.filter((label) => !results.get(label)!.create?.isError);
    const responses = runMcp(projectsDir, ready.map((label) => {
      const index = labels.indexOf(label);
      const shapeId = JSON.parse(results.get(label)!.create.content[0].text).shapes[0].id;
      const [tool, args] = request(shapeId);
      return call(10 + index, tool, { projectId: `case-${index}`, ...args });
    }));
    for (const label of ready) results.get(label)![step] = responses.get(10 + labels.indexOf(label))?.result;
  }
  return results;
}

const properties = (shapeId: string): [string, Record<string, unknown>] => ["sketchforge_shape_properties", { shapeId }];
const exportAs = (format: string) => (): [string, Record<string, unknown>] => ["sketchforge_export_scene", { format }];

function volumeOf(result: ToolResult | undefined) {
  if (!result || result.isError) return null;
  return JSON.parse(result.content[0].text).volume as number;
}

function centreOf(result: ToolResult) {
  const parsed = JSON.parse(result.content[0].text);
  const centre = parsed.centerOfMass ?? parsed.centroid;
  return Array.isArray(centre) ? centre : [centre.x, centre.y, centre.z];
}

/**
 * The least each kind needs to be built; the rest is defaults. A round roof's
 * exact solid is half an ellipse whose semi-axes are half the width and the
 * height, so its height may not exceed half its width.
 */
const MINIMAL_REQUEST: Record<string, Record<string, unknown>> = {
  roundRoof: { width: 20, height: 10 },
  revolve: { profile: [[4, 0], [6, 0], [6, 3], [4, 3]] },
  thread: { size: "M3", length: 3 },
};

function requestFor(kind: string) {
  return { kind, ...MINIMAL_REQUEST[kind] };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("sketchforge_create_shape kind schema", () => {
  it("lists every kind the local engine accepts, plus the editor-only sketch", () => {
    const tool = createShapeTool(projectDirectory());
    expect(tool.inputSchema.properties.kind.enum).toEqual([...REQUESTABLE_SHAPE_KINDS, "revolve", "thread", "sketch"]);
    expect(tool.inputSchema.properties.kind.description).toMatch(/sketch.*editor/i);
  });

  it("sorts every local kind into exactly one of solid and stored-only", () => {
    const sorted = [...LOCAL_SOLID_KINDS, ...LOCAL_STORED_KINDS];
    expect([...sorted].sort()).toEqual([...LOCAL_SHAPE_KINDS].sort());
  });

  it("documents every per-kind parameter the engine reads, with tube wall thickness on bevel", () => {
    const { properties: schema } = createShapeTool(projectDirectory()).inputSchema;
    const missing = SHAPE_PARAMETER_NAMES.filter((name) => !schema[name]?.description);
    expect(missing).toEqual([]);
    expect(schema.bevel.description).toMatch(/tube.*wall thickness/i);
  });

  it("measures every kind it calls a local solid with a positive volume, and exports it as STL", () => {
    const results = createThen(
      Object.fromEntries(LOCAL_SOLID_KINDS.map((kind) => [kind, requestFor(kind)])),
      { properties, stl: exportAs("stl") },
    );
    const failures = LOCAL_SOLID_KINDS.flatMap((kind) => {
      const result = results.get(kind)!;
      if (result.create?.isError) return [`${kind}: create: ${text(result.create)}`];
      const volume = volumeOf(result.properties);
      const problems = [];
      if (!(volume !== null && volume > 0)) problems.push(`${kind}: properties: ${volume ?? text(result.properties)}`);
      if (!result.stl || result.stl.isError) problems.push(`${kind}: stl: ${text(result.stl)}`);
      return problems;
    });
    expect(failures).toEqual([]);
  }, 300_000);

  it("names the stored-only kinds in the kind description, and they still behave that way", () => {
    const description: string = createShapeTool(projectDirectory()).inputSchema.properties.kind.description;
    for (const kind of LOCAL_STORED_KINDS) expect(description).toContain(kind);
    expect(description).toMatch(/stored/i);

    const results = createThen(
      Object.fromEntries(LOCAL_STORED_KINDS.map((kind) => [kind, requestFor(kind)])),
      { properties, stl: exportAs("stl") },
    );
    // If one of these starts measuring, it belongs in the solid list and the
    // description should stop warning about it.
    for (const kind of LOCAL_STORED_KINDS) {
      const result = results.get(kind)!;
      expect(result.create?.isError, `${kind}: ${text(result.create)}`).toBeFalsy();
      expect(result.properties?.isError, `${kind} measured`).toBe(true);
      expect(result.stl?.isError, `${kind} exported`).toBe(true);
    }
  }, 300_000);

  it("exports STEP for exactly the kinds it says STEP holds", () => {
    const description: string = createShapeTool(projectDirectory()).inputSchema.properties.kind.description;
    expect(description).toContain(`STEP export holds only ${STEP_KINDS.join(", ")}`);
    const results = createThen(Object.fromEntries(LOCAL_SOLID_KINDS.map((kind) => [kind, requestFor(kind)])), { step: exportAs("step") });
    const exported = LOCAL_SOLID_KINDS.filter((kind) => results.get(kind)!.step && !results.get(kind)!.step.isError);
    expect(exported).toEqual(STEP_KINDS);
  }, 300_000);

  it("builds a taper on exactly the kinds the taper parameters name", () => {
    const { properties: schema } = createShapeTool(projectDirectory()).inputSchema;
    for (const name of ["taperTopWidth", "taperTopDepth", "taperBottomWidth", "taperBottomDepth"]) {
      expect(schema[name].description).toContain(`For ${TAPER_KINDS.join(", ")} in local mode`);
      expect(schema[name].description).toMatch(/editor ignores/i);
    }
    const solidTableKinds = LOCAL_SOLID_KINDS.filter((kind) => (REQUESTABLE_SHAPE_KINDS as readonly string[]).includes(kind));
    const results = createThen(
      Object.fromEntries(solidTableKinds.map((kind) => [kind, { ...requestFor(kind), taperTopWidth: 5 }])),
      { properties },
    );
    const tapered = solidTableKinds.filter((kind) => volumeOf(results.get(kind)!.properties) !== null);
    expect(tapered).toEqual(TAPER_KINDS);
  }, 300_000);

  it("gives each kind's default side count, and says which kinds ignore it", () => {
    const description: string = createShapeTool(projectDirectory()).inputSchema.properties.sides.description;
    expect(description).toMatch(/cylinder[^.]*default 96/i);
    expect(description).toMatch(/pyramid[^.]*default 4/i);
    expect(description).toMatch(/cone and roundRoof[^.]*always round/i);

    const results = createThen({
      pyramid: { kind: "pyramid" },
      cylinder: { kind: "cylinder" },
      cone: { kind: "cone", sides: 6 },
    }, { properties });
    expect(JSON.parse(results.get("pyramid")!.create.content[0].text).shapes[0].sides).toBe(4);
    expect(JSON.parse(results.get("cylinder")!.create.content[0].text).shapes[0].sides).toBe(96);
    // A square pyramid 20 x 20 x 20 is a third of the box around it.
    expect(volumeOf(results.get("pyramid")!.properties)).toBeCloseTo(8000 / 3, 1);
    // A six-sided request still builds the true circular cone.
    expect(volumeOf(results.get("cone")!.properties)).toBeCloseTo(Math.PI * 100 * 20 / 3, 1);
  }, 120_000);

  it("says a cone stands on half its width whatever baseRadius says", () => {
    const description: string = createShapeTool(projectDirectory()).inputSchema.properties.baseRadius.description;
    expect(description).toMatch(/half (its|the) width/i);
    expect(description).toMatch(/does not change/i);
    const results = createThen({ cone: { kind: "cone", width: 20, depth: 20, height: 12, baseRadius: 5 } }, { properties });
    // Radius 10 from the width, not the 5 asked for: pi * 10^2 * 12 / 3.
    expect(volumeOf(results.get("cone")!.properties)).toBeCloseTo(Math.PI * 100 * 12 / 3, 1);
  }, 120_000);

  it("refuses sketch in local mode by saying it is editor-only", () => {
    const responses = runMcp(projectDirectory(), [call(2, "sketchforge_create_shape", {
      projectId: "case", kind: "sketch", profile: [[0, 0], [10, 0], [5, 8]], height: 4,
    })]);
    const result = responses.get(2).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/sketch.*editor/i);
    expect(result.content[0].text).not.toMatch(/unsupported_kind/);
  });

  it("uses bevel as a tube's wall thickness, clamped to leave a 0.1 mm bore", () => {
    const description: string = createShapeTool(projectDirectory()).inputSchema.properties.bevel.description;
    expect(description).toMatch(/clamped/i);
    const results = createThen({
      wall: { kind: "tube", width: 20, depth: 20, height: 10, bevel: 2, x: 5, z: -3, elevation: 1 },
      clamped: { kind: "tube", width: 20, depth: 20, height: 10, bevel: 50 },
    }, { properties });
    const wall = results.get("wall")!.properties;
    // Outer radius 10, inner radius 10 - 2 = 8, 10 tall: pi * (100 - 64) * 10.
    expect(volumeOf(wall)).toBeCloseTo(Math.PI * 36 * 10, 0);
    const [cx, cy, cz] = centreOf(wall);
    expect(cx).toBeCloseTo(5, 1);
    expect(cy).toBeCloseTo(6, 1);
    expect(cz).toBeCloseTo(-3, 1);
    // A wall of 50 on a 10 mm radius becomes 9.9, leaving a 0.1 mm bore.
    expect(volumeOf(results.get("clamped")!.properties)).toBeCloseTo(Math.PI * (100 - 0.01) * 10, 1);
  }, 120_000);
});
