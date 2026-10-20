import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const server = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const temporaryDirectories: string[] = [];

function callMcp(projectsDir: string, id: number, name: string, args: Record<string, unknown>) {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  ].join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "http://127.0.0.1:1" },
    timeout: 30_000,
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

describe("local MCP engine mode", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
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
  });
});
