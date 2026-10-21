import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { isRepositoryFullName, validateGeneratedDocsArtifact } from "./validate-generated-docs-artifact.mjs";

const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const token = process.env.GITHUB_TOKEN;

async function apiRequest(repo, resource, { method = "GET", body } = {}) {
  const response = await fetch(`${apiUrl}/repos/${repo}/${resource}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { result = text; }
  if (!response.ok) throw new Error(`GitHub API ${method} ${resource} failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}

function gitBlobSha(contents) {
  return createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");
}

function assertEnvironment() {
  for (const name of ["GITHUB_TOKEN", "EXPECTED_REPO", "EXPECTED_PULL_REQUEST", "EXPECTED_HEAD_SHA", "EXPECTED_BASE_SHA", "EXPECTED_BRANCH", "EXPECTED_DEFAULT_BRANCH", "DOCS_SOURCE_RUN_ID", "ARTIFACT_DIR"]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  if (!isRepositoryFullName(process.env.EXPECTED_REPO)) throw new Error("Invalid repository name");
  if (!/^\d+$/.test(process.env.EXPECTED_PULL_REQUEST)) throw new Error("Invalid pull request number");
  if (!/^[a-f0-9]{40}$/.test(process.env.EXPECTED_HEAD_SHA) || !/^[a-f0-9]{40}$/.test(process.env.EXPECTED_BASE_SHA)) {
    throw new Error("Invalid expected commit SHA");
  }
  const branch = process.env.EXPECTED_BRANCH;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    throw new Error("Invalid target branch");
  }
  if (!/^\d+$/.test(process.env.DOCS_SOURCE_RUN_ID)) throw new Error("Invalid source workflow run ID");
}

async function skip(message) {
  const summary = `Generated docs auto-commit skipped: ${message}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

async function main() {
  assertEnvironment();
  const repo = process.env.EXPECTED_REPO;
  const pullRequestNumber = Number(process.env.EXPECTED_PULL_REQUEST);
  const expected = {
    artifactDir: process.env.ARTIFACT_DIR,
    repo,
    pullRequest: pullRequestNumber,
    headSha: process.env.EXPECTED_HEAD_SHA,
    baseSha: process.env.EXPECTED_BASE_SHA,
  };
  const sourceRun = await apiRequest(repo, `actions/runs/${process.env.DOCS_SOURCE_RUN_ID}`);
  if (sourceRun.event !== "pull_request" || sourceRun.name !== "Documentation site") {
    throw new Error("Source workflow run is not a Documentation site pull request run");
  }
  if (sourceRun.repository?.full_name !== repo || sourceRun.head_repository?.full_name !== repo) {
    throw new Error("Generated output is not from a same-repository pull request run");
  }
  if (sourceRun.conclusion !== "success") {
    await skip(`documentation site workflow concluded ${sourceRun.conclusion ?? "unknown"}.`);
    return;
  }
  const linkedPullRequest = sourceRun.pull_requests?.find(({ number }) => number === pullRequestNumber);
  if (!linkedPullRequest || linkedPullRequest.head?.sha !== expected.headSha || linkedPullRequest.base?.sha !== expected.baseSha) {
    throw new Error("Source workflow run does not match the expected pull request head and base");
  }
  const sourceJobs = await apiRequest(repo, `actions/runs/${process.env.DOCS_SOURCE_RUN_ID}/jobs?per_page=100`);
  const generationStep = sourceJobs.jobs?.flatMap((job) => job.steps ?? []).find(({ name }) => name === "Generate documentation");
  if (generationStep?.conclusion !== "success") throw new Error("Documentation generation did not complete successfully");

  const pullRequest = await apiRequest(repo, `pulls/${pullRequestNumber}`);
  if (pullRequest.state !== "open") {
    await skip(`pull request #${pullRequestNumber} is closed or no longer open.`);
    return;
  }
  if (pullRequest.base?.repo?.full_name !== repo || pullRequest.head?.repo?.full_name !== repo) {
    await skip(`pull request #${pullRequestNumber} no longer targets this repository.`);
    return;
  }
  if (pullRequest.head.sha !== expected.headSha || pullRequest.base.sha !== expected.baseSha || pullRequest.head.ref !== process.env.EXPECTED_BRANCH) {
    await skip(`pull request #${pullRequestNumber} advanced after its generated-docs artifact was produced.`);
    return;
  }
  if (pullRequest.base.ref !== process.env.EXPECTED_DEFAULT_BRANCH || pullRequest.head.ref === process.env.EXPECTED_DEFAULT_BRANCH) {
    await skip(`pull request #${pullRequestNumber} no longer targets the default branch from a feature branch.`);
    return;
  }

  const files = await validateGeneratedDocsArtifact(expected);

  const ref = await apiRequest(repo, `git/ref/heads/${process.env.EXPECTED_BRANCH}`);
  if (ref.object?.sha !== expected.headSha) {
    await skip(`target branch for pull request #${pullRequestNumber} advanced after generation.`);
    return;
  }
  const commit = await apiRequest(repo, `git/commits/${expected.headSha}`);
  const tree = await apiRequest(repo, `git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error("Repository tree response was truncated; refusing to commit generated output");
  const tracked = new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]));
  const generated = [];
  for (const relative of files) {
    const contents = await readFile(`${process.env.ARTIFACT_DIR}/${relative}`);
    const blobSha = gitBlobSha(contents);
    if (tracked.get(relative) === blobSha) continue;
    const blob = await apiRequest(repo, "git/blobs", {
      method: "POST",
      body: { content: contents.toString("base64"), encoding: "base64" },
    });
    generated.push({ path: relative, mode: "100644", type: "blob", sha: blob.sha });
  }
  let targetSha = expected.headSha;
  if (!generated.length) {
    console.log("Generated documentation already matches the PR branch; rechecking its current head.");
  } else {
    const newTree = await apiRequest(repo, "git/trees", {
      method: "POST",
      body: { base_tree: commit.tree.sha, tree: generated },
    });
    const newCommit = await apiRequest(repo, "git/commits", {
      method: "POST",
      body: {
        message: "docs: regenerate tracked reference artifacts",
        tree: newTree.sha,
        parents: [expected.headSha],
        author: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
        committer: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
      },
    });
    const branchPath = process.env.EXPECTED_BRANCH.split("/").map(encodeURIComponent).join("/");
    await apiRequest(repo, `git/refs/heads/${branchPath}`, {
      method: "PATCH",
      body: { sha: newCommit.sha, force: false },
    });
    const updatedRef = await apiRequest(repo, `git/ref/heads/${branchPath}`);
    if (updatedRef.object?.sha !== newCommit.sha) throw new Error("Generated-docs commit was not the PR branch tip");
    targetSha = newCommit.sha;
  }

  await apiRequest(repo, "dispatches", {
      method: "POST",
      body: {
        event_type: "generated_docs_pr_checks",
        client_payload: { expected_sha: targetSha, pr_number: pullRequestNumber },
      },
    });
  console.log(`Committed ${generated.length} generated documentation files${generated.length ? ` as ${targetSha}` : ""}; dispatched trusted PR checks for exact commit ${targetSha}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
