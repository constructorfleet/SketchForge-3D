import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const workflowPath = (name) => path.join(root, ".github/workflows", name);
const load = (name) => yaml.load(readFileSync(workflowPath(name), "utf8"));

// A push to a pull request starts a fresh run of every pull_request workflow,
// and without a concurrency group the superseded run kept its runners busy to
// the end -- the Windows unit job and the docs build alone take most of a
// runner-hour. Each of these must cancel the older run of the same pull
// request, and only that one: a group keyed on the workflow alone would let
// one pull request cancel another's checks.
const pullRequestWorkflows = [
  "ci.yml",
  "docs.yml",
  "docs-external-links.yml",
  "pr-title.yml",
];

for (const name of pullRequestWorkflows) {
  test(`${name} cancels a superseded run of the same pull request`, () => {
    const { concurrency } = load(name);
    assert.ok(concurrency, `${name} has no workflow-level concurrency group`);
    assert.match(
      concurrency.group,
      /github\.event\.pull_request\.number/,
      `${name} must group runs by pull request`,
    );
    assert.match(
      concurrency.group,
      /github\.ref/,
      `${name} must fall back to the ref outside pull requests`,
    );
    assert.match(
      String(concurrency["cancel-in-progress"]),
      /github\.event_name == 'pull_request'/,
      `${name} must cancel in-progress runs for pull requests`,
    );
  });
}

// A run on main is the record for that commit: the docs run deploys Pages and
// feeds the generated-docs repair, and CI on main is what a red main is
// diagnosed from. Those must finish even when another merge lands.
for (const name of ["ci.yml", "docs.yml"]) {
  test(`${name} does not cancel runs on main`, () => {
    const cancel = String(load(name).concurrency["cancel-in-progress"]);
    assert.notEqual(
      cancel,
      "true",
      `${name} would cancel a run on main when the next merge lands`,
    );
  });
}

test("trusted PR checks cancel an older dispatch for the same pull request", () => {
  const { concurrency } = load("trusted-pr-checks.yml");
  assert.ok(concurrency, "trusted-pr-checks.yml has no concurrency group");
  assert.match(
    concurrency.group,
    /github\.event\.client_payload\.pr_number/,
    "group must be per pull request",
  );
  assert.equal(concurrency["cancel-in-progress"], true);
});

// Nothing supersedes the last push of a pull request that is merged or
// closed, so its runs went on after the result stopped mattering.
test("closing a pull request cancels its unfinished runs", () => {
  const name = "cancel-closed-pr-runs.yml";
  assert.ok(existsSync(workflowPath(name)), `${name} does not exist`);
  const workflow = load(name);
  // js-yaml reads the bare `on` key as boolean true.
  const triggers = workflow.on ?? workflow[true];
  assert.deepEqual(
    Object.keys(triggers),
    ["pull_request_target"],
    "only pull_request_target can cancel runs from forks",
  );
  assert.deepEqual(triggers.pull_request_target.types, ["closed"]);
  assert.deepEqual(workflow.permissions, { actions: "write" });

  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  // pull_request_target runs with a write token; checking out the pull
  // request's code under it would hand that token to the pull request.
  assert.ok(
    steps.every(
      (step) => !String(step.uses ?? "").startsWith("actions/checkout"),
    ),
    `${name} must not check out code`,
  );

  const script = steps.map((step) => step.run ?? "").join("\n");
  assert.match(
    script,
    /event=pull_request/,
    "only pull_request runs belong to the closed pull request",
  );
  assert.match(
    script,
    /HEAD_REPOSITORY/,
    "a fork's branch can share its name with one here; the head repository must match",
  );
  assert.match(
    script,
    /CLOSED_AT/,
    "a run started after the close belongs to a new pull request on the same branch",
  );
  assert.match(script, /gh run cancel/);
  for (const step of steps) {
    assert.doesNotMatch(
      step.run ?? "",
      /\$\{\{/,
      "event fields reach the script through env, never interpolated into it",
    );
  }
});
