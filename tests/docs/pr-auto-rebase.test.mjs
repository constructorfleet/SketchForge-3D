import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rebaseScript = path.join(root, "scripts/rebase-pr.mjs");
const workflowPath = path.join(root, ".github/workflows/pr-auto-rebase.yml");
const execFileAsync = promisify(execFile);

const changelogHeader = "# Changelog\n\n## Unreleased\n\n- Older entry.\n";

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function commitFile(cwd, file, contents, message) {
  await writeFile(path.join(cwd, file), contents);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", message);
}

// A bare "origin" and a clone of it, with main and one PR branch that both
// started from the same commit. The repository's own .gitattributes is
// copied in, so the test exercises the merge rule that ships.
async function fixture({ mainChanges, branchChanges }, callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sketchforge-pr-rebase-"));
  const origin = path.join(dir, "origin.git");
  const clone = path.join(dir, "clone");
  try {
    await git(dir, "init", "-q", "--bare", "-b", "main", origin);
    await git(dir, "clone", "-q", origin, clone);
    await git(clone, "config", "user.name", "Test");
    await git(clone, "config", "user.email", "test@example.com");
    await writeFile(path.join(clone, ".gitattributes"), await readFile(path.join(root, ".gitattributes"), "utf8"));
    await execFileAsync("mkdir", ["-p", path.join(clone, "docs")]);
    await writeFile(path.join(clone, "docs/CHANGELOG.md"), changelogHeader);
    await writeFile(path.join(clone, "code.txt"), "base\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-q", "-m", "base");
    await git(clone, "push", "-q", "origin", "main");

    await git(clone, "switch", "-q", "-c", "feature");
    for (const [file, contents] of Object.entries(branchChanges)) await commitFile(clone, file, contents, `feature ${file}`);
    await git(clone, "push", "-q", "origin", "feature");

    await git(clone, "switch", "-q", "main");
    for (const [file, contents] of Object.entries(mainChanges)) await commitFile(clone, file, contents, `main ${file}`);
    await git(clone, "push", "-q", "origin", "main");

    await callback({ origin, clone });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runRebase(cwd, ...args) {
  return execFileAsync("node", [rebaseScript, ...args], { cwd }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
}

test("two PRs adding changelog entries at the same place rebase without a conflict and keep both entries", async () => {
  await fixture({
    mainChanges: { "docs/CHANGELOG.md": changelogHeader.replace("- Older", "- Merged on main.\n- Older") },
    branchChanges: { "docs/CHANGELOG.md": changelogHeader.replace("- Older", "- From the PR.\n- Older") },
  }, async ({ origin, clone }) => {
    const result = await runRebase(clone, "--branch", "feature", "--base", "main", "--push");
    assert.equal(result.code, 0, result.stderr);

    const pushed = await git(origin, "show", "feature:docs/CHANGELOG.md");
    assert.match(pushed, /- Merged on main\./);
    assert.match(pushed, /- From the PR\./);
    assert.doesNotMatch(pushed, /<<<<<<<|>>>>>>>/);
    assert.equal(await git(origin, "merge-base", "main", "feature"), await git(origin, "rev-parse", "main"),
      "the pushed branch should sit on top of the current main");
  });
});

test("a conflict outside the changelog aborts, names the file, and leaves the remote branch untouched", async () => {
  await fixture({
    mainChanges: { "code.txt": "main\n" },
    branchChanges: { "code.txt": "feature\n" },
  }, async ({ origin, clone }) => {
    const before = await git(origin, "rev-parse", "feature");
    const result = await runRebase(clone, "--branch", "feature", "--base", "main", "--push");
    assert.equal(result.code, 2, "a conflict needing a person should exit 2, not 1");
    assert.match(result.stdout, /code\.txt/);
    assert.equal(await git(origin, "rev-parse", "feature"), before);
    assert.equal(await git(clone, "status", "--porcelain"), "", "the rebase should be aborted, not left half-done");
  });
});

test("a branch already on top of main is left alone", async () => {
  await fixture({ mainChanges: {}, branchChanges: { "code.txt": "feature\n" } }, async ({ origin, clone }) => {
    const before = await git(origin, "rev-parse", "feature");
    const result = await runRebase(clone, "--branch", "feature", "--base", "main", "--push");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /already up to date/i);
    assert.equal(await git(origin, "rev-parse", "feature"), before);
  });
});

test("the push refuses to overwrite a branch that moved after it was fetched", async () => {
  await fixture({
    mainChanges: { "docs/CHANGELOG.md": changelogHeader.replace("- Older", "- Merged on main.\n- Older") },
    branchChanges: { "docs/CHANGELOG.md": changelogHeader.replace("- Older", "- From the PR.\n- Older") },
  }, async ({ origin, clone }) => {
    const before = await git(origin, "rev-parse", "feature");
    const result = await runRebase(clone, "--branch", "feature", "--base", "main", "--push", "--expect-head", "f".repeat(40));
    assert.equal(result.code, 1, "the rebase itself succeeds; only the push may be refused");
    assert.match(result.stderr, /stale info|rejected/);
    assert.equal(await git(origin, "rev-parse", "feature"), before);
  });
});

test("the auto-rebase workflow runs on main, pushes as the app, and skips the release PR and forks", async () => {
  const yaml = await import("js-yaml");
  const workflow = yaml.load(await readFile(workflowPath, "utf8"));
  const on = workflow.on ?? workflow[true];
  assert.deepEqual(on.push.branches, ["main"]);
  const job = Object.values(workflow.jobs)[0];
  const steps = job.steps.map((step) => `${step.uses ?? ""}\n${step.run ?? ""}\n${JSON.stringify(step.with ?? {})}`).join("\n");
  // GITHUB_TOKEN pushes start no workflow runs, so a rebased PR would sit with no CI.
  assert.match(steps, /actions\/create-github-app-token/);
  assert.match(steps, /scripts\/rebase-pr\.mjs/);
  assert.match(steps, /release-please--/);
  assert.match(steps, /isCrossRepository|head\.repo\.full_name/);
  assert.match(steps, /--expect-head/);
  assert.ok(workflow.concurrency, "two merges in a row should not race to push the same branch");
});
