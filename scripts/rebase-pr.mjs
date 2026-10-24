#!/usr/bin/env node
// Rebase one pull-request branch onto its base and, with --push, publish it.
//
//   node scripts/rebase-pr.mjs --branch fix/foo [--base main] [--push] [--expect-head <sha>]
//
// docs/CHANGELOG.md merges with git's union driver (.gitattributes), so two
// PRs that each add an entry under "## Unreleased" no longer conflict: both
// entries are kept. Any other conflict needs a person. The rebase is aborted,
// the conflicting files are printed, and the script exits 2 so callers can
// tell "needs a human" from a real failure (exit 1).
//
// The push is --force-with-lease against the head that was rebased (or
// --expect-head), so a commit pushed to the branch meanwhile is never lost.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    branch: { type: "string" },
    base: { type: "string", default: "main" },
    remote: { type: "string", default: "origin" },
    push: { type: "boolean", default: false },
    "expect-head": { type: "string" },
  },
});
const { branch, base, remote, push } = values;
if (!branch) {
  console.error("usage: rebase-pr.mjs --branch <name> [--base main] [--push] [--expect-head <sha>]");
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

git("fetch", "--quiet", remote, base, branch);
const baseRef = `refs/remotes/${remote}/${base}`;
const branchRef = `refs/remotes/${remote}/${branch}`;
const head = values["expect-head"] ?? git("rev-parse", branchRef);

if (git("merge-base", baseRef, branchRef) === git("rev-parse", baseRef)) {
  console.log(`${branch} is already up to date with ${base}.`);
  process.exit(0);
}

git("checkout", "--quiet", "-B", branch, branchRef);
try {
  git("rebase", "--quiet", baseRef);
} catch {
  const conflicts = git("diff", "--name-only", "--diff-filter=U");
  git("rebase", "--abort");
  console.log(`${branch} conflicts with ${base} in:\n${conflicts.split("\n").map((file) => `  ${file}`).join("\n")}`);
  process.exit(2);
}

if (push) {
  git("push", "--quiet", `--force-with-lease=refs/heads/${branch}:${head}`, remote, `HEAD:refs/heads/${branch}`);
  console.log(`Rebased ${branch} onto ${base} and pushed ${git("rev-parse", "HEAD")}.`);
} else {
  console.log(`Rebased ${branch} onto ${base} locally; run with --push to publish it.`);
}
