#!/usr/bin/env node

// Executable source for importing and exporting a local STL through MCP.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const server = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const projectsDirectory = mkdtempSync(path.join(os.tmpdir(), "sketchforge-mcp-stl-example-"));
const environment = {
  ...process.env,
  SKETCHFORGE_PROJECTS_DIR: projectsDirectory,
  SKETCHFORGE_API_TOKEN: "",
  SKETCHFORGE_URL: "",
};

function rpc(request) {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, ...request }),
  ].join("\n") + "\n";
  const result = spawnSync(process.execPath, [server], { cwd: root, env: environment, input, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || `MCP server exited with ${result.status}`);
  const response = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)).at(-1);
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

function validate(schema, value, location) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => {
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  })) throw new Error(`${location} does not match schema type ${types.join(" | ")}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location} must be one of ${schema.enum.join(", ")}`);
  if (schema.type === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${location}.${key} is required by the MCP schema`);
    for (const [key, item] of Object.entries(value)) if (schema.properties?.[key]) validate(schema.properties[key], item, `${location}.${key}`);
  }
}

function textResult(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? "MCP tool call failed");
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

const stl = `solid tetrahedron
 facet normal 0 0 -1
  outer loop
   vertex 0 0 0
   vertex 0 1 0
   vertex 1 0 0
  endloop
 endfacet
 facet normal 0 -1 0
  outer loop
   vertex 0 0 0
   vertex 1 0 0
   vertex 0 0 1
  endloop
 endfacet
 facet normal -1 0 0
  outer loop
   vertex 0 0 0
   vertex 0 0 1
   vertex 0 1 0
  endloop
 endfacet
 facet normal 1 1 1
  outer loop
   vertex 1 0 0
   vertex 0 1 0
   vertex 0 0 1
  endloop
 endfacet
endsolid tetrahedron
`;

try {
  const sourcePath = path.join(projectsDirectory, "tetrahedron.stl");
  writeFileSync(sourcePath, stl);
  const tools = rpc({ method: "tools/list", params: {} }).tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const call = (name, args) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`MCP server does not advertise ${name}`);
    validate(tool.inputSchema, args, name);
    return textResult(rpc({ method: "tools/call", params: { name, arguments: args } }));
  };

  const project = call("sketchforge_create_project", { name: "Local STL import example" });
  const imported = call("sketchforge_import_stl", {
    projectId: project.projectId,
    filePath: sourcePath,
    name: "Imported tetrahedron",
  });
  const shapeId = imported.shapes?.[0]?.id ?? imported.shape?.id;
  if (!shapeId) throw new Error("STL import did not return a shape id");
  const properties = call("sketchforge_shape_properties", { projectId: project.projectId, shapeId });
  const exportPath = path.join(projectsDirectory, "tetrahedron-export.stl");
  const exported = call("sketchforge_export_scene", {
    projectId: project.projectId,
    format: "stl",
    outputPath: exportPath,
  });
  const bytes = statSync(exportPath).size;
  if (bytes <= 0 || readFileSync(exportPath).length !== bytes) throw new Error("STL export is empty or unreadable");
  process.stdout.write(`${JSON.stringify({
    workflow: ["create project", "import STL", "read shape properties", "export STL"],
    projectId: project.projectId,
    shape: { id: shapeId, name: imported.shape?.name ?? imported.shapes?.[0]?.name },
    properties,
    export: { format: exported.format, bytes },
    projectsDirectory,
  })}\n`);
} finally {
  rmSync(projectsDirectory, { recursive: true, force: true });
}
