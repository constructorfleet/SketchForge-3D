import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const load = (name) => yaml.load(readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const runs = (job) => job.steps.map(({ run }) => run ?? "").join("\n");
const jobNamed = (workflow, name) => Object.entries(workflow.jobs).find(([, job]) => job.name === name);
const needsOf = (job) => [job.needs ?? []].flat();

// The docs workflow is the longest pull-request check. Its single job ran the
// editor browser suite -- a full `next build` plus six Playwright tests -- in
// series with the site build and the Pages demo export, so the editor suite's
// minute and a half sat on the critical path of every pull request. It runs in
// its own job so the two halves overlap.
const docs = load("docs.yml");
const [buildId, build] = jobNamed(docs, "Check and build docs") ?? [];
const [browserId, browser] = jobNamed(docs, "Editor browser tests") ?? [];

test("the docs build keeps its required check name and no longer runs the editor browser suite", () => {
  assert.ok(build, "docs.yml must keep the job named \"Check and build docs\": the main ruleset requires that name");
  assert.doesNotMatch(runs(build), /npm run test:browser/, "the editor browser suite is still serialised behind the docs build");
});

test("the editor browser suite runs in a job that does not wait for the docs build", () => {
  assert.ok(browser, "docs.yml has no \"Editor browser tests\" job");
  assert.match(runs(browser), /npm run test:browser/);
  assert.ok(!needsOf(browser).includes(buildId), "the browser job waits for the docs build, so nothing runs in parallel");
});

test("Pages deploys only after both the docs build and the editor browser suite pass", () => {
  const deploy = docs.jobs.deploy;
  assert.deepEqual(new Set(needsOf(deploy)), new Set([buildId, browserId]));
});

// A cold `next build` recompiles everything. Next keeps its incremental cache
// in `apps/web/.next/cache` for the static export too: with `output: "export"`
// the build still runs in `.next` and only the exported site lands in the
// `.next-export` distDir, so a cache of `.next-export/cache` saves nothing --
// the first version of this change did exactly that.
function assertNextCache(job, label) {
  const cache = job.steps.find(({ uses, with: options }) => uses?.startsWith("actions/cache@")
    && String(options?.path ?? "").includes("apps/web/.next/cache"));
  assert.ok(cache, `${label} does not cache apps/web/.next/cache`);
  assert.doesNotMatch(String(cache.with.path), /\.next-export/, `${label}: Next writes no cache under the export distDir`);
  assert.match(cache.with.key, /hashFiles\('package-lock\.json'\)/, `${label}: the Next cache key must change with the lockfile`);
  assert.match(cache.with.key, /hashFiles\([^)]*apps\/web\//, `${label}: the Next cache key must change with the app source`);
  assert.ok(cache.with["restore-keys"], `${label}: without restore-keys a source change starts from a cold cache`);
  return cache.with.key;
}

test("each Next build restores its incremental build cache", () => {
  const exportKey = assertNextCache(build, "docs build (Pages demo export)");
  const serverKey = assertNextCache(browser, "editor browser tests");
  assertNextCache(load("ci.yml").jobs["static-export"], "ci.yml static export");
  assert.notEqual(exportKey.split("$")[0], serverKey.split("$")[0],
    "the static export and the server build compile different bundles and must not share a cache key");
});

// Downloading Chromium took 22-35 s of every docs run. The browser binary is
// cached by Playwright version; the system libraries it links against live
// outside the cache, so a hit must still install them.
function assertPlaywrightCache(job, label) {
  const cache = job.steps.find(({ uses, with: options }) => uses?.startsWith("actions/cache@")
    && String(options?.path ?? "").includes("ms-playwright"));
  assert.ok(cache, `${label} does not cache the Playwright browsers`);
  assert.match(cache.with.key, /playwright.*\$\{\{\s*steps\.[\w-]+\.outputs\.version\s*\}\}/, `${label}: the browser cache must be keyed on the installed Playwright version`);
  const install = job.steps.find(({ run }) => /playwright install (--with-deps )?.*chromium/.test(run ?? "") && !/install-deps/.test(run));
  const deps = job.steps.find(({ run }) => /playwright install-deps chromium/.test(run ?? ""));
  assert.ok(install && /cache-hit != 'true'/.test(install.if ?? ""), `${label}: Chromium must be downloaded only on a cache miss`);
  assert.ok(deps && /cache-hit == 'true'/.test(deps.if ?? ""), `${label}: a cache hit must still install Chromium's system dependencies`);
}

test("every docs job that drives Chromium caches the Playwright browsers", () => {
  // The site-build tests and the Pages demo test drive Chromium, so the build
  // job still needs it alongside the browser job.
  assertPlaywrightCache(build, "docs build");
  assertPlaywrightCache(browser, "editor browser tests");
});

test("the docs build caches pip downloads for the Python documentation checks", () => {
  const python = build.steps.find(({ uses }) => uses?.startsWith("actions/setup-python@"));
  assert.equal(python.with.cache, "pip");
  assert.equal(python.with["cache-dependency-path"], "packages/sketchforge-py/requirements-dev.txt");
});

// The trusted workflow re-runs pull-request checks for generated-docs commits
// (which GITHUB_TOKEN pushes cannot trigger) and records each by name, so it
// must split the same way or the new check would never appear on those commits.
test("trusted PR checks run and record the editor browser suite as its own check", () => {
  const trusted = load("trusted-pr-checks.yml");
  const [trustedBrowserId, trustedBrowser] = jobNamed(trusted, "Editor browser tests") ?? [];
  assert.ok(trustedBrowser, "trusted-pr-checks.yml has no \"Editor browser tests\" job");
  assert.match(runs(trustedBrowser), /npm run test:browser/);
  assert.doesNotMatch(runs(trusted.jobs.docs), /npm run test:browser/);
  const recorder = trusted.jobs["record-checks"];
  assert.ok(needsOf(recorder).includes(trustedBrowserId));
  const results = recorder.steps.find(({ env }) => env?.CHECK_RESULTS).env.CHECK_RESULTS;
  assert.match(results, new RegExp(`"${trustedBrowserId}":"\\$\\{\\{ needs\\.${trustedBrowserId}\\.result \\}\\}"`));
  const recorderScript = readFileSync(path.join(root, "scripts/docs/record-trusted-pr-checks.mjs"), "utf8");
  assert.match(recorderScript, new RegExp(`\\["${trustedBrowserId}", "Editor browser tests"\\]`));
});
