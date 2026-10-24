import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("generated package reference pages are not tracked source files", () => {
  const tracked = spawnSync("git", ["ls-files", "--", "docs/reference/typescript-client.md", "docs/reference/typescript-engine.md", "docs/reference/python-client.md"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout.trim(), "", "package reference markdown should be generated into the Pages artifact");
});

test("package references are generated into the staged Pages source tree", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const stage = scripts["docs:stage"];
  const staging = stage.indexOf("node scripts/docs-generate.mjs");
  const references = stage.indexOf(
    "node scripts/docs/generate-package-references.mjs --output-dir .docs-site/docs/reference",
  );

  assert.ok(staging >= 0, "docs:stage must stage source docs before generating references");
  assert.ok(references > staging, "package references must be generated after docs staging");
  assert.ok(!scripts["docs:verify"].includes("generate-package-references.mjs --check"),
    "docs:check must not require generated reference markdown diffs to be committed");
  assert.ok(scripts["docs:generate"].indexOf("npm run docs:stage") >= 0,
    "docs:check must stage generated pages before validating source links");
  assert.ok(scripts["docs:verify"].includes("node scripts/docs-check.mjs"),
    "docs:verify must validate links after docs:check generation");
  assert.ok(scripts["docs:site-build"].includes("tests/docs/package-reference-artifact.test.mjs"),
    "docs:build must verify the Pages artifact includes generated package references");
});

test("package reference generation supports an output directory and check mode", async () => {
  const generator = await readFile(path.join(root, "scripts/docs/generate-package-references.mjs"), "utf8");
  assert.match(generator, /--output-dir/, "generator must accept an artifact output directory");
  assert.match(generator, /--check/, "generator must validate generated output in check mode");
});

test("package references can be checked for stale generated output in a temporary directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sketchforge-package-reference-"));
  const generator = path.join(root, "scripts/docs/generate-package-references.mjs");
  const run = (check) => spawnSync(process.execPath, [generator, ...(check ? ["--check"] : []), "--output-dir", directory], {
    cwd: root,
    encoding: "utf8",
  });

  try {
    const generated = run(false);
    assert.equal(generated.status, 0, generated.stderr);
    const fresh = run(true);
    assert.equal(fresh.status, 0, fresh.stderr);
    await writeFile(path.join(directory, "python-client.md"), "outdated output\n");
    const stale = run(true);
    assert.notEqual(stale.status, 0, "check mode must reject stale generated output");
    assert.match(stale.stderr, /python-client\.md is missing or stale/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the docs job validates staged generated pages instead of git diffs", async () => {
  const yaml = await import("js-yaml");
  const load = async (name) => yaml.load(await readFile(path.join(root, ".github/workflows", name), "utf8"));
  const check = "node scripts/docs/generate-package-references.mjs --check --output-dir .docs-site/docs/reference";
  const runs = (job) => job.steps.map(({ run }) => run ?? "");

  for (const [name, id] of [["docs.yml", "build"], ["trusted-pr-checks.yml", "docs"]]) {
    const steps = runs((await load(name)).jobs[id]);
    const generate = steps.findIndex((run) => run.includes("npm run docs:generate"));
    const checked = steps.findIndex((run) => run.includes(check));
    assert.ok(generate >= 0, `${name} ${id} must generate the staged docs tree`);
    assert.ok(checked > generate, `${name} ${id} must check staged package references after docs:generate`);
    assert.ok(steps.every((run) => !/git diff --exit-code -- docs\/reference/.test(run)));
  }

  // docs:generate already builds both packages and stages the references, so a
  // separate job repeating that build to run the same check is duplicate work.
  for (const name of ["ci.yml", "trusted-pr-checks.yml"]) {
    assert.equal((await load(name)).jobs["package-reference"], undefined,
      `${name} must not repeat the package reference build in its own job`);
  }
});

test("docs build runs the artifact assertion after VitePress emits Pages output", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const build = scripts["docs:site-build"];
  assert.ok(build.indexOf("vitepress build .docs-site") < build.indexOf("package-reference-artifact.test.mjs"));
});
