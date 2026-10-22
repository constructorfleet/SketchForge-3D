import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const checker = path.join(root, "scripts/docs-check.mjs");

function repoWith(contract) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "contract-lint-"));
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Fixture\n");
  writeFileSync(path.join(dir, "docs/index.md"), "# Fixture\n");
  writeFileSync(path.join(dir, "docs/pass-1.contract.md"), contract);
  for (const args of [["init", "-q"], ["add", "-A"]]) spawnSync("git", args, { cwd: dir });
  return dir;
}

const BAD = [
  "---",
  "verified_delivery: contract",
  "---",
  "",
  "## Objective",
  "",
  "Sessions are isolated.",
].join("\n");

test("the documentation check reports contract violations and fails", () => {
  const run = spawnSync("node", [checker, "--root", repoWith(BAD)], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /L-1/);
  assert.match(run.stderr, /pass-1\.contract\.md/);
});
