import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = yaml.load(await readFile(path.join(root, ".github/workflows/desktop-release.yml"), "utf8"));
const { build, attach } = workflow.jobs;
const runOf = (step) => step.run ?? "";

// v1.18.0 through v1.23.0 were published with no installers at all. Each run
// re-ran the whole unit suite on every platform, a timeout on the slowest
// runner (Intel macOS, Windows) failed that one leg, and the attach job needed
// every leg, so nothing was attached for any platform.
test("the installer build does not re-run the unit suite that CI already gated", () => {
  const testSteps = build.steps.filter((step) => /\bnpm\s+(run\s+)?test\b/.test(runOf(step)));
  assert.deepEqual(testSteps.map((step) => step.name), [],
    "the desktop build re-runs the unit suite per platform; CI on main gates the commit, and a timeout here costs a platform's installer");
});

test("attach runs after a failed leg and attaches what was built", () => {
  assert.equal(attach.needs, "build");
  assert.match(String(attach.if ?? ""), /!cancelled\(\)|always\(\)/,
    "without !cancelled() one failed leg skips attaching every platform");

  const downloads = attach.steps.filter((step) => /^actions\/download-artifact@/.test(step.uses ?? ""));
  assert.ok(downloads.length > 0, "attach should download the build artifacts");
  for (const step of downloads) {
    assert.equal(step.with?.name, undefined,
      `"${step.name}" downloads one named artifact, which fails the job when that leg did not build`);
    assert.match(String(step.with?.pattern ?? ""), /^desktop-/);
  }
});

test("attach stages and checks assets with the workflow's own script, not the tag's", () => {
  // The released tag predates the staging script, so checking it out in the
  // attach job would remove the script it is about to run.
  const checkoutOfTag = attach.steps.filter((step) => /git checkout\b/.test(runOf(step)));
  assert.deepEqual(checkoutOfTag.map((step) => step.name), []);
  const scriptRuns = attach.steps.map(runOf).join("\n");
  assert.match(scriptRuns, /scripts\/release\/desktop-release-assets\.mjs stage\b/);
  assert.match(scriptRuns, /scripts\/release\/desktop-release-assets\.mjs check\b/);
});

test("an incomplete release is marked on the release page and fails the run", () => {
  const scriptRuns = attach.steps.map(runOf).join("\n");
  assert.match(scriptRuns, /scripts\/release\/desktop-release-assets\.mjs notes\b/,
    "a public release missing installers should say so on its own page");

  const failStep = attach.steps.at(-1);
  assert.match(String(failStep.if ?? ""), /missing != ''/, "the last step should run only when an installer is missing");
  assert.match(runOf(failStep), /exit 1/);
});

test("a re-run never moves the latest marker onto an already published release", () => {
  const publish = attach.steps.find((step) => /--latest\b/.test(runOf(step)));
  assert.ok(publish, "a draft this workflow created is still published once complete");
  assert.match(String(publish.if ?? ""), /was_draft == 'true'/,
    "re-running an old version must not mark it latest over newer releases");
  assert.match(String(publish.if ?? ""), /missing == ''/, "a draft stays a draft until every installer is attached");
});
