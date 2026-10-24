import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const workflowFile = path.join(root, ".github/workflows/release-auto-merge.yml");
const scriptFile = path.join(root, "scripts/release/auto-merge-release-pr.mjs");

// Imported lazily so a missing script fails each test with its own message
// rather than aborting the file before any test is reported.
const load = () => import(scriptFile);

const NOW = Date.parse("2026-10-24T12:00:00Z");
const HEAD = "a".repeat(40);
const REQUIRED = [
  "Typecheck and unit tests",
  "Static export build",
  "Conventional commit",
  "Check and build docs",
  "REST API end to end",
  "Package examples against local API",
];

function releasePull(overrides = {}) {
  return {
    number: 450,
    draft: false,
    user: { login: "partwrite-3d[bot]", type: "Bot" },
    labels: [{ name: "autorelease: pending" }],
    head: { ref: "release-please--branches--main--components--sketchforge", sha: HEAD },
    base: { ref: "main" },
    mergeable: true,
    ...overrides,
  };
}

function checkRun(name, overrides = {}) {
  return { id: 1, name, status: "completed", conclusion: "success", app: { id: 15368 }, check_suite: { id: 7 }, ...overrides };
}

// Everything a safe merge needs. Each refusal test changes exactly one input,
// so a test that still merged would show which condition the code ignores.
function safeInputs(overrides = {}) {
  return {
    appLogin: "partwrite-3d[bot]",
    autoMergeVariable: "",
    pulls: [
      releasePull(),
      { ...releasePull({ number: 12, labels: [], user: { login: "someone", type: "User" }, head: { ref: "feat/x", sha: "b".repeat(40) } }) },
    ],
    pull: releasePull(),
    compare: { behind_by: 0, ahead_by: 1 },
    checkRuns: [...REQUIRED.map((name, i) => checkRun(name, { id: i + 10 })), checkRun("Deploy docs to GitHub Pages", { id: 99, conclusion: "skipped" })],
    statuses: [],
    requiredChecks: REQUIRED,
    latestMainCommitDate: "2026-10-24T11:00:00Z",
    releaseRuns: [{ name: "Release", status: "completed", conclusion: "success" }],
    now: NOW,
    ...overrides,
  };
}

test("a refreshed, green, unheld release pull request on a quiet main is merged at its head commit", async () => {
  const { decide } = await load();
  const decision = decide(safeInputs());
  assert.equal(decision.merge, true, decision.reason);
  assert.equal(decision.number, 450);
  assert.equal(decision.sha, HEAD);
});

const refusals = [
  ["no pending release pull request", { pulls: [], pull: undefined }, /no open release pull request/i],
  ["two pending release pull requests", { pulls: [releasePull(), releasePull({ number: 451 })] }, /2 open release pull requests/i],
  ["a draft", { pull: releasePull({ draft: true }), pulls: [releasePull({ draft: true })] }, /draft/i],
  ["another author", { pull: releasePull({ user: { login: "mallory", type: "User" } }), pulls: [releasePull({ user: { login: "mallory", type: "User" } })] }, /authored by mallory/i],
  ["another branch", { pull: releasePull({ head: { ref: "feature/release", sha: HEAD } }), pulls: [releasePull({ head: { ref: "feature/release", sha: HEAD } })] }, /branch feature\/release/i],
  ["another base", { pull: releasePull({ base: { ref: "next" } }), pulls: [releasePull({ base: { ref: "next" } })] }, /targets next/i],
  ["the hold label", { pull: releasePull({ labels: [{ name: "autorelease: pending" }, { name: "release: hold" }] }) }, /release: hold/],
  ["the repository variable set to false", { autoMergeVariable: "false" }, /RELEASE_AUTO_MERGE/],
  ["the repository variable set to FALSE", { autoMergeVariable: " FALSE " }, /RELEASE_AUTO_MERGE/],
  ["a branch behind main", { compare: { behind_by: 2, ahead_by: 1 } }, /2 commits? behind main/i],
  ["a merge conflict", { pull: releasePull({ mergeable: false }) }, /conflict/i],
  ["a failed check", { checkRuns: [...REQUIRED.map((name, i) => checkRun(name, { id: i })), checkRun("Unit tests on Windows", { id: 50, conclusion: "failure" })] }, /Unit tests on Windows.*failure/],
  ["a cancelled check", { checkRuns: [...REQUIRED.map((name, i) => checkRun(name, { id: i })), checkRun("Analyze (python)", { id: 50, conclusion: "cancelled" })] }, /Analyze \(python\).*cancelled/],
  ["a check still running", { checkRuns: [...REQUIRED.map((name, i) => checkRun(name, { id: i })), checkRun("REST API end to end", { id: 50, status: "in_progress", conclusion: null })] }, /REST API end to end.*in_progress/],
  ["a required check that never ran", { checkRuns: REQUIRED.slice(1).map((name, i) => checkRun(name, { id: i })) }, /missing.*Typecheck and unit tests/i],
  ["a failed commit status", { statuses: [{ context: "external/ci", state: "failure" }] }, /external\/ci.*failure/],
  ["a pending commit status", { statuses: [{ context: "external/ci", state: "pending" }] }, /external\/ci.*pending/],
  ["main merged into ten minutes ago", { latestMainCommitDate: "2026-10-24T11:50:00Z" }, /10 minutes ago/],
  ["a release run in progress", { releaseRuns: [{ name: "Release", status: "in_progress" }] }, /Release.*in_progress/],
  ["a release-please run queued", { releaseRuns: [{ name: "Release Please", status: "queued" }] }, /Release Please.*queued/],
];

for (const [label, overrides, reason] of refusals) {
  test(`refuses to merge with ${label}`, async () => {
    const { decide } = await load();
    const decision = decide(safeInputs(overrides));
    assert.equal(decision.merge, false, `merged despite ${label}`);
    assert.match(decision.reason, reason);
  });
}

test("a check re-run that passed supersedes the failed attempt with the same name", async () => {
  const { decide } = await load();
  const checkRuns = [
    ...REQUIRED.map((name, i) => checkRun(name, { id: i + 10 })),
    checkRun("Typecheck and unit tests", { id: 5, conclusion: "failure" }),
  ];
  assert.equal(decide(safeInputs({ checkRuns })).merge, true);
  const reversed = [...REQUIRED.map((name, i) => checkRun(name, { id: i + 10 })), checkRun("Typecheck and unit tests", { id: 500, conclusion: "failure" })];
  assert.equal(decide(safeInputs({ checkRuns: reversed })).merge, false);
});

test("a same-named job from another workflow does not hide a failure", async () => {
  const { decide } = await load();
  const checkRuns = [
    ...REQUIRED.map((name, i) => checkRun(name, { id: i + 10 })),
    checkRun("Conventional commit", { id: 500, check_suite: { id: 8 } }),
    checkRun("Conventional commit", { id: 5, check_suite: { id: 9 }, conclusion: "failure" }),
  ];
  const decision = decide(safeInputs({ checkRuns }));
  assert.equal(decision.merge, false);
  assert.match(decision.reason, /Conventional commit \(failure\)/);
});

test("a required context reported as a commit status counts as present", async () => {
  const { decide } = await load();
  const checkRuns = REQUIRED.slice(1).map((name, i) => checkRun(name, { id: i }));
  const statuses = [{ context: "Typecheck and unit tests", state: "success" }];
  assert.equal(decide(safeInputs({ checkRuns, statuses })).merge, true);
});

function fakeApi({ rules, rulesError } = {}) {
  const inputs = safeInputs();
  const calls = [];
  return {
    calls,
    async get(route) {
      calls.push(route);
      if (route.startsWith("repos/o/r/pulls?")) return inputs.pulls;
      if (route === "repos/o/r/pulls/450") return inputs.pull;
      if (route.startsWith("repos/o/r/compare/")) return inputs.compare;
      if (route === "repos/o/r/rules/branches/main") {
        if (rulesError) throw new Error("HTTP 403: Resource not accessible by integration");
        return rules;
      }
      if (route === "repos/o/r/commits/main") return { commit: { committer: { date: inputs.latestMainCommitDate } } };
      if (route.includes("/actions/workflows/")) return { workflow_runs: [] };
      throw new Error(`unexpected route ${route}`);
    },
    async paginate(route) {
      calls.push(route);
      if (route.includes("/check-runs")) return [{ check_runs: inputs.checkRuns }];
      if (route.includes("/statuses")) return [[]];
      throw new Error(`unexpected route ${route}`);
    },
  };
}

test("the required checks are read from the main ruleset when the token can read it", async () => {
  const { gather, decide } = await load();
  const rules = [
    { type: "pull_request", parameters: {} },
    { type: "required_status_checks", parameters: { required_status_checks: [...REQUIRED, "Only in the ruleset"].map((context) => ({ context })) } },
  ];
  const api = fakeApi({ rules });
  const inputs = await gather(api, { repo: "o/r", appLogin: "partwrite-3d[bot]", now: NOW });
  assert.ok(inputs.requiredChecks.includes("Only in the ruleset"));
  assert.equal(inputs.requiredChecksSource, "ruleset");
  const decision = decide(inputs);
  assert.equal(decision.merge, false);
  assert.match(decision.reason, /missing.*Only in the ruleset/);
});

test("the required checks fall back to the known list when the ruleset cannot be read", async () => {
  const { gather, decide, FALLBACK_REQUIRED_CHECKS } = await load();
  assert.deepEqual([...FALLBACK_REQUIRED_CHECKS].sort(), [...REQUIRED].sort());
  const inputs = await gather(fakeApi({ rulesError: true }), { repo: "o/r", appLogin: "partwrite-3d[bot]", now: NOW });
  assert.equal(inputs.requiredChecksSource, "fallback");
  assert.deepEqual([...inputs.requiredChecks].sort(), [...REQUIRED].sort());
  assert.equal(decide(inputs).merge, true, decide(inputs).reason);
});

test("all three release workflows are checked for unfinished runs", async () => {
  const { gather } = await load();
  const api = fakeApi({ rulesError: true });
  await gather(api, { repo: "o/r", appLogin: "partwrite-3d[bot]", now: NOW });
  for (const file of ["release-please.yml", "release.yml", "desktop-release.yml"]) {
    assert.ok(api.calls.some((route) => route.includes(`/actions/workflows/${file}/runs`)), `${file} runs were not read`);
  }
});

test("main reports the decision to the step summary and outputs, and a dry run never asks for a merge", async () => {
  const { main } = await load();
  const dir = mkdtempSync(path.join(os.tmpdir(), "release-auto-merge-"));
  const summary = path.join(dir, "summary.md");
  const output = path.join(dir, "output");
  writeFileSync(summary, "");
  writeFileSync(output, "");
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, APP_SLUG: "partwrite-3d" };

  await main({ argv: [], env, api: fakeApi({ rulesError: true }), now: NOW, log: () => {} });
  assert.match(readFileSync(output, "utf8"), /merge=true\nnumber=450\nsha=a{40}\n/);
  assert.match(readFileSync(summary, "utf8"), /#450/);

  writeFileSync(output, "");
  await main({ argv: ["--dry-run"], env, api: fakeApi({ rulesError: true }), now: NOW, log: () => {} });
  assert.match(readFileSync(output, "utf8"), /merge=false/);
  assert.match(readFileSync(summary, "utf8"), /dry run/i);

  writeFileSync(output, "");
  await main({ argv: [], env: { ...env, RELEASE_AUTO_MERGE: "false" }, api: fakeApi({ rulesError: true }), now: NOW, log: () => {} });
  assert.match(readFileSync(output, "utf8"), /merge=false/);
  assert.match(readFileSync(summary, "utf8"), /RELEASE_AUTO_MERGE/);
});

// --- The workflow -----------------------------------------------------------

const workflow = () => {
  assert.ok(existsSync(workflowFile), "release-auto-merge.yml does not exist");
  return yaml.load(readFileSync(workflowFile, "utf8"));
};
const steps = () => Object.values(workflow().jobs).flatMap((job) => job.steps);

test("the workflow runs every four hours and on demand, one run at a time", () => {
  const wf = workflow();
  // js-yaml reads the bare `on` key as boolean true.
  const triggers = wf.on ?? wf[true];
  assert.deepEqual(Object.keys(triggers).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(triggers.schedule.length, 1);
  assert.match(triggers.schedule[0].cron, /^\d{1,2} \*\/4 \* \* \*$/);
  assert.notEqual(triggers.schedule[0].cron.split(" ")[0], "0", "the top of the hour is when GitHub's scheduler is busiest");
  assert.ok(wf.concurrency?.group, "needs its own concurrency group");
  assert.equal(wf.concurrency["cancel-in-progress"], false);
});

test("the default token only reads", () => {
  const wf = workflow();
  const scopes = [wf.permissions, ...Object.values(wf.jobs).map((job) => job.permissions)].filter(Boolean);
  for (const scope of scopes) {
    for (const [name, level] of Object.entries(scope)) assert.notEqual(level, "write", `GITHUB_TOKEN has ${name}: write`);
  }
});

test("the merge uses the release app's token, so release-please runs on the merge commit", () => {
  const all = steps();
  const mint = all.find((step) => String(step.uses ?? "").startsWith("actions/create-github-app-token@v2"));
  assert.ok(mint, "the release app token is never minted");
  assert.match(mint.with["app-id"], /secrets\.APP_ID/);
  assert.match(mint.with["private-key"], /secrets\.APP_KEY/);

  const merge = all.find((step) => /gh pr merge/.test(step.run ?? ""));
  assert.ok(merge, "no step merges the pull request");
  assert.match(merge.env.GH_TOKEN, new RegExp(`steps\\.${mint.id}\\.outputs\\.token`),
    "a merge made with GITHUB_TOKEN starts no workflow, so nothing would be tagged or published");
  assert.match(merge.run, /--squash/);
  assert.match(merge.run, /--match-head-commit/);
  assert.match(merge.if ?? "", /merge == 'true'/);
  assert.match(merge.if ?? "", /dry_run/);
});

test("the workflow never bypasses the ruleset and keeps event fields out of its scripts", () => {
  for (const step of steps()) {
    assert.doesNotMatch(step.run ?? "", /--admin/, `step "${step.name}" bypasses the ruleset`);
    assert.doesNotMatch(step.run ?? "", /\$\{\{/, `step "${step.name}" interpolates an expression into its script`);
  }
  const decide = steps().find((step) => /auto-merge-release-pr\.mjs/.test(step.run ?? ""));
  assert.ok(decide, "the decision script is not run");
  assert.match(decide.env.RELEASE_AUTO_MERGE, /vars\.RELEASE_AUTO_MERGE/);
});
