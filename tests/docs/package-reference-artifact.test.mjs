import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("package references are generated into the staged Pages source tree", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const generate = scripts["docs:generate"];
  const staging = generate.indexOf("node scripts/docs-generate.mjs");
  const references = generate.indexOf(
    "node scripts/docs/generate-package-references.mjs --output-dir .docs-site/docs/reference",
  );

  assert.ok(staging >= 0, "docs:generate must stage source docs before generating references");
  assert.ok(references > staging, "package references must be generated after docs staging");
  assert.ok(!scripts["docs:check"].includes("generate-package-references.mjs --check"),
    "docs:check must not require generated reference markdown diffs to be committed");
  assert.ok(scripts["docs:build"].includes("tests/docs/package-reference-artifact.test.mjs"),
    "docs:build must verify the Pages artifact includes generated package references");
});

test("package reference generation supports an output directory and check mode", async () => {
  const generator = await readFile(path.join(root, "scripts/docs/generate-package-references.mjs"), "utf8");
  assert.match(generator, /--output-dir/, "generator must accept an artifact output directory");
  assert.match(generator, /--check/, "generator must validate generated output in check mode");
});

test("the CI reference job validates staged generated pages instead of git diffs", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.split("  package-examples:")[0];

  assert.match(job, /--output-dir \.docs-site\/docs\/reference/);
  assert.match(job, /--check --output-dir \.docs-site\/docs\/reference/);
  assert.doesNotMatch(job, /git diff --exit-code -- docs\/reference/);
});

test("docs build runs the artifact assertion after VitePress emits Pages output", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const build = scripts["docs:build"];
  assert.ok(build.indexOf("vitepress build .docs-site") < build.indexOf("package-reference-artifact.test.mjs"));
});
