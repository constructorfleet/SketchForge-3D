import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { projectAssetFromBytes } from "@constructorfleet/sketchforge-engine/projectAssets";
import { exportSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { importedShapeFromStepOnKernel } from "@constructorfleet/sketchforge-engine/stepImportKernel";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { RevolveShapeRequest, ThreadShapeRequest } from "../../packages/sketchforge-client/src/types";

const root = path.resolve(__dirname, "../..");
const server = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const temporaryDirectories: string[] = [];

function callMcp(projectsDir: string, id: number, name: string, args: Record<string, unknown>, extraEnvironment: Record<string, string> = {}, timeoutMs = 30_000) {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  ].join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "http://127.0.0.1:1", ...extraEnvironment },
    timeout: timeoutMs,
  });
  expect(run.status, run.stderr).toBe(0);
  const output = run.stdout.trim();
  expect(output, `MCP returned no JSON; stderr: ${run.stderr}; error: ${run.error}`).not.toBe("");
  return output.split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
}

function listMcpTools(projectsDir: string) {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  ].join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "" },
    timeout: 30_000,
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim().split(/\r?\n/)[1]).result.tools;
}

function callMcpAsync(projectsDir: string, name: string, args: Record<string, unknown>, extraEnvironment: Record<string, string> = {}) {
  return new Promise<Record<string, any>[]>((resolve, reject) => {
    const child = spawn(process.execPath, [server], {
      cwd: root,
      env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "", ...extraEnvironment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`MCP exited with ${code}: ${stderr}`));
      try {
        resolve(stdout.trim().split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    ].join("\n") + "\n");
  });
}

describe("local MCP engine mode", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("lists projects from the configured local directory", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    fs.writeFileSync(path.join(projectsDir, "other.json"), JSON.stringify({ name: "Other project", createdAt: 2, revision: 3 }));

    const tools = listMcpTools(projectsDir);
    expect(tools.some((tool: { name: string }) => tool.name === "sketchforge_list_projects")).toBe(true);
    const response = callMcp(projectsDir, 2, "sketchforge_list_projects", {});
    expect(response[1].result.isError).toBeUndefined();
    expect(JSON.parse(response[1].result.content[0].text).projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "case", name: "Local case" }),
      expect.objectContaining({ id: "other", name: "Other project" }),
    ]));

    const created = callMcp(projectsDir, 3, "sketchforge_create_project", { name: "Fresh project" });
    expect(created[1].result.isError).toBeUndefined();
    expect(JSON.parse(created[1].result.content[0].text)).toMatchObject({ name: "Fresh project", shapeCount: 0, revision: 1 });
  });

  it("lists and runs per-shape properties locally with geometry provenance", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const tool = listMcpTools(projectsDir).find((candidate: { name: string }) => candidate.name === "sketchforge_shape_properties");
    expect(tool.inputSchema.required).toEqual(["projectId", "shapeId"]);
    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", kind: "box", width: 4, depth: 5, height: 6 });
    const shapeId = JSON.parse(created[1].result.content[0].text).shapes[0].id;
    const read = callMcp(projectsDir, 3, "sketchforge_shape_properties", { projectId: "case", shapeId });
    expect(read[1].result.isError).toBeUndefined();
    expect(JSON.parse(read[1].result.content[0].text)).toMatchObject({ volume: 120, area: 148, provenance: { source: "parametric", precision: "exact" } });
  }, 60_000);

  it("measures and exports a group of solids as their union (#500)", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const shapeId = (response: Record<string, any>[]) => JSON.parse(response[1].result.content[0].text).shapes[0].id;
    const large = shapeId(callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", kind: "cylinder", width: 20, depth: 20, height: 10 }));
    const small = shapeId(callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", kind: "cylinder", width: 10, depth: 10, height: 10, x: 10, elevation: 5 }));
    const grouped = callMcp(projectsDir, 2, "sketchforge_group_objects", { projectId: "case", ids: [large, small] });
    expect(grouped[1].result.isError).toBeUndefined();
    const groupId = JSON.parse(grouped[1].result.content[0].text).shape.id;

    const read = callMcp(projectsDir, 3, "sketchforge_shape_properties", { projectId: "case", shapeId: groupId });
    expect(read[1].result.isError, read[1].result.content[0].text).toBeUndefined();
    const properties = JSON.parse(read[1].result.content[0].text);
    // The two cylinders' volumes less their 5mm-tall lens of overlap, counted once.
    const lens = 100 * Math.acos(175 / 200) + 25 * Math.acos(25 / 100) - 0.5 * Math.sqrt(5 * 15 * 5 * 25);
    expect(properties.volume).toBeCloseTo(Math.PI * 1250 - lens * 5, 3);
    expect(properties.provenance).toEqual({ source: "parametric", precision: "exact" });

    const exportPath = path.join(projectsDir, "union.stl");
    const exported = callMcp(projectsDir, 4, "sketchforge_export_scene", { projectId: "case", format: "stl", outputPath: exportPath, overwrite: true });
    expect(exported[1].result.isError, exported[1].result.content[0].text).toBeUndefined();
    expect(fs.statSync(exportPath).size).toBeGreaterThan(0);
  }, 60_000);

  it("keeps a partial-sweep revolve about its axis rather than its box (#503)", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", {
      projectId: "case", kind: "revolve", profile: [[50, 0], [75, 0], [75, 10], [50, 10]], sweepAngle: 90,
    });
    expect(created[1].result.isError).toBeUndefined();
    const shape = JSON.parse(created[1].result.content[0].text).shapes[0];
    expect(shape.revolveAxis).toEqual({ x: expect.closeTo(0, 6), z: expect.closeTo(0, 6) });

    const read = callMcp(projectsDir, 3, "sketchforge_shape_properties", { projectId: "case", shapeId: shape.id });
    const properties = JSON.parse(read[1].result.content[0].text);
    // A quarter of an annulus 50..75 swept from +X towards -Z about the origin.
    const sectorRadius = (2 * Math.sin(Math.PI / 4) / (3 * Math.PI / 4)) * (75 ** 3 - 50 ** 3) / (75 ** 2 - 50 ** 2);
    expect(properties.volume).toBeGreaterThan((Math.PI / 4) * (75 ** 2 - 50 ** 2) * 10 * 0.99);
    expect(properties.centerOfMass.x).toBeCloseTo(sectorRadius * Math.SQRT1_2, 0);
    expect(properties.centerOfMass.z).toBeCloseTo(-sectorRadius * Math.SQRT1_2, 0);
  }, 60_000);

  it("advertises and honours a revolve's resolution on create_shape (#504)", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const tool = listMcpTools(projectsDir).find((candidate: { name: string }) => candidate.name === "sketchforge_create_shape");
    // An agent only sends what the schema offers, so the sweep's resolution has
    // to be advertised for revolves rather than only for prisms.
    // Match the revolve clauses themselves, so a description that merely
    // mentions revolves (or says they are unsupported) does not pass.
    expect(tool.inputSchema.properties.sides.description).toMatch(/revolve\/thread: facets per full turn of the sweep, 3-512 \(default 64\)/);
    expect(tool.inputSchema.properties.quality).toMatchObject({
      type: "number",
      description: expect.stringMatching(/revolve\/thread: how finely curved segments of the profile are sampled, 1-10 \(default 6\)/),
    });

    const ring: RevolveShapeRequest = { kind: "revolve", profile: [[50, 0], [75, 0], [75, 10], [50, 10]], sides: 256, quality: 8 };
    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", ...ring });
    expect(created[1].result.isError).toBeUndefined();
    const shape = JSON.parse(created[1].result.content[0].text).shapes[0];
    expect(shape.sketchRevolve).toMatchObject({ sides: 256, quality: 8 });

    // `sides` reaches the stored sweep: an STL export writes that mesh, a
    // 256-gon annulus of 8 triangles per facet, holding the 256-gon's volume
    // rather than the default 64-gon's, which is 0.16% short of the circle.
    const stlPath = path.join(projectsDir, "ring.stl");
    const stl = callMcp(projectsDir, 3, "sketchforge_export_scene", { projectId: "case", format: "stl", outputPath: stlPath, overwrite: true });
    expect(stl[1].result.isError, stl[1].result.content[0].text).toBeUndefined();
    const bytes = fs.readFileSync(stlPath);
    const triangleCount = bytes.readUInt32LE(80);
    expect(triangleCount).toBe(256 * 8);
    let stlVolume = 0;
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const at = (vertex: number, axis: number) => bytes.readFloatLE(84 + triangle * 50 + 12 + vertex * 12 + axis * 4);
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [0, 1, 2].flatMap((vertex) => [0, 1, 2].map((axis) => at(vertex, axis)));
      stlVolume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    const facetedRing = (sides: number) => (sides / 2) * Math.sin((2 * Math.PI) / sides) * (75 ** 2 - 50 ** 2) * 10;
    expect(Math.abs(stlVolume) / facetedRing(256)).toBeCloseTo(1, 4);

    // Measuring is not the mesh: a plain revolve is measured on its exact
    // solid (#523), so the annulus, 50..75 mm and 10 mm tall, is the true ring.
    const read = callMcp(projectsDir, 4, "sketchforge_shape_properties", { projectId: "case", shapeId: shape.id });
    const properties = JSON.parse(read[1].result.content[0].text);
    expect(properties.volume).toBeCloseTo(Math.PI * (75 ** 2 - 50 ** 2) * 10, 3);
    expect(properties.provenance).toEqual({ source: "parametric", precision: "exact" });
    expect(properties.centerOfMass.x).toBeCloseTo(0, 3);
    expect(properties.centerOfMass.y).toBeCloseTo(5, 3);
    expect(properties.centerOfMass.z).toBeCloseTo(0, 3);

    // A thread takes the same two settings, through its own typed request.
    const bolt: ThreadShapeRequest = { kind: "thread", size: "M8", turns: 2, sides: 128, quality: 4 };
    const threaded = callMcp(projectsDir, 4, "sketchforge_create_shape", { projectId: "case", ...bolt });
    expect(threaded[1].result.isError).toBeUndefined();
    expect(JSON.parse(threaded[1].result.content[0].text).shapes[0].sketchRevolve).toMatchObject({ sides: 128, quality: 4 });
  }, 60_000);

  it("checks exact interference locally without returning geometry arrays", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const first = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", kind: "box", name: "A", width: 2, depth: 2, height: 2 });
    const second = callMcp(projectsDir, 3, "sketchforge_create_shape", { projectId: "case", kind: "box", name: "B", width: 2, depth: 2, height: 2, x: 3 });
    const ids = [first, second].map((result) => JSON.parse(result[1].result.content[0].text).shapes[0].id);
    const report = callMcp(projectsDir, 4, "sketchforge_check_interference", { projectId: "case", ids, clearance: 1 });
    expect(report[1].result.isError).toBeUndefined();
    expect(JSON.parse(report[1].result.content[0].text).pairs).toEqual([
      { a: { id: ids[0], name: "A" }, b: { id: ids[1], name: "B" }, gap: 1, overlapVolume: 0, precision: "exact" },
    ]);
  }, 60_000);

  it("imports an SKF package as a new local project", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "source.json"), JSON.stringify({ name: "Source", createdAt: 1, revision: 1 }));
    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "source", kind: "box", name: "Imported box", width: 12, depth: 8, height: 4 });
    const shapeId = JSON.parse(created[1].result.content[0].text).shapes[0].id;
    const packagePath = path.join(projectsDir, "source.skf");
    const exported = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "source", format: "skf", outputPath: packagePath, overwrite: true });
    expect(JSON.parse(exported[1].result.content[0].text).shapeCount).toBe(1);

    const imported = callMcp(projectsDir, 2, "sketchforge_import_project", { filePath: packagePath, name: "Imported copy" });
    expect(imported[1].result.isError, imported[1].result.content[0].text).toBeUndefined();
    const importedProject = JSON.parse(imported[1].result.content[0].text);
    expect(importedProject).toMatchObject({ name: "Imported copy", shapeCount: 1 });
    expect(importedProject.projectId).not.toBe("source");
    const scene = callMcp(projectsDir, 2, "sketchforge_read_scene", { projectId: importedProject.projectId });
    expect(JSON.parse(scene[1].result.content[0].text).objects).toEqual([expect.objectContaining({ id: shapeId, name: "Imported box" })]);
  });

  it("imports an STL file into a local project", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-stl-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const stlPath = path.join(projectsDir, "tetrahedron.stl");
    fs.writeFileSync(stlPath, [
      "solid tetrahedron",
      "facet normal 0 0 1", "outer loop", "vertex 0 0 0", "vertex 1 0 0", "vertex 0 1 0", "endloop", "endfacet",
      "endsolid tetrahedron",
    ].join("\n"));

    const tool = listMcpTools(projectsDir).find((candidate: { name: string }) => candidate.name === "sketchforge_import_stl");
    expect(tool.inputSchema.required).toEqual(["projectId", "filePath"]);
    const imported = callMcp(projectsDir, 2, "sketchforge_import_stl", {
      projectId: "case",
      filePath: stlPath,
      name: "Triangle",
      color: "#ff00aa",
      x: 5,
      z: 6,
      elevation: 7,
    });
    expect(imported[1].result.isError).toBeUndefined();
    expect(JSON.parse(imported[1].result.content[0].text)).toMatchObject({
      shape: expect.objectContaining({ name: "Triangle", color: "#ff00aa", x: 5, z: 6, elevation: 7, kind: "mesh", importedMesh: expect.objectContaining({ sourceFormat: "stl", triangleCount: 1 }) }),
    });
  }, 60_000);

  it("advertises narrow fields for canonical and legacy file imports", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-import-schema-"));
    temporaryDirectories.push(projectsDir);
    const tools = listMcpTools(projectsDir);
    const canonical = tools.find((candidate: { name: string }) => candidate.name === "sketchforge_import_file");
    const alias = tools.find((candidate: { name: string }) => candidate.name === "sketchforge_import_stl");
    expect(canonical.inputSchema.required).toEqual(["projectId", "filePath"]);
    expect(Object.keys(canonical.inputSchema.properties)).toEqual(["url", "projectId", "filePath"]);
    expect(alias.inputSchema.required).toEqual(["projectId", "filePath"]);
    expect(Object.keys(alias.inputSchema.properties)).toEqual(["projectId", "filePath", "name", "color", "x", "z", "elevation"]);
  });

  it("keeps the legacy STL alias local-only when url is supplied", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-stl-alias-"));
    temporaryDirectories.push(projectsDir);
    const response = callMcp(projectsDir, 2, "sketchforge_import_stl", { url: "http://127.0.0.1:1", projectId: "case", filePath: "/tmp/unused.stl" });
    expect(response[1].result.isError).toBe(true);
    expect(response[1].result.content[0].text).toContain("only available in local mode");
  });

  it("imports an OBJ fixture through the file import tool", async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-obj-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const filesDir = path.join(projectsDir, "files");
    fs.mkdirSync(filesDir);
    const canonicalFilesDir = await fs.promises.realpath(filesDir);
    const fixturePath = path.join(filesDir, "triangle.obj");
    fs.copyFileSync(path.join(root, "tests/fixtures/obj/triangle.obj"), fixturePath);
    const tool = listMcpTools(projectsDir).find((candidate: { name: string }) => candidate.name === "sketchforge_import_file");
    expect(tool.inputSchema.required).toEqual(["projectId", "filePath"]);
    const imported = callMcp(projectsDir, 2, "sketchforge_import_file", { projectId: "case", filePath: fixturePath }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(imported[1].result.isError).toBeUndefined();
    expect(JSON.parse(imported[1].result.content[0].text)).toMatchObject({
      shape: expect.objectContaining({ name: "triangle", kind: "mesh", importedMesh: expect.objectContaining({ sourceFormat: "obj", triangleCount: 1 }) }),
    });
    const outsidePath = path.join(projectsDir, "outside.obj");
    fs.copyFileSync(fixturePath, outsidePath);
    const linkedPath = path.join(filesDir, "linked.obj");
    fs.symlinkSync(outsidePath, linkedPath);
    const escaped = callMcp(projectsDir, 3, "sketchforge_import_file", { projectId: "case", filePath: linkedPath }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(escaped[1].result.isError).toBe(true);
    expect(escaped[1].result.content[0].text).toContain(canonicalFilesDir);
  }, 60_000);

  it("imports an SVG fixture as an extruded mesh in local mode", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-svg-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const filesDir = path.join(projectsDir, "files");
    fs.mkdirSync(filesDir);
    const svgPath = path.join(filesDir, "square.svg");
    fs.copyFileSync(path.join(root, "tests/fixtures/svg/square.svg"), svgPath);
    const imported = callMcp(projectsDir, 2, "sketchforge_import_file", { projectId: "case", filePath: svgPath }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(imported[1].result.isError, imported[1].result.content[0].text).toBeUndefined();
    expect(imported[1].result.content[0].text).not.toContain("DOMParser");
    expect(JSON.parse(imported[1].result.content[0].text)).toMatchObject({
      shape: expect.objectContaining({ kind: "mesh", importedMesh: expect.objectContaining({ sourceFormat: "svg" }) }),
    });
    const restored = callMcp(projectsDir, 3, "sketchforge_read_scene", { projectId: "case" });
    expect(restored[1].result.isError).toBeUndefined();
    expect(JSON.parse(restored[1].result.content[0].text).objects).toEqual([
      expect.objectContaining({ name: "square", kind: "mesh" }),
    ]);
  }, 60_000);

  it("sends confined STL, OBJ, and SVG files as base64 to REST imports in remote mode", async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-remote-import-"));
    temporaryDirectories.push(projectsDir);
    const fixturePath = path.join(root, "tests/fixtures/obj/triangle.obj");
    const filesDir = path.join(projectsDir, "files");
    fs.mkdirSync(filesDir);
    const bytes = fs.readFileSync(fixturePath);
    const requests: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
    const api = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ shape: { id: "remote-shape", name: "triangle", kind: "mesh" }, triangles: 1, revision: 2 }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("Mock API did not bind a TCP port.");
    try {
      for (const [index, extension] of ["stl", "obj", "svg"].entries()) {
        const filePath = path.join(filesDir, `triangle.${extension}`);
        fs.copyFileSync(fixturePath, filePath);
        const responses = await callMcpAsync(projectsDir, "sketchforge_import_file", {
          url: `http://127.0.0.1:${address.port}`,
          projectId: "remote-project",
          filePath,
        }, { SKETCHFORGE_MCP_FILES_DIR: filesDir, SKETCHFORGE_API_TOKEN: "test-token" });
        expect(requests[index]).toMatchObject({
          url: "/api/v1/imports?projectId=remote-project",
          authorization: "Bearer test-token",
          body: { fileName: `triangle.${extension}`, data: bytes.toString("base64"), mediaType: extension === "svg" ? "image/svg+xml" : `model/${extension}` },
        });
        expect(responses[1].result.isError).toBeUndefined();
        expect(JSON.parse(responses[1].result.content[0].text)).toMatchObject({ shape: { id: "remote-shape" }, triangles: 1, revision: 2 });
      }
    } finally {
      await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    }
  }, 60_000);

  it("confines MCP file access to its configured root and refuses existing output files", async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-root-"));
    const filesDir = path.join(projectsDir, "allowed");
    const outsideDir = path.join(projectsDir, "outside");
    fs.mkdirSync(filesDir);
    fs.mkdirSync(outsideDir);
    const canonicalFilesDir = await fs.promises.realpath(filesDir);
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const secret = path.join(outsideDir, "secret.skf");
    fs.writeFileSync(secret, "private");
    const linkedSecret = path.join(filesDir, "linked.skf");
    fs.symlinkSync(secret, linkedSecret);

    const escape = callMcp(projectsDir, 2, "sketchforge_import_project", { filePath: linkedSecret }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(escape[1].result.isError).toBe(true);
    expect(escape[1].result.content[0].text).toContain(canonicalFilesDir);
    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", kind: "box" });
    expect(created[1].result.isError).toBeUndefined();

    const outputEscape = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format: "stl", outputPath: path.join(outsideDir, "missing", "escaped.stl") }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(outputEscape[1].result.isError).toBe(true);
    expect(outputEscape[1].result.content[0].text).toContain(canonicalFilesDir);
    const outsideExisting = path.join(outsideDir, "existing.stl");
    fs.writeFileSync(outsideExisting, "keep outside");
    const existingEscape = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format: "stl", outputPath: outsideExisting }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(existingEscape[1].result.isError).toBe(true);
    expect(existingEscape[1].result.content[0].text).toContain(canonicalFilesDir);

    const exportPath = path.join(filesDir, "existing.stl");
    fs.writeFileSync(exportPath, "keep me");
    const overwrite = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format: "stl", outputPath: exportPath }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(overwrite[1].result.isError).toBe(true);
    expect(overwrite[1].result.content[0].text).toContain("overwrite: true");
    expect(fs.readFileSync(exportPath, "utf8")).toBe("keep me");
    const allowedOverwrite = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format: "stl", outputPath: exportPath, overwrite: true }, { SKETCHFORGE_MCP_FILES_DIR: filesDir });
    expect(allowedOverwrite[1].result.isError).toBeUndefined();
    expect(fs.readFileSync(exportPath, "utf8")).not.toBe("keep me");
  }, 60_000);

  it("imports a STEP-backed SKF project locally and explodes its nested assembly", async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-step-mcp-"));
    temporaryDirectories.push(projectsDir);
    const sourceBytes = new Uint8Array(fs.readFileSync(path.join(root, "tests/fixtures/step/nested-assembly.step")));
    const source = await projectAssetFromBytes("nested-assembly.step", "step", sourceBytes);
    const imported = await importedShapeFromStepOnKernel(source.name, new TextDecoder().decode(sourceBytes));
    imported.shape.importedMesh!.assetId = source.id;
    const packagePath = path.join(projectsDir, "step-assembly.skf");
    fs.writeFileSync(packagePath, await exportSkfProject({
      projectId: "step-assembly-source",
      projectName: "Nested STEP assembly",
      createdAt: 1,
      modifiedAt: 1,
      shapes: [imported.shape],
      history: [editorHistoryEntry([imported.shape], [])],
      historyIndex: 0,
      assets: [source],
      workspace: DEFAULT_WORKPLANE_WORKSPACE,
      snapGrid: DEFAULT_SNAP_GRID,
      placementElevation: 0,
    }));

    const importedProjectCall = callMcp(projectsDir, 2, "sketchforge_import_project", {
      filePath: packagePath,
      name: "Nested STEP assembly",
    }, {}, 120_000);
    expect(importedProjectCall[1].result.isError).toBeUndefined();
    const project = JSON.parse(importedProjectCall[1].result.content[0].text);
    expect(project).toMatchObject({ name: "Nested STEP assembly", shapeCount: 1, revision: 1 });

    const explodedCall = callMcp(projectsDir, 3, "sketchforge_explode_step_assembly", {
      projectId: project.projectId,
      shapeId: imported.shape.id,
    }, {}, 120_000);
    expect(explodedCall[1].result.isError).toBeUndefined();
    const exploded = JSON.parse(explodedCall[1].result.content[0].text);
    expect(exploded.shapes).toHaveLength(1);
    const rootGroup = exploded.shapes[0];
    expect(rootGroup.name).toBe("MainAssembly");
    expect(rootGroup.groupedShapes.map((part: { name: string }) => part.name)).toEqual(["Frame", "Sensors"]);
    const sensors = rootGroup.groupedShapes.find((part: { name: string }) => part.name === "Sensors");
    expect(sensors.groupedShapes.map((part: { name: string }) => part.name)).toEqual(["SensorLeft", "SensorRight"]);
    const leaves = [rootGroup.groupedShapes[0], ...sensors.groupedShapes];
    expect(leaves).toHaveLength(3);
    expect(leaves.map((part: { stepComponent?: { path: Array<{ name: string }> } }) => part.stepComponent?.path.at(-1)?.name).sort())
      .toEqual(["Frame", "SensorLeft", "SensorRight"]);
    expect(leaves.every((part: { importedMesh?: { hasBrepStep?: boolean }; stepComponent?: { occurrenceId?: string; path?: unknown[] } }) =>
      part.importedMesh?.hasBrepStep && part.stepComponent?.occurrenceId && part.stepComponent.path?.length)).toBe(true);
    expect(fs.existsSync(path.join(projectsDir, `${project.projectId}.skf`))).toBe(true);
    expect(fs.existsSync(path.join(projectsDir, `${project.projectId}.json`))).toBe(true);
    fs.rmSync(projectsDir, { recursive: true, force: true });
    temporaryDirectories.splice(temporaryDirectories.indexOf(projectsDir), 1);
    expect(fs.existsSync(projectsDir)).toBe(false);
  }, 180_000);

  it("creates missing parent directories when exporting a scene (#562)", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", kind: "box", width: 2, depth: 3, height: 4 });
    expect(created[1].result.isError).toBeUndefined();
    const outputPath = path.join(projectsDir, "nested", "deeper", "scene.skf");

    const exported = callMcp(projectsDir, 3, "sketchforge_export_scene", { projectId: "case", format: "skf", outputPath });

    expect(exported[1].result.isError).toBeUndefined();
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
    expect(JSON.parse(exported[1].result.content[0].text).savedTo).toBe(outputPath);
  }, 60_000);

  it("creates and reads a project directly from its directory without a server", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));

    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", {
      projectId: "case", kind: "box", name: "Mounting plate", width: 80, depth: 56, height: 3,
    });
    expect(created[1].result.isError).toBeUndefined();
    const plate = JSON.parse(created[1].result.content[0].text).shapes[0];
    const reference = callMcp(projectsDir, 2, "sketchforge_create_shape", {
      projectId: "case", kind: "box", name: "Reference mesh placeholder", width: 10, depth: 8, height: 1,
    });
    const referenceShape = JSON.parse(reference[1].result.content[0].text).shapes[0];

    const read = callMcp(projectsDir, 2, "sketchforge_read_scene", {
      projectId: "case", excludeShapeIds: [referenceShape.id], includeRawShapes: false,
    });
    const scene = JSON.parse(read[1].result.content[0].text);
    expect(scene.name).toBe("Local case");
    expect(scene.objects).toHaveLength(1);
    expect(scene.objects[0]).toMatchObject({ id: plate.id, name: "Mounting plate", width: 80, depth: 56, height: 3 });
    expect(scene).not.toHaveProperty("rawShapes");

    const outputPath = path.join(projectsDir, "Local case.skf");
    const exported = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format: "skf", outputPath, overwrite: true });
    const artifact = JSON.parse(exported[1].result.content[0].text);
    expect(artifact).toMatchObject({ filename: "Local case.skf", savedTo: outputPath, shapeCount: 2 });
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);

    const mirrored = callMcp(projectsDir, 2, "sketchforge_mirror_objects", { projectId: "case", ids: [plate.id], axis: "x" });
    expect(JSON.parse(mirrored[1].result.content[0].text)).toMatchObject({ moved: 1, axis: "x" });

    const baked = callMcp(projectsDir, 2, "sketchforge_mirror_baked", { projectId: "case", ids: [plate.id], axis: "y" });
    expect(baked[1].result.isError).toBeUndefined();
    expect(JSON.parse(baked[1].result.content[0].text)).toMatchObject({
      moved: 1,
      axis: "y",
      shapes: [expect.objectContaining({ id: plate.id, hasCadBrep: true, kind: "mesh" })],
    });

    const validation = callMcp(projectsDir, 2, "sketchforge_validate_scene", { projectId: "case" });
    expect(JSON.parse(validation[1].result.content[0].text)).toMatchObject({
      objectsChecked: 2,
      intersections: [{ fromId: plate.id, toId: referenceShape.id, intersects: true }],
    });

    const capture = callMcp(projectsDir, 2, "sketchforge_capture_image", { projectId: "case", face: "top" });
    const image = capture[1].result.content.find((item: { type: string }) => item.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(JSON.parse(capture[1].result.content[0].text)).toMatchObject({ face: "top", view: "top" });

    const drawing = callMcp(projectsDir, 2, "sketchforge_project_view", { projectId: "case" });
    expect(drawing[1].result.isError, JSON.stringify(drawing[1].result.content)).toBeUndefined();
    const projected = JSON.parse(drawing[1].result.content[0].text);
    expect(projected).toMatchObject({ view: "multiview", mimeType: "image/svg+xml", shapeCount: 2 });
    expect(projected.svg.startsWith("<svg")).toBe(true);
    for (const label of ["Front", "Top", "Right", "Iso"]) expect(projected.svg).toContain(`>${label}</text>`);

    // The crease angle reaches the engine, which refuses one out of range.
    const creased = callMcp(projectsDir, 2, "sketchforge_project_view", { projectId: "case", view: "top", featureAngle: 12 });
    expect(creased[1].result.isError, JSON.stringify(creased[1].result.content)).toBeUndefined();
    const badAngle = callMcp(projectsDir, 2, "sketchforge_project_view", { projectId: "case", featureAngle: 200 });
    expect(badAngle[1].result.isError).toBe(true);
    expect(badAngle[1].result.content[0].text).toContain("featureAngle");
    const badCapture = callMcp(projectsDir, 2, "sketchforge_capture_image", { projectId: "case", face: "top", featureAngle: 200 });
    expect(badCapture[1].result.isError).toBe(true);
    expect(badCapture[1].result.content[0].text).toContain("featureAngle");

    const drawingPath = path.join(projectsDir, "Local case.svg");
    const singleView = callMcp(projectsDir, 2, "sketchforge_project_view", { projectId: "case", view: "front", shapeIds: [plate.id], outputPath: drawingPath });
    expect(JSON.parse(singleView[1].result.content[0].text)).toMatchObject({ view: "front", savedTo: drawingPath, shapeCount: 1 });
    expect(fs.readFileSync(drawingPath, "utf8")).not.toContain(">Front</text>");

    const section = callMcp(projectsDir, 2, "sketchforge_section_view", { projectId: "case", plane: "xy", offset: 1.5, shapeIds: [plate.id] });
    expect(section[1].result.isError, JSON.stringify(section[1].result.content)).toBeUndefined();
    const sectionDrawing = JSON.parse(section[1].result.content[0].text);
    expect(sectionDrawing).toMatchObject({ plane: "xy", offset: 1.5, mimeType: "image/svg+xml", shapeCount: 1 });
    expect(sectionDrawing.svg).toContain('data-plane="xy"');
    expect(sectionDrawing.svg).toContain("<path");

    for (const format of ["stl", "obj", "3mf", "svg"]) {
      const target = path.join(projectsDir, `Local case.${format}`);
      const result = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format, shapeIds: [plate.id], outputPath: target, ...(format === "svg" ? { overwrite: true } : {}) });
      expect(JSON.parse(result[1].result.content[0].text)).toMatchObject({ savedTo: target, shapeCount: 1 });
      expect(fs.statSync(target).size).toBeGreaterThan(0);
      if (format === "3mf") {
        const archive = unzipSync(fs.readFileSync(target));
        expect(Object.keys(archive).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
        expect(strFromU8(archive["3D/3dmodel.model"])).toContain("<triangle");
      }
    }

    const dxfPath = path.join(projectsDir, "Local case.dxf");
    const dxf = callMcp(projectsDir, 2, "sketchforge_export_scene", {
      projectId: "case", format: "dxf", section: { plane: "xy", offset: 1.5 }, shapeIds: [plate.id], outputPath: dxfPath,
    });
    expect(dxf[1].result.isError, JSON.stringify(dxf[1].result.content)).toBeUndefined();
    expect(JSON.parse(dxf[1].result.content[0].text)).toMatchObject({ savedTo: dxfPath, shapeCount: 1 });
    expect(fs.readFileSync(dxfPath, "utf8")).toContain("LWPOLYLINE");

    const macroDirectory = path.join(projectsDir, "macros");
    fs.mkdirSync(macroDirectory);
    const macroName = "bolt-plate.macro.mjs";
    fs.copyFileSync(path.join(root, "packages/sketchforge-client/examples", macroName), path.join(macroDirectory, macroName));
    const macro = callMcp(projectsDir, 2, "sketchforge_run_macro", { macro: macroName, params: { holes: 3 } }, { SKETCHFORGE_MACRO_DIR: macroDirectory });
    expect(macro[1].result.isError, JSON.stringify(macro[1].result.content)).toBeUndefined();
    expect(JSON.parse(macro[1].result.content[0].text)).toMatchObject({ report: { projectCreated: true, shapeCount: 4, result: { holes: 3 } } });

    const cadMacroName = "filleted-box.macro.mjs";
    fs.copyFileSync(path.join(root, "packages/sketchforge-client/examples", cadMacroName), path.join(macroDirectory, cadMacroName));
    const cadMacro = callMcp(projectsDir, 2, "sketchforge_run_macro", { macro: cadMacroName, params: { width: 30, depth: 24, height: 12, radius: 2 } }, { SKETCHFORGE_MACRO_DIR: macroDirectory });
    expect(cadMacro[1].result.isError, JSON.stringify(cadMacro[1].result.content)).toBeUndefined();
    expect(JSON.parse(cadMacro[1].result.content[0].text)).toMatchObject({ report: { projectCreated: true, shapeCount: 1, result: { rounded: expect.any(Number), triangles: expect.any(Number) } } });
  }, 60_000);

  it("keeps imported mesh coordinates out of mutation results unless raw scene data is requested", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];

    const imported = callMcp(projectsDir, 2, "sketchforge_import_mesh", {
      projectId: "case", name: "Triangle", positions, normals,
    });
    expect(imported[1].result.isError).toBeUndefined();
    const mutation = JSON.parse(imported[1].result.content[0].text);
    expect(mutation.shape).toMatchObject({ name: "Triangle", kind: "mesh", importedMesh: { triangleCount: 1 } });
    expect(mutation.shape.importedMesh).not.toHaveProperty("positions");
    expect(mutation.shape.importedMesh).not.toHaveProperty("normals");
    expect(mutation.shape.importedMesh).toMatchObject({ triangleCount: 1, positionCount: 9, normalCount: 9 });
    expect(mutation.shape).not.toHaveProperty("cadBrep");
    expect(mutation.shape).not.toHaveProperty("cadDisplayEdges");

    const patterned = callMcp(projectsDir, 3, "sketchforge_pattern_objects", {
      projectId: "case", ids: [mutation.shape.id], count: 2, stepX: 2,
    });
    const patternResult = JSON.parse(patterned[1].result.content[0].text);
    expect(patternResult).toMatchObject({ shapes: expect.arrayContaining([expect.objectContaining({ name: "Triangle" })]), revision: expect.any(Number) });
    expect(patternResult.shapes[0].importedMesh).not.toHaveProperty("positions");

    const boxCall = callMcp(projectsDir, 4, "sketchforge_create_shape", {
      projectId: "case", kind: "box", name: "Treated box", width: 10, depth: 8, height: 4,
    });
    const box = JSON.parse(boxCall[1].result.content[0].text).shapes[0];
    const treatedCall = callMcp(projectsDir, 5, "sketchforge_apply_edge_treatment", {
      projectId: "case", id: box.id, kind: "chamfer", amount: 0.2, allEdges: true,
    });
    const treatedResult = JSON.parse(treatedCall[1].result.content[0].text);
    expect(treatedResult.shape).toMatchObject({ id: box.id, hasCadBrep: true });
    expect(treatedResult.shape).not.toHaveProperty("cadBrep");
    expect(treatedResult.shape).not.toHaveProperty("cadDisplayEdges");

    const raw = callMcp(projectsDir, 6, "sketchforge_read_scene", {
      projectId: "case", includeRawShapeIds: [mutation.shape.id],
    });
    const scene = JSON.parse(raw[1].result.content[0].text);
    expect(scene.rawShapes[0].importedMesh.positions).toEqual([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0]);
  });

  it("advertises an optional URL and uses it to opt into a remote editor", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);

    const tools = listMcpTools(projectsDir);
    const listEditors = tools.find((tool: { name: string }) => tool.name === "sketchforge_list_editors");
    expect(tools.find((tool: { name: string }) => tool.name === "sketchforge_export_scene").inputSchema.properties.format.enum).toContain("dxf");
    expect(tools.find((tool: { name: string }) => tool.name === "sketchforge_export_scene").inputSchema.properties.section.required).toEqual(["plane", "offset"]);
    expect(tools.find((tool: { name: string }) => tool.name === "sketchforge_explode_step_assembly").inputSchema.required).toContain("shapeId");
    const projectView = tools.find((tool: { name: string }) => tool.name === "sketchforge_project_view");
    expect(projectView.inputSchema.properties.view.enum).toEqual(["multiview", "front", "back", "top", "bottom", "left", "right", "iso"]);
    expect(projectView.inputSchema.properties.featureAngle).toMatchObject({ type: "number", minimum: 0, maximum: 180 });
    const captureImage = tools.find((tool: { name: string }) => tool.name === "sketchforge_capture_image");
    expect(captureImage.inputSchema.properties.featureAngle).toMatchObject({ type: "number", minimum: 0, maximum: 180 });
    const sectionView = tools.find((tool: { name: string }) => tool.name === "sketchforge_section_view");
    expect(sectionView.inputSchema.properties.plane.enum).toEqual(["xy", "xz", "yz"]);
    expect(sectionView.inputSchema.required).toEqual(["projectId", "plane", "offset"]);
    const localOnlyToolNames = ["sketchforge_list_projects", "sketchforge_create_project", "sketchforge_import_project", "sketchforge_import_stl"];
    for (const name of localOnlyToolNames) {
      const tool = tools.find((candidate: { name: string }) => candidate.name === name);
      expect(tool.inputSchema.properties).not.toHaveProperty("url");
      expect(tool.inputSchema.properties).not.toHaveProperty("editorNumber");
      expect(tool.inputSchema.properties).not.toHaveProperty("editorId");
      expect(tool.inputSchema.properties).not.toHaveProperty("timeoutMs");
    }
    expect(listEditors.inputSchema.properties.url).toMatchObject({ type: "string" });
    for (const tool of tools.filter((candidate: { name: string }) => candidate.name !== "sketchforge_list_macros" && !localOnlyToolNames.includes(candidate.name))) {
      expect(tool.inputSchema.properties.url).toMatchObject({ type: "string" });
    }

    const remote = callMcp(projectsDir, 2, "sketchforge_list_editors", { url: "http://127.0.0.1:1" }, { SKETCHFORGE_URL: "" });
    const message = remote[1].result.content[0].text;
    expect(remote[1].result.isError).toBe(true);
    expect(message).not.toContain("needs an open SketchForge editor");
    expect(message).toMatch(/fetch failed|ECONNREFUSED/i);
  });

  it("ignores editor targeting and timeout fields when locally updating an object", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Local case", createdAt: 1, revision: 1 }));

    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "case", kind: "box", width: 4, depth: 5, height: 6 });
    const shapeId = JSON.parse(created[1].result.content[0].text).shapes[0].id;
    const updated = callMcp(projectsDir, 3, "sketchforge_update_object", {
      projectId: "case", id: shapeId, width: 8, editorNumber: 12345, editorId: "ignored", timeoutMs: 1000,
    });
    expect(updated[1].result.isError).toBeUndefined();
    expect(JSON.parse(updated[1].result.content[0].text).shape).toMatchObject({ id: shapeId, width: 8 });
  }, 60_000);
});
