import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const workflowPath = (name) => path.join(root, ".github/workflows", name);
const load = (name) => yaml.load(readFileSync(workflowPath(name), "utf8"));

test("CI grants read-only contents access and cancels superseded PR runs", () => {
  const workflow = load("ci.yml");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(workflow.concurrency.group, /github\.event\.pull_request\.number/);
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
});

test("CI actions are pinned to full SHAs with version comments", () => {
  for (const name of ["ci.yml", "perf.yml"]) {
    const source = readFileSync(workflowPath(name), "utf8");
    const workflow = load(name);
    const uses = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter((reference) => reference && !reference.startsWith("./"));
    assert.ok(uses.length > 0, `${name} has no external actions`);
    for (const reference of uses) {
      assert.match(reference, /^[^@]+@[a-f0-9]{40}$/, `${name}: ${reference} is not SHA-pinned`);
      assert.ok(
        source.split("\n").some((line) =>
          line.includes(`uses: ${reference}`) && /# v\d/.test(line),
        ),
        `${name}: ${reference} has no version comment`,
      );
    }
  }
});

test("Dependabot checks GitHub Actions and grouped npm dependencies weekly", () => {
  const dependabot = yaml.load(readFileSync(path.join(root, ".github/dependabot.yml"), "utf8"));
  assert.deepEqual(
    dependabot.updates.map(({ "package-ecosystem": ecosystem, schedule }) => [ecosystem, schedule.interval]),
    [["github-actions", "weekly"], ["npm", "weekly"]],
  );
  const npm = dependabot.updates.find(({ "package-ecosystem": ecosystem }) => ecosystem === "npm");
  assert.ok(npm.groups);
  assert.ok(Object.keys(npm.groups).length > 0, "npm updates are not grouped");
});
