import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const workflow = yaml.load(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
);

test("pull request CI runs the documented production build", () => {
  const commands = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => (step.run ?? "").trim());

  assert.ok(
    commands.some((command) => command === "npm run build"),
    "ci.yml must run the production build documented in AGENTS.md",
  );
});
