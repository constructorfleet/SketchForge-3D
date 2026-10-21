import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isRepositoryFullName } from "../../scripts/docs/validate-generated-docs-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validator = path.join(root, "scripts/docs/validate-generated-docs-artifact.mjs");
const files = [
  "docs/CLI_REFERENCE.md",
  "docs/OPERATOR_CONFIGURATION.md",
  "docs/PUBLISHING_CLIENTS.md",
  "docs/SHAPE_REQUEST_REFERENCE.md",
  "docs/SKF_FORMAT_REFERENCE.md",
  "docs/mcp/TOOLS_REFERENCE.md",
  "docs/openapi-v1.json",
];
const expected = {
  repo: "constructorfleet/SketchForge-3D",
  pullRequest: 42,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
};

async function createArtifact(fileList = files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sketchforge-generated-docs-"));
  for (const file of fileList) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `generated: ${file}\n`);
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...expected, files: fileList }));
  return directory;
}

function validate(directory, overrides = {}) {
  const args = [validator, `--artifact-dir=${directory}`];
  for (const [key, value] of Object.entries({ ...expected, ...overrides })) {
    args.push(`--expected-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}=${value}`);
  }
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
}

test("repository validation accepts owner/repo names and rejects malformed paths", () => {
  assert.equal(isRepositoryFullName("constructorfleet/SketchForge-3D"), true);
  assert.equal(isRepositoryFullName("constructor-fleet/sketch_forge.docs"), true);
  assert.equal(isRepositoryFullName("constructorfleet"), false);
  assert.equal(isRepositoryFullName("attacker/fork/extra"), false);
  assert.equal(isRepositoryFullName("owner/../repo"), false);
});

test("generated docs artifact accepts only the allowlisted files for the exact PR head", async () => {
  const directory = await createArtifact();
  try {
    const result = validate(directory);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated docs artifact rejects mismatched PR metadata and unapproved paths", async () => {
  const mismatched = await createArtifact();
  const extraPath = await createArtifact([...files, "docs/UNTRUSTED.md"]);
  try {
    assert.notEqual(validate(mismatched, { headSha: "c".repeat(40) }).status, 0,
      "artifact from a different head commit must not be committed");
    assert.notEqual(validate(mismatched, { repo: "attacker/fork" }).status, 0,
      "artifact from another repository must not be committed");
    assert.notEqual(validate(extraPath).status, 0,
      "artifact cannot add arbitrary files to the trusted commit");
  } finally {
    await rm(mismatched, { recursive: true, force: true });
    await rm(extraPath, { recursive: true, force: true });
  }
});
