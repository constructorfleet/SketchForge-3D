#!/usr/bin/env node
// Decides whether the standing release-please pull request is safe to merge,
// for .github/workflows/release-auto-merge.yml. Merging it is the release: it
// is tagged and release.yml publishes to Docker, npm and PyPI, which cannot be
// withdrawn. So this only decides; the workflow merges, with the release app's
// token, when this writes `merge=true` to $GITHUB_OUTPUT.
//
// Every refusal is a normal outcome, not an error: the reason goes to the step
// summary and the process exits 0, and the next scheduled run looks again.
//
//   node scripts/release/auto-merge-release-pr.mjs [--dry-run]
//
// Reads only. Locally it uses your own `gh` login and GITHUB_REPOSITORY
// (default constructorfleet/SketchForge-3D).

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const PENDING_LABEL = "autorelease: pending";
export const HOLD_LABEL = "release: hold";
export const BRANCH_PREFIX = "release-please--";
export const BASE = "main";
export const QUIET_MINUTES = 30;
export const RELEASE_WORKFLOWS = ["release-please.yml", "release.yml", "desktop-release.yml"];
// What the main ruleset requires today. Used only when the ruleset cannot be
// read, so that a token without access still refuses a pull request that is
// missing one of them.
export const FALLBACK_REQUIRED_CHECKS = [
  "Typecheck and unit tests",
  "Static export build",
  "Conventional commit",
  "Check and build docs",
  "REST API end to end",
  "Package examples against local API",
];

const PASSING = new Set(["success", "skipped", "neutral"]);

const refuse = (reason) => ({ merge: false, reason });

// A re-run leaves the earlier attempt in the same check suite under the same
// name; only the newest attempt counts. Same-named jobs from different
// workflows are separate suites, and every one of them must pass.
export function latestCheckRuns(runs) {
  const latest = new Map();
  for (const run of runs) {
    const key = `${run.check_suite?.id ?? run.app?.id ?? ""}\u0000${run.name}`;
    const seen = latest.get(key);
    if (!seen || run.id > seen.id) latest.set(key, run);
  }
  return [...latest.values()];
}

// The statuses endpoint lists every state a context has had, newest first.
export function latestStatuses(statuses) {
  const latest = new Map();
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status);
  return [...latest.values()];
}

export function requiredChecksFromRules(rules) {
  if (!Array.isArray(rules)) return [];
  return [...new Set(rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context))];
}

export function decide(inputs) {
  const {
    appLogin, autoMergeVariable, pulls, pull, compare, checkRuns = [], statuses = [],
    requiredChecks, latestMainCommitDate, releaseRuns = [], now,
  } = inputs;

  const pending = pulls.filter((candidate) => candidate.labels.some((label) => label.name === PENDING_LABEL));
  if (pending.length === 0) return refuse(`There is no open release pull request labelled \`${PENDING_LABEL}\`.`);
  if (pending.length > 1) {
    return refuse(`There are ${pending.length} open release pull requests labelled \`${PENDING_LABEL}\` (${pending.map((p) => `#${p.number}`).join(", ")}); expected exactly one.`);
  }
  const pr = pull ?? pending[0];
  const ref = `#${pr.number}`;
  if (pr.draft) return refuse(`${ref} is a draft.`);
  if (pr.user?.login !== appLogin) return refuse(`${ref} is authored by ${pr.user?.login}, not the release app (${appLogin}).`);
  if (!pr.head.ref.startsWith(BRANCH_PREFIX)) return refuse(`${ref} is on branch ${pr.head.ref}, not a \`${BRANCH_PREFIX}\` branch.`);
  if (pr.base.ref !== BASE) return refuse(`${ref} targets ${pr.base.ref}, not ${BASE}.`);

  if (pr.labels.some((label) => label.name === HOLD_LABEL)) return refuse(`${ref} carries the \`${HOLD_LABEL}\` label.`);
  if (String(autoMergeVariable ?? "").trim().toLowerCase() === "false") {
    return refuse("The repository variable `RELEASE_AUTO_MERGE` is `false`, so releases are on hold.");
  }

  if (compare.behind_by !== 0) {
    return refuse(`${ref} is ${compare.behind_by} commit${compare.behind_by === 1 ? "" : "s"} behind ${BASE}; release-please has not refreshed it since the latest merge.`);
  }
  if (pr.mergeable === false) return refuse(`${ref} has a merge conflict with ${BASE}.`);

  const runs = latestCheckRuns(checkRuns);
  const contexts = latestStatuses(statuses);
  const unfinished = [
    ...runs.filter((run) => run.status !== "completed").map((run) => `${run.name} (${run.status})`),
    ...contexts.filter((status) => status.state === "pending").map((status) => `${status.context} (pending)`),
  ];
  if (unfinished.length) return refuse(`Checks on ${ref} have not finished: ${unfinished.join(", ")}.`);
  const failing = [
    ...runs.filter((run) => !PASSING.has(run.conclusion)).map((run) => `${run.name} (${run.conclusion})`),
    ...contexts.filter((status) => status.state !== "success").map((status) => `${status.context} (${status.state})`),
  ];
  if (failing.length) return refuse(`Checks on ${ref} did not pass: ${failing.join(", ")}.`);
  const reported = new Set([...runs.map((run) => run.name), ...contexts.map((status) => status.context)]);
  const missing = requiredChecks.filter((name) => !reported.has(name));
  if (missing.length) return refuse(`Required checks are missing on ${ref}: ${missing.join(", ")}.`);

  const quietFor = Math.floor((now - Date.parse(latestMainCommitDate)) / 60000);
  if (!(quietFor >= QUIET_MINUTES)) {
    return refuse(`${BASE} last changed ${quietFor} minutes ago; waiting until it has been quiet for ${QUIET_MINUTES} minutes so a burst of merges goes out as one release.`);
  }

  const active = releaseRuns.filter((run) => run.status !== "completed");
  if (active.length) return refuse(`A release workflow is still running: ${active.map((run) => `${run.name} (${run.status})`).join(", ")}.`);

  return { merge: true, number: pr.number, sha: pr.head.sha, reason: `${ref} is safe to merge at ${pr.head.sha}.` };
}

// Reads everything decide() needs. Stops early once the pull request itself
// rules the merge out, so an idle run makes one request.
export async function gather(api, { repo, appLogin, autoMergeVariable = "", now }) {
  const pulls = await api.get(`repos/${repo}/pulls?state=open&per_page=100`);
  const base = { appLogin, autoMergeVariable, pulls, now, requiredChecks: FALLBACK_REQUIRED_CHECKS, requiredChecksSource: "fallback" };
  const pending = pulls.filter((candidate) => candidate.labels.some((label) => label.name === PENDING_LABEL));
  if (pending.length !== 1) return base;

  const pull = await api.get(`repos/${repo}/pulls/${pending[0].number}`);
  const sha = pull.head.sha;
  const [compare, checkPages, statusPages, mainCommit, required, releaseRuns] = await Promise.all([
    api.get(`repos/${repo}/compare/${BASE}...${sha}`),
    api.paginate(`repos/${repo}/commits/${sha}/check-runs?per_page=100`),
    api.paginate(`repos/${repo}/commits/${sha}/statuses?per_page=100`),
    api.get(`repos/${repo}/commits/${BASE}`),
    readRequiredChecks(api, repo),
    Promise.all(RELEASE_WORKFLOWS.map((file) => api.get(`repos/${repo}/actions/workflows/${file}/runs?per_page=20`)))
      .then((responses) => responses.flatMap((response) => response.workflow_runs)),
  ]);
  return {
    ...base,
    pull,
    compare,
    checkRuns: checkPages.flatMap((page) => page.check_runs),
    statuses: statusPages.flat(),
    latestMainCommitDate: mainCommit.commit.committer.date,
    releaseRuns,
    ...required,
  };
}

async function readRequiredChecks(api, repo) {
  try {
    const checks = requiredChecksFromRules(await api.get(`repos/${repo}/rules/branches/${BASE}`));
    if (checks.length) return { requiredChecks: checks, requiredChecksSource: "ruleset" };
  } catch {
    // The token cannot read the ruleset; the known list still applies.
  }
  return { requiredChecks: FALLBACK_REQUIRED_CHECKS, requiredChecksSource: "fallback" };
}

const execFileAsync = promisify(execFile);

export const ghApi = {
  async get(route) {
    const { stdout } = await execFileAsync("gh", ["api", route], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  },
  async paginate(route) {
    const { stdout } = await execFileAsync("gh", ["api", "--paginate", "--slurp", route], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  },
};

export async function main({ argv = process.argv.slice(2), env = process.env, api = ghApi, now = Date.now(), log = console.log } = {}) {
  const dryRun = argv.includes("--dry-run") || String(env.DRY_RUN ?? "").toLowerCase() === "true";
  const repo = env.GITHUB_REPOSITORY || "constructorfleet/SketchForge-3D";
  const appLogin = `${env.APP_SLUG || "partwrite-3d"}[bot]`;
  const inputs = await gather(api, { repo, appLogin, autoMergeVariable: env.RELEASE_AUTO_MERGE, now });
  const decision = decide(inputs);
  const merge = decision.merge && !dryRun;

  const lines = [
    "## Release auto-merge",
    "",
    decision.merge ? `**Merge.** ${decision.reason}` : `**No merge.** ${decision.reason}`,
  ];
  if (decision.merge && dryRun) lines.push("", "This is a dry run, so the pull request is left open.");
  if (inputs.pull) lines.push("", `Required checks read from the ${inputs.requiredChecksSource === "ruleset" ? "main ruleset" : "built-in list (the ruleset could not be read)"}.`);
  const summary = `${lines.join("\n")}\n`;
  log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, merge ? `merge=true\nnumber=${decision.number}\nsha=${decision.sha}\n` : "merge=false\n");
  }
  return { ...decision, merge, dryRun };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
