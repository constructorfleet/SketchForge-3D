import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GENERATED_DOC_PATHS } from "../../scripts/docs/validate-generated-docs-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/docs-generated-commit.yml");
const repairScript = path.join(root, "scripts/docs/repair-main-generated-docs.mjs");
const manifestScript = path.join(root, "scripts/docs/write-generated-docs-manifest.mjs");
const repo = "constructorfleet/SketchForge-3D";
const headSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const newTreeSha = "c".repeat(40);
const repairCommitSha = "d".repeat(40);
const execFileAsync = promisify(execFile);

function blobSha(contents) {
  return createHash("sha1").update(`blob ${Buffer.byteLength(contents)}\0`).update(contents).digest("hex");
}

async function fixture({ mainSha = headSha, conclusion = "success", stepConclusion = "success", branchExists = false, repairPrState = "none", filesDiffer = true } = {}, callback) {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "sketchforge-main-doc-repair-"));
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(request.url, "http://localhost");
    const route = `${url.pathname}${url.search}`.replace(`/repos/${repo}/`, "");
    calls.push({ method: request.method, route, body });
    let status = 200;
    let result = {};
    if (route === "actions/runs/123") {
      result = {
        event: "push", name: "Documentation site", conclusion, head_branch: "main", head_sha: headSha,
        repository: { full_name: repo }, head_repository: { full_name: repo },
      };
    } else if (route === "actions/runs/123/jobs?per_page=100") {
      result = { jobs: [{ steps: [{ name: "Generate documentation", conclusion: stepConclusion }] }] };
    } else if (route === "git/ref/heads/main") {
      result = { object: { sha: mainSha } };
    } else if (route === `git/commits/${headSha}`) {
      result = { tree: { sha: treeSha } };
    } else if (route === `git/trees/${treeSha}?recursive=1`) {
      result = { truncated: false, tree: filesDiffer ? [] : GENERATED_DOC_PATHS.map((file) => ({
        path: file, type: "blob", sha: blobSha(`generated ${file}\n`),
      })) };
    } else if (route === "git/blobs") {
      result = { sha: `generated-${calls.length}` };
    } else if (route === "git/trees") {
      result = { sha: newTreeSha };
    } else if (route === "git/commits") {
      result = { sha: repairCommitSha };
    } else if (route === "git/ref/heads/automation/generated-docs-refresh") {
      if (branchExists) result = { object: { sha: "e".repeat(40) } };
      else { status = 404; result = { message: "Not Found" }; }
    } else if (route === "git/refs" || route === "git/refs/heads/automation/generated-docs-refresh") {
      result = { object: { sha: repairCommitSha } };
    } else if (route.startsWith("pulls?")) {
      result = repairPrState === "none" ? [] : [{ number: 91, state: repairPrState, html_url: "https://github.com/constructorfleet/SketchForge-3D/pull/91" }];
    } else if (route === "pulls/91") {
      result = { number: 91, state: body.state, html_url: "https://github.com/constructorfleet/SketchForge-3D/pull/91" };
    } else if (route === "pulls") {
      result = { number: 91, html_url: "https://github.com/constructorfleet/SketchForge-3D/pull/91" };
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const relative of GENERATED_DOC_PATHS) {
      const target = path.join(artifactDir, relative);
      await (await import("node:fs/promises")).mkdir(path.dirname(target), { recursive: true });
      await (await import("node:fs/promises")).writeFile(target, `generated ${relative}\n`);
    }
    await (await import("node:fs/promises")).writeFile(path.join(artifactDir, "manifest.json"), JSON.stringify({
      repo, event: "push", ref: "refs/heads/main", headSha, files: GENERATED_DOC_PATHS,
    }));
    await callback({ artifactDir, calls, apiUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(artifactDir, { recursive: true, force: true });
  }
}

async function runRepair({ apiUrl, artifactDir }) {
  try {
    const result = await execFileAsync(process.execPath, [repairScript], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_API_URL: apiUrl,
        GITHUB_TOKEN: "test-token",
        EXPECTED_REPO: repo,
        EXPECTED_HEAD_SHA: headSha,
        EXPECTED_DEFAULT_BRANCH: "main",
        DOCS_SOURCE_RUN_ID: "123",
        ARTIFACT_DIR: artifactDir,
      },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout, stderr: error.stderr };
  }
}

test("main docs runs upload an allowlisted artifact and a trusted writer opens a repair PR instead of pushing main", async () => {
  const yaml = await import("js-yaml");
  const workflow = yaml.load(await (await import("node:fs/promises")).readFile(workflowPath, "utf8"));
  assert.match(workflow.jobs["repair-main-generated-docs"].if, /workflow_run\.event == 'push'/);
  assert.match(workflow.jobs["repair-main-generated-docs"].if, /workflow_run\.conclusion == 'success'/);
  assert.equal(workflow.jobs["repair-main-generated-docs"].permissions.contents, "write");
  assert.equal(workflow.jobs["repair-main-generated-docs"].permissions["pull-requests"], "write");
  const trustedCheckout = workflow.jobs["repair-main-generated-docs"].steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(trustedCheckout.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(trustedCheckout.with["persist-credentials"], false);
  assert.match(workflow.jobs["repair-main-generated-docs"].steps.map(({ run }) => run ?? "").join("\n"), /repair-main-generated-docs\.mjs/);
  const docsWorkflow = await (await import("node:fs/promises")).readFile(path.join(root, ".github/workflows/docs.yml"), "utf8");
  assert.match(docsWorkflow, /GITHUB_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(docsWorkflow, /github\.event_name == 'push' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  await fixture({}, async ({ artifactDir, calls, apiUrl }) => {
    const result = await runRepair({ apiUrl, artifactDir });
    assert.equal(result.status, 0, result.stderr);
    const commit = calls.find(({ method, route }) => method === "POST" && route === "git/commits");
    assert.deepEqual(commit.body.parents, [headSha]);
    const tree = calls.find(({ method, route }) => method === "POST" && route === "git/trees");
    assert.deepEqual(tree.body.tree.map(({ path: file }) => file), GENERATED_DOC_PATHS);
    assert.ok(calls.some(({ method, route, body }) => method === "POST" && route === "git/refs"
      && body.ref === "refs/heads/automation/generated-docs-refresh" && body.sha === repairCommitSha));
    assert.ok(calls.some(({ method, route }) => method === "POST" && route === "pulls"));
    const dispatch = calls.find(({ method, route }) => method === "POST" && route === "dispatches");
    assert.deepEqual(dispatch.body, {
      event_type: "generated_docs_pr_checks",
      client_payload: { expected_sha: repairCommitSha, pr_number: 91 },
    });
    assert.ok(!calls.some(({ method, route }) => method === "PATCH" && route === "git/refs/heads/main"),
      "main repair must use a PR and respect the protected default branch");
  });
});

test("main push manifest binds allowlisted outputs to the exact default-branch commit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sketchforge-main-manifest-"));
  try {
    const eventPath = path.join(directory, "event.json");
    const artifactDir = path.join(directory, "artifact");
    await writeFile(eventPath, JSON.stringify({
      ref: "refs/heads/main", after: headSha, repository: { full_name: repo },
    }));
    const result = await execFileAsync(process.execPath, [manifestScript, eventPath, artifactDir], {
      cwd: root,
      env: { ...process.env, GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: "push", GITHUB_DEFAULT_BRANCH: "main" },
    });
    assert.equal(result.code, undefined);
    const manifest = JSON.parse(await readFile(path.join(artifactDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest, { repo, event: "push", ref: "refs/heads/main", headSha, files: GENERATED_DOC_PATHS });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("main repair skips if the docs workflow failed or main advanced beyond its artifact", async () => {
  for (const options of [{ conclusion: "failure" }, { mainSha: "f".repeat(40) }]) {
    await fixture(options, async ({ artifactDir, calls, apiUrl }) => {
      const result = await runRepair({ apiUrl, artifactDir });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(calls.some(({ method, route }) => method === "POST" && route === "git/blobs"), false);
      assert.equal(calls.some(({ method, route }) => method === "POST" && route === "pulls"), false);
    });
  }
});

test("main repair does nothing when the generated tracked outputs already match main", async () => {
  await fixture({ filesDiffer: false }, async ({ artifactDir, calls, apiUrl }) => {
    const result = await runRepair({ apiUrl, artifactDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.some(({ method, route }) => method === "POST"), false);
  });
});

test("main repair refreshes its existing bot branch and PR instead of creating another", async () => {
  await fixture({ branchExists: true, repairPrState: "open" }, async ({ artifactDir, calls, apiUrl }) => {
    const result = await runRepair({ apiUrl, artifactDir });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.some(({ method, route, body }) => method === "PATCH" && route === "git/refs/heads/automation/generated-docs-refresh" && body.force === true));
    assert.equal(calls.some(({ method, route }) => method === "POST" && route === "pulls"), false);
    assert.ok(calls.some(({ method, route }) => method === "POST" && route === "dispatches"));
  });
});

test("main repair reopens its existing bot PR if it was closed before generated outputs were refreshed", async () => {
  await fixture({ branchExists: true, repairPrState: "closed" }, async ({ artifactDir, calls, apiUrl }) => {
    const result = await runRepair({ apiUrl, artifactDir });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.some(({ method, route, body }) => method === "PATCH" && route === "pulls/91" && body.state === "open"));
    assert.equal(calls.some(({ method, route }) => method === "POST" && route === "pulls"), false);
  });
});
