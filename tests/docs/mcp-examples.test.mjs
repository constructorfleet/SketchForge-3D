import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const guide = path.join(root, "docs/mcp/EXAMPLES.md");
const runner = path.join(root, "docs/mcp/examples/run-local-project.sh");
const importRunner = path.join(root, "docs/mcp/examples/run-local-stl-import.sh");
const engineDist = path.join(root, "packages/sketchforge-engine/dist");

// Runs the example source directly. Its wrapper rebuilds engine dist, and
// package-reference-artifact.test.mjs reads that dist concurrently.
function runExample(wrapper, source) {
  const script = readFileSync(wrapper, "utf8");
  assert.match(script, /^npm run engine:build >&2$/m, "the wrapper must build the engine for a fresh checkout");
  assert.match(script, new RegExp(`^node ${source.replaceAll(".", "\\.")}$`, "m"));
  return spawnSync(process.execPath, [path.join(root, source)], { cwd: root, encoding: "utf8", timeout: 60_000 });
}

// Maps each engine dist file to its mtime. Other docs test files read dist concurrently.
function distSnapshot() {
  return Object.fromEntries(readdirSync(engineDist, { recursive: true })
    .map((file) => [file, statSync(path.join(engineDist, file)).mtimeMs]));
}

test("the documented local MCP workflow validates its calls against tools/list and runs on a temporary project", () => {
  const guideText = readFileSync(guide, "utf8");
  assert.match(guideText, /```sh\s*\n!!!include\(\.\/examples\/run-local-project\.sh\)!!!\s*\n```/);
  const before = distSnapshot();
  const run = runExample(runner, "docs/mcp/examples/local-project.mjs");
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(distSnapshot(), before, "the example run must not rebuild the shared engine dist");
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.workflow, ["create project", "create box", "read scene", "export SKF"]);
  assert.equal(result.scene.objects[0].name, "Mounting plate");
  assert.equal(result.scene.objects[0].width, 80);
  assert.equal(result.export.format, "skf");
  assert.ok(result.export.bytes > 0);
  assert.match(result.projectsDirectory, /sketchforge-mcp-example-/);
});

test("the local STL import example imports, measures, and exports through advertised MCP tools", () => {
  const guideText = readFileSync(guide, "utf8");
  const readme = readFileSync(path.join(root, "packages/sketchforge-client/README.md"), "utf8");
  const skill = readFileSync(path.join(root, "docs/skills/sketchforge-mcp-skill/SKILL.md"), "utf8");
  assert.match(guideText, /```sh\s*\n!!!include\(\.\/examples\/run-local-stl-import\.sh\)!!!\s*\n```/);
  assert.match(readme, /sketchforge_import_stl/);
  for (const tool of ["sketchforge_import_stl", "sketchforge_shape_properties", "sketchforge_export_scene"]) {
    assert.match(skill, new RegExp(tool));
  }
  assert.match(skill, /SKETCHFORGE_MCP_FILES_DIR[\s\S]*SKETCHFORGE_PROJECTS_DIR/);

  const before = distSnapshot();
  const run = runExample(importRunner, "docs/mcp/examples/local-stl-import.mjs");
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(distSnapshot(), before, "the example run must not rebuild the shared engine dist");
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.workflow, ["create project", "import STL", "read shape properties", "export STL"]);
  assert.equal(result.shape.name, "Imported tetrahedron");
  assert.ok(result.properties.volume > 0);
  assert.equal(result.export.format, "stl");
  assert.ok(result.export.bytes > 0);
  assert.match(result.projectsDirectory, /sketchforge-mcp-stl-example-/);
});
