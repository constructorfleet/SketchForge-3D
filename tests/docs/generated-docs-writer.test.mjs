import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GENERATED_DOC_PATHS } from "../../scripts/docs/validate-generated-docs-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const newSha = "c".repeat(40);

async function withWriter({ staleBranch = false } = {}, callback) {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "sketchforge-generated-docs-writer-"));
  for (const relative of GENERATED_DOC_PATHS) {
    const target = path.join(artifactDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `generated ${relative}\n`);
  }
  await writeFile(path.join(artifactDir, "manifest.json"), JSON.stringify({
    repo: "constructorfleet/SketchForge-3D",
    pullRequest: 42,
    headSha,
    baseSha,
    files: GENERATED_DOC_PATHS,
  }));

  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(request.url, "http://localhost");
    const pathname = `${url.pathname}${url.search}`.replace(/^\/repos\/constructorfleet\/SketchForge-3D\//, "");
    requests.push({ method: request.method, pathname, body });
    let result = {};
    if (pathname === "actions/runs/123") {
      result = {
        event: "pull_request", name: "Documentation site",
        repository: { full_name: "constructorfleet/SketchForge-3D" },
        head_repository: { full_name: "constructorfleet/SketchForge-3D" },
        pull_requests: [{ number: 42, head: { sha: headSha }, base: { sha: baseSha } }],
      };
    } else if (pathname === "actions/runs/123/jobs?per_page=100") {
      result = { jobs: [{ steps: [{ name: "Generate documentation", conclusion: "success" }] }] };
    } else if (pathname.startsWith("pulls/42/files")) {
      result = [];
    } else if (pathname === "pulls/42") {
      result = {
        state: "open", title: "docs: refresh references",
        base: { sha: baseSha, ref: "main", repo: { full_name: "constructorfleet/SketchForge-3D" } },
        head: { sha: headSha, ref: "feature/docs", repo: { full_name: "constructorfleet/SketchForge-3D" } },
      };
    } else if (pathname === "git/ref/heads/feature/docs" && requests.filter((entry) => entry.pathname === pathname).length === 1) {
      result = { object: { sha: staleBranch ? "d".repeat(40) : headSha } };
    } else if (pathname === `git/commits/${headSha}`) {
      result = { tree: { sha: "e".repeat(40) } };
    } else if (pathname === `git/trees/${"e".repeat(40)}?recursive=1`) {
      result = { truncated: false, tree: [] };
    } else if (pathname === "git/blobs") {
      result = { sha: "f".repeat(40) };
    } else if (pathname === "git/trees") {
      result = { sha: "1".repeat(40) };
    } else if (pathname === "git/commits") {
      result = { sha: newSha };
    } else if (pathname === "git/refs/heads/feature/docs" && request.method === "PATCH") {
      result = { object: { sha: newSha } };
    } else if (pathname === "git/ref/heads/feature/docs" && requests.filter((entry) => entry.pathname === pathname).length > 1) {
      result = { object: { sha: newSha } };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback({ artifactDir, requests, apiUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(artifactDir, { recursive: true, force: true });
  }
}

const execFileAsync = promisify(execFile);

async function runWriter({ artifactDir, apiUrl }) {
  try {
    const result = await execFileAsync(process.execPath, [path.join(root, "scripts/docs/commit-generated-docs.mjs")], {
      cwd: root,
      env: {
      ...process.env,
      GITHUB_API_URL: apiUrl,
      GITHUB_TOKEN: "test-token",
      EXPECTED_REPO: "constructorfleet/SketchForge-3D",
      EXPECTED_PULL_REQUEST: "42",
      EXPECTED_HEAD_SHA: headSha,
      EXPECTED_BASE_SHA: baseSha,
      EXPECTED_DEFAULT_BRANCH: "main",
      EXPECTED_BRANCH: "feature/docs",
      DOCS_SOURCE_RUN_ID: "123",
      ARTIFACT_DIR: artifactDir,
      },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout, stderr: error.stderr };
  }
}

test("trusted docs writer commits only allowlisted files and dispatches checks for the new SHA", async () => {
  await withWriter({}, async ({ artifactDir, requests, apiUrl }) => {
    const result = await runWriter({ artifactDir, apiUrl });
    assert.equal(result.status, 0, result.stderr);
    const tree = requests.find(({ method, pathname }) => method === "POST" && pathname === "git/trees");
    assert.deepEqual(tree.body.tree.map(({ path: file }) => file), GENERATED_DOC_PATHS);
    const commit = requests.find(({ method, pathname }) => method === "POST" && pathname === "git/commits");
    assert.deepEqual(commit.body.parents, [headSha]);
    const dispatches = requests.filter(({ method, pathname }) => method === "POST" && pathname.startsWith("actions/workflows/"));
    assert.deepEqual(dispatches.map(({ pathname, body }) => [pathname, body.inputs.expected_sha]), [
      ["actions/workflows/ci.yml/dispatches", newSha],
      ["actions/workflows/docs.yml/dispatches", newSha],
      ["actions/workflows/pr-title.yml/dispatches", newSha],
    ]);
  });
});

test("trusted docs writer rejects a branch that advanced after generation", async () => {
  await withWriter({ staleBranch: true }, async ({ artifactDir, requests, apiUrl }) => {
    const result = await runWriter({ artifactDir, apiUrl });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /branch advanced/);
    assert.equal(requests.some(({ method, pathname }) => method === "POST" && pathname === "git/blobs"), false);
    assert.equal(requests.some(({ pathname }) => pathname.startsWith("actions/workflows/")), false);
  });
});
