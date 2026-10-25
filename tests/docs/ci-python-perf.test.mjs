import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const workflowPath = (name) => path.join(root, ".github/workflows", name);
const load = (name) => yaml.load(readFileSync(workflowPath(name), "utf8"));

test("pull request unit workflows run the Python client unit suite", () => {
  for (const name of ["ci.yml", "trusted-pr-checks.yml"]) {
    const workflow = load(name);
    const commands = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "");
    assert.ok(
      commands.some((command) => command.trim() === "npm run client:test:py"),
      `${name} does not run the Python client unit suite`,
    );
  }
});

test("performance workflow runs on main and preserves its report artifact", () => {
  const workflow = load("perf.yml");
  const triggers = workflow.on ?? workflow[true];
  assert.ok(triggers.push?.branches?.includes("main"));
  assert.ok(triggers.schedule?.length);
  const steps = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? []);
  assert.ok(steps.some((step) => step.run?.includes("npm run perf")));
  assert.ok(
    steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")),
    "perf workflow does not upload its report",
  );
});
