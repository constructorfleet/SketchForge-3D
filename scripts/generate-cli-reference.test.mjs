import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("published package CLI reference is generated and current", () => {
  const result = spawnSync(process.execPath, ["scripts/generate-cli-reference.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const reference = readFileSync(path.join(root, "docs", "CLI_REFERENCE.md"), "utf8");
  assert.match(reference, /### `sketchforge-macro`/);
  assert.match(reference, /### `sketchforge-mcp`/);
  assert.match(reference, /\[--project=<id>\] \[--json\]/);
  assert.match(reference, /--describe\s+show macro metadata without running it/);
  assert.match(reference, /usage: python -m sketchforge3d\.macro/);
});
