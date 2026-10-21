import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const guide = path.join(root, "docs/mcp/EXAMPLES.md");
const runner = path.join(root, "docs/mcp/examples/run-local-project.sh");

test("the documented local MCP workflow validates its calls against tools/list and runs on a temporary project", () => {
  const guideText = readFileSync(guide, "utf8");
  assert.match(guideText, /```sh\s*\n!!!include\(\.\/examples\/run-local-project\.sh\)!!!\s*\n```/);
  const run = spawnSync("bash", [runner], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.workflow, ["create project", "create box", "read scene", "export SKF"]);
  assert.equal(result.scene.objects[0].name, "Mounting plate");
  assert.equal(result.scene.objects[0].width, 80);
  assert.equal(result.export.format, "skf");
  assert.ok(result.export.bytes > 0);
  assert.match(result.projectsDirectory, /sketchforge-mcp-example-/);
});
