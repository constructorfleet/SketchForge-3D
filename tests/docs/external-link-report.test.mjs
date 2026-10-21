import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateExternalLinkReport } from "../../scripts/docs/external-link-report.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sketchforge-doc-links-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Fixture\n\n[External](https://broken.example/docs)\n");
  await writeFile(path.join(root, "docs/index.md"), "# Docs\n");
  const init = spawnSync("git", ["init", "-q"], { cwd: root });
  assert.equal(init.status, 0);
  spawnSync("git", ["add", "."], { cwd: root });
  return root;
}

test("external failures are recorded in a report without changing the checker result", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "reports", "external-links.json");
  const fetchShim = path.join(root, "mock-fetch.mjs");
  await writeFile(fetchShim, "globalThis.fetch = async () => new Response('unavailable', { status: 503 });\n");
  const result = spawnSync(process.execPath, ["--import", fetchShim, path.join(repository, "scripts/docs/external-link-report.mjs"), "--root", root, "--report", reportPath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.checked, 1);
  assert.deepEqual(report.failures.map(({ url }) => url), ["https://broken.example/docs"]);
  assert.equal(await readFile(reportPath, "utf8"), `${JSON.stringify(report, null, 2)}\n`);
  assert.match(await readFile(reportPath.replace(/\.json$/i, ".md"), "utf8"), /External failures are advisory/);
});

test("external links use bounded network work and deduplicate URLs", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await writeFile(path.join(root, "docs/index.md"), "[same](https://ok.example) [same](https://ok.example) [other](https://other.example)\n");
  spawnSync("git", ["add", "."], { cwd: root });
  let active = 0;
  let peak = 0;
  const report = await generateExternalLinkReport({
    root,
    fetchImpl: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(null, { status: 200 });
    },
    concurrency: 1,
    maxLinks: 1,
  });
  assert.equal(report.checked, 1);
  assert.equal(report.discovered, 2);
  assert.equal(report.truncated, true);
  assert.equal(peak, 1);
  assert.deepEqual(report.failures, []);
});

test("internal broken links still fail the required docs check", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "# Fixture\n\n[Internal](missing.md)\n");
  spawnSync("git", ["add", "."], { cwd: root });
  const result = spawnSync(process.execPath, [path.join(repository, "scripts/docs-check.mjs"), "--root", root], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /local link target not found: missing\.md/);
});

test("external reporting runs separately from blocking docs checks and uploads an advisory artifact", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
  const workflow = await readFile(path.join(repository, ".github/workflows/docs-external-links.yml"), "utf8");
  assert.match(packageJson.scripts["docs:check"], /node scripts\/docs-check\.mjs/);
  assert.doesNotMatch(packageJson.scripts["docs:check"], /node scripts\/docs\/external-link-report\.mjs/);
  assert.match(packageJson.scripts["docs:check"], /tests\/docs\/external-link-report\.test\.mjs/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /external-documentation-link-report/);
});
