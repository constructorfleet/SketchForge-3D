import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { GENERATED_DOC_PATHS, isRepositoryFullName } from "./validate-generated-docs-artifact.mjs";

const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const token = process.env.GITHUB_TOKEN;
const repairBranch = "automation/generated-docs-refresh";

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

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function gitBlobSha(contents) {
  return createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");
}

async function skip(message) {
  const summary = `Generated docs main repair skipped: ${message}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await (await import("node:fs/promises")).appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

async function listArtifactFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Generated artifact contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await listArtifactFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Generated artifact contains a non-file entry: ${relative}`);
  }
  return files;
}

async function validateArtifact({ repo, defaultBranch, headSha }) {
  const directory = path.resolve(required("ARTIFACT_DIR"));
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.repo !== repo || manifest.event !== "push" || manifest.ref !== `refs/heads/${defaultBranch}` || manifest.headSha !== headSha) {
    throw new Error("Generated docs artifact does not match the trusted default-branch push");
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(GENERATED_DOC_PATHS)) {
    throw new Error("Generated docs artifact file allowlist does not match");
  }
  const actual = (await listArtifactFiles(directory)).sort();
  const expected = [...GENERATED_DOC_PATHS, "manifest.json"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Generated docs artifact contains unexpected files");
  for (const relative of GENERATED_DOC_PATHS) {
    const metadata = await lstat(path.join(directory, relative));
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Generated docs output is not a regular file: ${relative}`);
  }
  return GENERATED_DOC_PATHS;
}

async function main() {
  const repo = required("EXPECTED_REPO");
  const defaultBranch = required("EXPECTED_DEFAULT_BRANCH");
  const expectedSha = required("EXPECTED_HEAD_SHA");
  const sourceRunId = required("DOCS_SOURCE_RUN_ID");
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  if (!isRepositoryFullName(repo)) throw new Error("Invalid repository name");
  if (!/^[A-Za-z0-9_.-]+$/.test(defaultBranch)) throw new Error("Invalid default branch name");
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("Invalid expected commit SHA");
  if (!/^\d+$/.test(sourceRunId)) throw new Error("Invalid source workflow run ID");

  const sourceRun = await apiRequest(repo, `actions/runs/${sourceRunId}`);
  if (sourceRun.event !== "push" || sourceRun.name !== "Documentation site" || sourceRun.head_branch !== defaultBranch
    || sourceRun.head_sha !== expectedSha || sourceRun.repository?.full_name !== repo || sourceRun.head_repository?.full_name !== repo) {
    await skip("source run is not a default-branch docs push for the expected repository and SHA.");
    return;
  }
  if (sourceRun.conclusion !== "success") {
    await skip(`documentation site workflow concluded ${sourceRun.conclusion ?? "unknown"}.`);
    return;
  }
  const jobs = await apiRequest(repo, `actions/runs/${sourceRunId}/jobs?per_page=100`);
  const generation = jobs.jobs?.flatMap(({ steps = [] }) => steps).find(({ name }) => name === "Generate documentation");
  if (generation?.conclusion !== "success") {
    await skip(`documentation generation concluded ${generation?.conclusion ?? "unknown"}.`);
    return;
  }

  const files = await validateArtifact({ repo, defaultBranch, headSha: expectedSha });
  const mainRef = await apiRequest(repo, `git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  if (mainRef.object?.sha !== expectedSha) {
    await skip("default branch advanced after the docs artifact was generated.");
    return;
  }
  const sourceCommit = await apiRequest(repo, `git/commits/${expectedSha}`);
  const sourceTree = await apiRequest(repo, `git/trees/${sourceCommit.tree.sha}?recursive=1`);
  if (sourceTree.truncated) throw new Error("Default branch tree was truncated; refusing to create a repair PR");
  const tracked = new Map(sourceTree.tree.filter(({ type }) => type === "blob").map(({ path: file, sha }) => [file, sha]));
  const changed = [];
  for (const relative of files) {
    const contents = await readFile(path.join(path.resolve(required("ARTIFACT_DIR")), relative));
    if (tracked.get(relative) === gitBlobSha(contents)) continue;
    const blob = await apiRequest(repo, "git/blobs", {
      method: "POST",
      body: { content: contents.toString("base64"), encoding: "base64" },
    });
    changed.push({ path: relative, mode: "100644", type: "blob", sha: blob.sha });
  }
  if (!changed.length) {
    console.log("Generated tracked documentation already matches the default branch.");
    return;
  }

  const latestMain = await apiRequest(repo, `git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  if (latestMain.object?.sha !== expectedSha) {
    await skip("default branch advanced while generated output was being prepared.");
    return;
  }
  const tree = await apiRequest(repo, "git/trees", {
    method: "POST",
    body: { base_tree: sourceCommit.tree.sha, tree: changed },
  });
  const commit = await apiRequest(repo, "git/commits", {
    method: "POST",
    body: {
      message: "docs: regenerate tracked reference artifacts",
      tree: tree.sha,
      parents: [expectedSha],
      author: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
      committer: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
    },
  });

  const branchPath = repairBranch.split("/").map(encodeURIComponent).join("/");
  let branchExists = false;
  try {
    await apiRequest(repo, `git/ref/heads/${branchPath}`);
    branchExists = true;
  } catch (error) {
    if (!String(error).includes("failed (404)")) throw error;
  }
  if (branchExists) {
    await apiRequest(repo, `git/refs/heads/${branchPath}`, { method: "PATCH", body: { sha: commit.sha, force: true } });
  } else {
    await apiRequest(repo, "git/refs", { method: "POST", body: { ref: `refs/heads/${repairBranch}`, sha: commit.sha } });
  }

  const head = `${repo.split("/")[0]}:${repairBranch}`;
  const matchingPulls = await apiRequest(repo, `pulls?state=all&head=${encodeURIComponent(head)}&base=${encodeURIComponent(defaultBranch)}`);
  let pullRequest;
  if (matchingPulls.length) {
    pullRequest = matchingPulls[0];
    if (pullRequest.state === "closed") {
      pullRequest = await apiRequest(repo, `pulls/${pullRequest.number}`, { method: "PATCH", body: { state: "open" } });
    }
  } else {
    pullRequest = await apiRequest(repo, "pulls", {
      method: "POST",
      body: {
        title: "docs: refresh generated references",
        head: repairBranch,
        base: defaultBranch,
        body: `This PR refreshes tracked documentation generated from ${expectedSha}.\n\nThe generated pages came from the successful [Documentation site run](https://github.com/${repo}/actions/runs/${sourceRunId}) and were validated against the strict generated-file allowlist. Main remains unchanged until this repair PR is merged.`,
      },
    });
  }
  await apiRequest(repo, "dispatches", {
    method: "POST",
    body: { event_type: "generated_docs_pr_checks", client_payload: { expected_sha: commit.sha, pr_number: pullRequest.number } },
  });
  console.log(`Opened or refreshed ${pullRequest.html_url} with ${changed.length} generated files; main will be current when that PR is merged.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
