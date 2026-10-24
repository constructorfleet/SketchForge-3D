import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

// Release 1.20.0 shipped without a Windows installer: the desktop release runs
// `npm test` on each platform, and a Windows-only failure in the unit suite
// stopped the build. Every ci.yml job ran on ubuntu, so nothing could have
// caught it before the release. The unit suite must run on Windows somewhere
// in pull-request CI for that class of defect to be visible.
test("the unit suite runs on Windows in pull-request CI", () => {
  const jobs = ci.split(/\n(?=  \w[\w-]*:\n)/);
  const windowsJobs = jobs.filter((job) => /runs-on:\s*windows-/.test(job));
  assert.ok(windowsJobs.length > 0, "ci.yml defines no windows-* job, so a Windows-only break first appears in a release");
  assert.ok(
    windowsJobs.some((job) => /run:\s*npm test\b/.test(job)),
    "a windows-* job exists but none runs `npm test`, so the unit suite is still unverified on Windows",
  );
});

test("pull requests trigger the workflow that holds the Windows job", () => {
  // A Windows job behind a path filter or a manual trigger would report on
  // nothing, which reads as coverage without being coverage.
  const trigger = ci.slice(ci.indexOf("on:"), ci.indexOf("jobs:"));
  assert.match(trigger, /pull_request:/, "ci.yml must run on pull_request for its Windows job to gate anything");
  assert.doesNotMatch(trigger, /pull_request:\s*\n\s+paths:/, "a path-filtered pull_request trigger would skip code-only changes");
});
