import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/trusted-pr-checks.yml");
const recorderPath = path.join(root, "scripts/docs/record-trusted-pr-checks.mjs");
const sha = "a".repeat(40);
const repository = "constructorfleet/SketchForge-3D";
const expectedChecks = [
  "Package examples against local API",
  "Typecheck and unit tests",
  "REST API end to end",
  "Static export build",
  "Check and build docs",
  "Editor browser tests",
  "Conventional commit",
];
const execFileAsync = promisify(execFile);

test("trusted PR verifier is only dispatched from default-branch repository_dispatch and checks out exact SHA read-only", async () => {
  const yaml = await import("js-yaml");
  const workflow = yaml.load(await (await import("node:fs/promises")).readFile(workflowPath, "utf8"));
  const on = workflow.on ?? workflow[true];
  assert.deepEqual(Object.keys(on), ["repository_dispatch"]);
  assert.deepEqual(on.repository_dispatch.types, ["generated_docs_pr_checks"]);
  const targetValidation = workflow.jobs["validate-target"].steps.map(({ run }) => run ?? "").join("\n");
  assert.match(targetValidation, /EXPECTED_SHA/);
  assert.match(targetValidation, /\.merged/);
  assert.match(targetValidation, /\.head\.repo\.full_name/);
  assert.match(targetValidation, /\.head\.sha/);
  for (const id of ["package-examples", "typecheck", "api-e2e", "static-export", "docs", "browser"]) {
    const job = workflow.jobs[id];
    assert.equal(job.permissions.contents, "read");
    const checkout = job.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ needs.validate-target.outputs.expected_sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
  }
  const reporter = workflow.jobs["record-checks"];
  assert.equal(reporter.permissions.checks, "write");
  assert.notEqual(reporter.permissions.contents, "write");
  const trustedCheckout = reporter.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.ok(trustedCheckout, "check reporter needs its trusted script from the default branch");
  assert.equal(trustedCheckout.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(trustedCheckout.with["persist-credentials"], false);
  assert.match(await (await import("node:fs/promises")).readFile(recorderPath, "utf8"), /check-runs/);
});

test("trusted title validation compares the title without a trailing JSON newline", async () => {
  const yaml = await import("js-yaml");
  const workflow = yaml.load(await (await import("node:fs/promises")).readFile(workflowPath, "utf8"));
  const titleValidation = workflow.jobs.title.steps.find(({ name }) => typeof name === "string" && name.startsWith("Validate the live PR title")).run;

  assert.match(titleValidation, /jq -rj '\.title'/);
  assert.match(titleValidation, /\.merged/);
});

async function withReporter({ currentSha = sha, state = "open", merged = false, title = "docs: refresh references", headRef = "feature/docs", headRepo = repository, baseRepo = repository } = {}, callback) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sketchforge-trusted-checks-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const pathname = new URL(request.url, "http://localhost").pathname.replace(/^\/repos\/constructorfleet\/SketchForge-3D\//, "");
    requests.push({ method: request.method, pathname, body });
    let result = {};
    if (pathname === "pulls/42") {
      result = {
        state,
        merged,
        title,
        base: { ref: "main", repo: { full_name: baseRepo } },
        head: { sha: currentSha, ref: headRef, repo: { full_name: headRepo } },
      };
    } else if (pathname === "check-runs") {
      result = { id: requests.length };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback({ tempDir, requests, apiUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runRecorder({ apiUrl, expectedSha = sha, title = "docs: refresh references", results }) {
  try {
    const result = await execFileAsync(process.execPath, [recorderPath], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_API_URL: apiUrl,
        GITHUB_TOKEN: "test-token",
        EXPECTED_REPO: repository,
        EXPECTED_PULL_REQUEST: "42",
        EXPECTED_HEAD_SHA: expectedSha,
        EXPECTED_DEFAULT_BRANCH: "main",
        EXPECTED_TITLE_B64: Buffer.from(title).toString("base64"),
        CHECK_RESULTS: JSON.stringify(results),
      },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout, stderr: error.stderr };
  }
}

const results = {
  "package-examples": "success",
  typecheck: "success",
  "api-e2e": "success",
  "static-export": "success",
  docs: "success",
  browser: "success",
  title: "success",
};

test("trusted check reporter creates required check contexts on the exact live PR SHA", async () => {
  await withReporter({}, async ({ requests, apiUrl }) => {
    const result = await runRecorder({ apiUrl, results: { ...results, "static-export": "failure" } });
    assert.equal(result.status, 0, result.stderr);
    const created = requests.filter(({ method, pathname }) => method === "POST" && pathname === "check-runs");
    assert.deepEqual(created.map(({ body }) => body.name), expectedChecks);
    assert.ok(created.every(({ body }) => body.head_sha === sha && body.status === "completed"));
    assert.equal(created.find(({ body }) => body.name === "Static export build").body.conclusion, "failure");
    assert.equal(created.find(({ body }) => body.name === "Typecheck and unit tests").body.conclusion, "success");
  });
});

test("trusted check reporter accepts only a merged same-repository PR whose title and head SHA still match", async () => {
  await withReporter({ state: "closed", merged: true }, async ({ requests, apiUrl }) => {
    const result = await runRecorder({ apiUrl, results });
    assert.equal(result.status, 0, result.stderr);
    const created = requests.filter(({ method, pathname }) => method === "POST" && pathname === "check-runs");
    assert.equal(created.length, expectedChecks.length);
    assert.ok(created.every(({ body }) => body.head_sha === sha));
  });

  for (const scenario of [
    { state: "closed", merged: false },
    { state: "closed", merged: true, currentSha: "b".repeat(40) },
    { state: "closed", merged: true, title: "chore: unrelated" },
    { state: "closed", merged: true, headRepo: "someone/fork" },
    { state: "closed", merged: true, baseRepo: "someone/fork" },
  ]) {
    await withReporter(scenario, async ({ requests, apiUrl }) => {
      const result = await runRecorder({ apiUrl, results });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(requests.some(({ method, pathname }) => method === "POST" && pathname === "check-runs"), false);
    });
  }
});

test("trusted check reporter does not attach results to a closed or advanced PR", async () => {
  for (const scenario of [{ state: "closed" }, { currentSha: "b".repeat(40) }, { headRef: "main" }]) {
    await withReporter(scenario, async ({ requests, apiUrl }) => {
      const result = await runRecorder({ apiUrl, results });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(requests.some(({ method, pathname }) => method === "POST" && pathname === "check-runs"), false);
    });
  }
});
