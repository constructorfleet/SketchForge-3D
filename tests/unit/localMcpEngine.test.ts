import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const server = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const temporaryDirectories: string[] = [];

function callMcp(projectsDir: string, id: number, name: string, args: Record<string, unknown>, extraEnvironment: Record<string, string> = {}) {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  ].join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "http://127.0.0.1:1", ...extraEnvironment },
    timeout: 30_000,
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
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

  it("imports an SKF package as a new local project", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);
    fs.writeFileSync(path.join(projectsDir, "source.json"), JSON.stringify({ name: "Source", createdAt: 1, revision: 1 }));
    const created = callMcp(projectsDir, 2, "sketchforge_create_shape", { projectId: "source", kind: "box", name: "Imported box", width: 12, depth: 8, height: 4 });
    const shapeId = JSON.parse(created[1].result.content[0].text).shapes[0].id;
    const packagePath = path.join(projectsDir, "source.skf");
    const exported = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "source", format: "skf", outputPath: packagePath });
    expect(JSON.parse(exported[1].result.content[0].text).shapeCount).toBe(1);

    const imported = callMcp(projectsDir, 2, "sketchforge_import_project", { filePath: packagePath, name: "Imported copy" });
    expect(imported[1].result.isError).toBeUndefined();
    const importedProject = JSON.parse(imported[1].result.content[0].text);
    expect(importedProject).toMatchObject({ name: "Imported copy", shapeCount: 1 });
    expect(importedProject.projectId).not.toBe("source");
    const scene = callMcp(projectsDir, 2, "sketchforge_read_scene", { projectId: importedProject.projectId });
    expect(JSON.parse(scene[1].result.content[0].text).objects).toEqual([expect.objectContaining({ id: shapeId, name: "Imported box" })]);
  });

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
    const exported = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format: "skf", outputPath });
    const artifact = JSON.parse(exported[1].result.content[0].text);
    expect(artifact).toMatchObject({ filename: "Local case.skf", savedTo: outputPath, shapeCount: 2 });
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);

    const mirrored = callMcp(projectsDir, 2, "sketchforge_mirror_objects", { projectId: "case", ids: [plate.id], axis: "x" });
    expect(JSON.parse(mirrored[1].result.content[0].text)).toMatchObject({ moved: 1, axis: "x" });

    const validation = callMcp(projectsDir, 2, "sketchforge_validate_scene", { projectId: "case" });
    expect(JSON.parse(validation[1].result.content[0].text)).toMatchObject({
      objectsChecked: 2,
      intersections: [{ fromId: plate.id, toId: referenceShape.id, intersects: true }],
    });

    const capture = callMcp(projectsDir, 2, "sketchforge_capture_image", { projectId: "case", face: "top" });
    const image = capture[1].result.content.find((item: { type: string }) => item.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    for (const format of ["stl", "obj", "3mf"]) {
      const target = path.join(projectsDir, `Local case.${format}`);
      const result = callMcp(projectsDir, 2, "sketchforge_export_scene", { projectId: "case", format, shapeIds: [plate.id], outputPath: target });
      expect(JSON.parse(result[1].result.content[0].text)).toMatchObject({ savedTo: target, shapeCount: 1 });
      expect(fs.statSync(target).size).toBeGreaterThan(0);
      if (format === "3mf") {
        const archive = unzipSync(fs.readFileSync(target));
        expect(Object.keys(archive).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
        expect(strFromU8(archive["3D/3dmodel.model"])).toContain("<triangle");
      }
    }

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

  it("advertises an optional URL and uses it to opt into a remote editor", () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-local-mcp-"));
    temporaryDirectories.push(projectsDir);

    const tools = listMcpTools(projectsDir);
    const listEditors = tools.find((tool: { name: string }) => tool.name === "sketchforge_list_editors");
    expect(listEditors.inputSchema.properties.url).toMatchObject({ type: "string" });
    for (const tool of tools.filter((candidate: { name: string }) => candidate.name !== "sketchforge_list_macros")) {
      expect(tool.inputSchema.properties.url).toMatchObject({ type: "string" });
    }

    const remote = callMcp(projectsDir, 2, "sketchforge_list_editors", { url: "http://127.0.0.1:1" }, { SKETCHFORGE_URL: "" });
    const message = remote[1].result.content[0].text;
    expect(remote[1].result.isError).toBe(true);
    expect(message).not.toContain("needs an open SketchForge editor");
    expect(message).toMatch(/fetch failed|ECONNREFUSED/i);
  });
});
