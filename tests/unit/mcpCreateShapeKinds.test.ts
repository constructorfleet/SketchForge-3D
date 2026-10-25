import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { REQUESTABLE_SHAPE_KINDS, SHAPE_PARAMETER_NAMES } from "@constructorfleet/sketchforge-engine/shapeRequests";

/**
 * `sketchforge_create_shape` advertises one schema for both modes (issue #502):
 * every kind it lists must be buildable by the mode the description says
 * builds it, and every per-kind parameter the engine reads must be named.
 */

const root = path.resolve(__dirname, "../..");
const server = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const temporaryDirectories: string[] = [];

function runMcp(projectsDir: string, messages: Record<string, unknown>[]) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    ...messages,
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "" },
    timeout: 120_000,
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

/** The least each kind needs to be built; the rest is defaults. */
const MINIMAL_REQUEST: Record<string, Record<string, unknown>> = {
  revolve: { profile: [[4, 0], [6, 0], [6, 3], [4, 3]] },
  thread: { size: "M3", length: 3 },
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("sketchforge_create_shape kind schema", () => {
  it("lists every kind the local engine builds, plus the editor-only sketch", () => {
    const tool = createShapeTool(projectDirectory());
    expect(tool.inputSchema.properties.kind.enum).toEqual([...REQUESTABLE_SHAPE_KINDS, "revolve", "thread", "sketch"]);
    expect(tool.inputSchema.properties.kind.description).toMatch(/sketch.*editor/i);
  });

  it("documents every per-kind parameter the engine reads, with tube wall thickness on bevel", () => {
    const { properties } = createShapeTool(projectDirectory()).inputSchema;
    const missing = SHAPE_PARAMETER_NAMES.filter((name) => !properties[name]?.description);
    expect(missing).toEqual([]);
    expect(properties.bevel.description).toMatch(/tube.*wall thickness/i);
  });

  it("builds every advertised kind except sketch in local mode", () => {
    const projectsDir = projectDirectory();
    const kinds: string[] = createShapeTool(projectsDir).inputSchema.properties.kind.enum.filter((kind: string) => kind !== "sketch");
    // One project per kind: the server answers calls concurrently, and one
    // project would turn every call after the first into a busy refusal.
    for (const kind of kinds) fs.writeFileSync(path.join(projectsDir, `kind-${kind}.json`), JSON.stringify({ name: kind, createdAt: 1, revision: 1 }));
    const responses = runMcp(projectsDir, kinds.map((kind, index) => call(10 + index, "sketchforge_create_shape", {
      projectId: `kind-${kind}`, kind, ...MINIMAL_REQUEST[kind],
    })));
    const failures = kinds
      .map((kind, index) => ({ kind, result: responses.get(10 + index)?.result }))
      .filter(({ result }) => !result || result.isError)
      .map(({ kind, result }) => `${kind}: ${result?.content?.[0]?.text ?? "no response"}`);
    expect(failures).toEqual([]);
  }, 180_000);

  it("refuses sketch in local mode by saying it is editor-only", () => {
    const responses = runMcp(projectDirectory(), [call(2, "sketchforge_create_shape", {
      projectId: "case", kind: "sketch", profile: [[0, 0], [10, 0], [5, 8]], height: 4,
    })]);
    const result = responses.get(2).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/sketch.*editor/i);
    expect(result.content[0].text).not.toMatch(/unsupported_kind/);
  });

  it("uses bevel as a tube's wall thickness", () => {
    const projectsDir = projectDirectory();
    const created = runMcp(projectsDir, [call(2, "sketchforge_create_shape", {
      projectId: "case", kind: "tube", width: 20, depth: 20, height: 10, bevel: 2, x: 5, z: -3, elevation: 1,
    })]).get(2);
    expect(created.result.isError).toBeUndefined();
    const shapeId = JSON.parse(created.result.content[0].text).shapes[0].id;
    const properties = JSON.parse(runMcp(projectsDir, [call(3, "sketchforge_shape_properties", { projectId: "case", shapeId })]).get(3).result.content[0].text);
    // Outer radius 10, inner radius 10 - 2 = 8, 10 tall: pi * (100 - 64) * 10.
    expect(properties.volume).toBeCloseTo(Math.PI * 36 * 10, 0);
    const centre = properties.centerOfMass ?? properties.centroid;
    expect(centre).toBeDefined();
    const [cx, cy, cz] = Array.isArray(centre) ? centre : [centre.x, centre.y, centre.z];
    expect(cx).toBeCloseTo(5, 1);
    expect(cy).toBeCloseTo(6, 1);
    expect(cz).toBeCloseTo(-3, 1);
  }, 60_000);
});
