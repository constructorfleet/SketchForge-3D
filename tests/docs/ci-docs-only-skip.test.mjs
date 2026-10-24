import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { decide, isDocsOnlyPath, touchesCode } from "../../scripts/ci/classify-changes.mjs";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const load = (name) => yaml.load(readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const CLASSIFIER = "./.github/workflows/classify-changes.yml";

// A documentation-only pull request used to wait on the Windows unit suite, a
// static export, a server-backed e2e run and two package jobs, none of which
// can be affected by prose. Those jobs now depend on a `changes` job and are
// skipped by `if:` when it reports no code changed. A job skipped by `if:`
// reports success to a required check; a workflow skipped by `on.paths` leaves
// the check pending forever, which is why the filter lives in a job.
//
// The gate runs a job unless `changes` positively said "no code": an empty or
// missing output (the classifier failed) still runs everything.
const GATE = "${{ !cancelled() && needs.changes.outputs.code != 'false' }}";

function assertGated(name, job) {
  const needs = [job.needs ?? []].flat();
  assert.ok(needs.includes("changes"), `${name} must need the changes job`);
  assert.equal(job.if, GATE, `${name} must be gated on the changes output, failing open`);
}

test("ci.yml classifies changes in an ungated job", () => {
  const { jobs } = load("ci.yml");
  assert.ok(jobs.changes, "ci.yml has no changes job");
  assert.equal(jobs.changes.uses, CLASSIFIER);
  assert.equal(jobs.changes.if, undefined, "the changes job must always run");
  assert.equal(jobs.changes.needs, undefined, "the changes job must not wait on anything");
});

test("every other ci.yml job is gated on the changes output", () => {
  const { jobs } = load("ci.yml");
  const gated = Object.entries(jobs).filter(([name]) => name !== "changes");
  assert.ok(gated.length >= 5, "expected the code jobs to be present");
  for (const [name, job] of gated) assertGated(name, job);
});

test("ci.yml keeps its pull_request trigger free of path filters", () => {
  const workflow = load("ci.yml");
  const triggers = workflow.on ?? workflow[true];
  assert.equal(triggers.pull_request ?? null, null, "a path filter would leave required checks pending");
});

test("the docker smoke test is skipped the same way", () => {
  const workflow = load("docker.yml");
  const triggers = workflow.on ?? workflow[true];
  assert.equal(triggers.pull_request ?? null, null, "docker.yml should use the shared classifier, not path filters");
  assert.equal(workflow.jobs.changes.uses, CLASSIFIER);
  assertGated("smoke", workflow.jobs.smoke);
});

test("the reusable classifier exposes a code output and runs the script", () => {
  const workflow = load("classify-changes.yml");
  const triggers = workflow.on ?? workflow[true];
  assert.ok(triggers.workflow_call.outputs.code, "workflow_call must output code");
  const [job] = Object.values(workflow.jobs);
  assert.equal(job.if, undefined);
  const checkout = job.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout"));
  // The pull_request checkout is the merge commit; its first parent is the base.
  assert.ok(Number(checkout.with["fetch-depth"]) >= 2, "the merge commit's parents must be fetched");
  const script = job.steps.map((step) => step.run ?? "").join("\n");
  assert.match(script, /node scripts\/ci\/classify-changes\.mjs/);
  assert.match(script, /code=true/, "a crashed classifier must still report code=true");
});

test("push events and anything that is not a pull request run all code", () => {
  for (const eventName of ["push", "workflow_dispatch", "repository_dispatch", undefined]) {
    assert.equal(
      decide({ eventName, listChangedFiles: () => ["docs/ROADMAP.md"] }),
      true,
      `${eventName} must run code jobs`,
    );
  }
});

test("a failure to list changed files runs all code", () => {
  const listChangedFiles = () => {
    throw new Error("fatal: bad revision 'HEAD^1'");
  };
  assert.equal(decide({ eventName: "pull_request", listChangedFiles }), true);
});

test("a documentation-only pull request skips code", () => {
  const files = [
    "docs/ROADMAP.md",
    "docs/guides/editor-workflow.md",
    "docs/screenshots/editor.png",
    "docs/.vitepress/theme/custom.css",
    ".github/CONTRIBUTING.md",
    "AGENTS.md",
    ".claude/agents/implementer.md",
  ];
  assert.equal(touchesCode(files), false);
  assert.equal(decide({ eventName: "pull_request", listChangedFiles: () => files }), false);
});

test("a mixed pull request runs code", () => {
  assert.equal(touchesCode(["docs/ROADMAP.md", "apps/web/src/app/page.tsx"]), true);
  assert.equal(touchesCode(["docs/ROADMAP.md", ".github/workflows/ci.yml"]), true);
  assert.equal(touchesCode(["docs/ROADMAP.md", "package.json"]), true);
});

test("Markdown read by a code job's tests counts as code", () => {
  for (const file of [
    "README.md",
    "docs/SKF_FORMAT_REFERENCE.md",
    "docs/SHAPE_REQUEST_REFERENCE.md",
    "docs/DOCUMENTATION_SUITE_SPEC.md",
    "docs/REST_API.md",
    "docs/packages/engine.md",
    "docs/guides/package-examples.md",
    "packages/sketchforge-client/README.md",
    "tests/fixtures/step/README.md",
  ]) {
    assert.equal(isDocsOnlyPath(file), false, `${file} is read by a code job`);
  }
});

test("non-Markdown documentation inputs count as code", () => {
  for (const file of ["docs/openapi-v1.json", "docs/examples/rest-hole-plate.mjs", "docs/skills/sketchforge-mcp-skill/agents/openai.yaml"]) {
    assert.equal(isDocsOnlyPath(file), false, `${file} is executed or parsed by a code job`);
  }
});

test("an empty file list runs code", () => {
  assert.equal(touchesCode([]), true);
  assert.equal(touchesCode(["", "  "]), true);
  assert.equal(decide({ eventName: "pull_request", listChangedFiles: () => [] }), true);
});

// The rule above is a list, and a list goes stale the day a unit test starts
// reading another page. So every tracked file the classifier calls docs-only is
// checked against what the code jobs can see: their test and source trees, and
// every script those tests run. A mention of the file's path, or of its name
// under docs/, fails here until the classifier is told that file is code.
// Named in a source comment, never opened: the engine cites its design
// document in packages/sketchforge-engine/src and tests/e2e.
const CITED_NOT_READ = new Set(["docs/ENGINE_EXTRACTION.md"]);

function walk(directory) {
  const skip = new Set(["node_modules", "dist", ".next", ".next-export", "out", "__pycache__"]);
  return readdirSync(directory).flatMap((entry) => {
    if (skip.has(entry)) return [];
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

test("no file the code jobs read is classified docs-only", () => {
  const sourceExtensions = /\.(?:[cm]?[jt]sx?|py|json|ya?ml|sh)$/;
  const trees = ["tests/unit", "tests/e2e", "packages", "apps/web", "deploy"].map((dir) => path.join(root, dir));
  const sources = trees.flatMap(walk).filter((file) => sourceExtensions.test(file));
  const testSources = sources.filter((file) => file.includes(`${path.sep}tests${path.sep}`));
  const spawnedScripts = new Set();
  for (const file of testSources) {
    for (const [script] of readFileSync(file, "utf8").matchAll(/scripts\/[\w./-]+\.(?:mjs|js|py)/g)) {
      spawnedScripts.add(path.join(root, script));
    }
  }
  const corpus = [...sources, ...spawnedScripts]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const docsOnly = tracked.filter(isDocsOnlyPath);
  assert.ok(docsOnly.length > 20, "the classifier should treat most documentation as docs-only");
  // A name shared by several tracked files (README.md, index.md) says nothing
  // about which one is read, so only a unique name is matched on its own.
  const nameCount = new Map();
  for (const file of tracked) nameCount.set(path.basename(file), (nameCount.get(path.basename(file)) ?? 0) + 1);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leaked = docsOnly.filter((file) => {
    if (CITED_NOT_READ.has(file)) return false;
    if (corpus.includes(file)) return true;
    const name = path.basename(file);
    return file.startsWith("docs/") && nameCount.get(name) === 1 && new RegExp(`["'\`/]${escape(name)}["'\`]`).test(corpus);
  });
  assert.deepEqual(leaked, [], "these files are read by a code job; classify them as code");
});
