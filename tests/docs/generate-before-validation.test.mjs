import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const workflow = readFileSync(new URL("../../.github/workflows/docs.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const titleWorkflow = readFileSync(new URL("../../.github/workflows/pr-title.yml", import.meta.url), "utf8");
const commitWorkflow = readFileSync(new URL("../../.github/workflows/docs-generated-commit.yml", import.meta.url), "utf8");
const commitScript = readFileSync(new URL("../../scripts/docs/commit-generated-docs.mjs", import.meta.url), "utf8");
const trustedWorkflow = readFileSync(new URL("../../.github/workflows/trusted-pr-checks.yml", import.meta.url), "utf8");
const manifestScript = readFileSync(new URL("../../scripts/docs/write-generated-docs-manifest.mjs", import.meta.url), "utf8");

test("docs checks generate committed references before validating them", () => {
  const docsCheck = packageJson.scripts["docs:check"];
  const docsBuild = packageJson.scripts["docs:build"];

  assert.ok(docsCheck.indexOf("npm run docs:generate") >= 0, "docs:check must generate references");
  assert.ok(docsCheck.indexOf("npm run docs:generate") < docsCheck.indexOf("npm run docs:verify"),
    "docs:check must generate references before running validation");
  assert.ok(packageJson.scripts["docs:verify"].includes("scripts/docs-check.mjs"),
    "docs:verify must validate generated documentation links");
  assert.ok(docsBuild.indexOf("docs:check") < docsBuild.indexOf("docs:site-build"),
    "docs:build must validate generated references before building the site");
  const generatePosition = workflow.indexOf("run: npm run docs:generate");
  const uploadPosition = workflow.indexOf("uses: actions/upload-artifact@v4");
  const verifyPosition = workflow.indexOf("run: npm run docs:verify");
  const siteBuildPosition = workflow.indexOf("run: npm run docs:site-build");
  assert.ok(generatePosition >= 0 && generatePosition < uploadPosition && uploadPosition < verifyPosition && verifyPosition < siteBuildPosition,
    "CI must generate and upload current outputs before validation and site build");
  assert.doesNotMatch(workflow, /run: npm run docs:check/,
    "CI must not run a second generate/check cycle after generation");
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /path: generated-docs-artifact\//);
  assert.match(manifestScript, /copyFile/);
  assert.ok(commitWorkflow.indexOf("download-artifact") < commitWorkflow.indexOf("commit-generated-docs.mjs"),
    "trusted workflow must validate downloaded artifact data before committing");
  assert.match(workflow, /group: docs-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(workflow, /group: pages-\$\{\{ github\.repository \}\}/);
  assert.match(commitWorkflow, /workflow_run:/);
  assert.match(commitWorkflow, /contents: write/);
  assert.match(commitWorkflow, /actions: read/);
  assert.match(commitWorkflow, /EXPECTED_HEAD_SHA/);
  assert.match(commitWorkflow, /workflow_conclusion.*!= success/,
    "the trusted writer must skip output if any docs workflow validation or build failed");
  assert.match(commitScript, /sourceRun\.conclusion !== "success"/,
    "the writer helper must also reject output from failed docs workflows");
  assert.match(commitWorkflow, /\.state.*!= open/,
    "closed pull requests must be reported as successful no-ops");
  assert.match(commitWorkflow, /echo "eligible=false"/);
  assert.match(commitWorkflow, /skip_auto_commit "pull request #\$pr_number is closed or no longer open\."/);
  assert.match(commitWorkflow, /GITHUB_STEP_SUMMARY/);
  assert.match(commitScript, /validateGeneratedDocsArtifact/);
  assert.match(commitScript, /EXPECTED_HEAD_SHA/);
  assert.match(commitScript, /sourceJobs/);
  assert.match(commitScript, /generated_docs_pr_checks/);
  assert.match(commitScript, /pr_number: pullRequestNumber/);
  assert.match(trustedWorkflow, /repository_dispatch:/);
  assert.doesNotMatch(trustedWorkflow, /workflow_dispatch:/);
  assert.match(trustedWorkflow, /persist-credentials: false/);
  assert.match(trustedWorkflow, /checks: write/);
  assert.doesNotMatch(trustedWorkflow, /contents: write/);
  assert.match(trustedWorkflow, /record-trusted-pr-checks\.mjs/);
  for (const branchWorkflow of [workflow, ciWorkflow, titleWorkflow]) {
    assert.doesNotMatch(branchWorkflow, /workflow_dispatch:/,
      "generated-docs updates must only dispatch trusted default-branch workflow definitions");
  }
  assert.doesNotMatch(commitScript, /changedControlFiles|\.github\/workflows|\.github\/actions/,
    "trusted default-branch verifier should allow workflow-control PRs through the same safe path");
});
