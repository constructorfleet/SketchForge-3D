import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function createRepository(t, page, pagePath = "docs/index.md") {
  const root = await mkdtemp(path.join(os.tmpdir(), "sketchforge-doc-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(root, pagePath)), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  if (pagePath === "docs/index.md") {
    await writeFile(path.join(root, pagePath), page);
  } else {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs/index.md"), "---\nslug: /\ntitle: Home\naudience: Contributors\nowner: Docs\n---\n# Home\n");
    await writeFile(path.join(root, pagePath), page);
  }
  await mkdir(path.join(root, "apps/web/src/app/api/v1/shapes"), { recursive: true });
  await writeFile(path.join(root, "apps/web/src/app/api/v1/shapes/route.ts"), "export const GET = () => null;\n");
  await mkdir(path.join(root, "packages/sketchforge-client/examples"), { recursive: true });
  await writeFile(path.join(root, "packages/sketchforge-client/examples/bolt-plate.macro.mjs"), "export default () => 'fixture';\n");
  await mkdir(path.join(root, "packages/sketchforge-py/examples"), { recursive: true });
  await writeFile(path.join(root, "packages/sketchforge-py/examples/bolt_plate.py"), "def main():\n    return 'fixture'\n");
  const init = spawnSync("git", ["init", "-q"], { cwd: root });
  assert.equal(init.status, 0);
  spawnSync("git", ["config", "user.email", "docs-test@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Docs test"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  const commit = spawnSync("git", ["commit", "-qm", "initial docs"], { cwd: root });
  assert.equal(commit.status, 0);
  return root;
}

function runDocsCheck(root, ...args) {
  return spawnSync(process.execPath, [path.join(repository, "scripts/docs-check.mjs"), "--root", root, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("canonical docs require stable ownership frontmatter", async (t) => {
  const root = await createRepository(t, "# Fixture docs\n");
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /docs\/index\.md: missing required frontmatter field `slug`/);
});

test("canonical docs reject malformed ownership metadata", async (t) => {
  const root = await createRepository(t, `---\nslug: ../escape\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n`);
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /docs\/index\.md: slug must be an absolute site path/);
});

test("canonical docs reject owner values that look like repository paths", async (t) => {
  const root = await createRepository(t, `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: ../secrets\n---\n# Fixture docs\n`);
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /docs\/index\.md: owner must name a documentation owner area/);
});

test("canonical docs reject source mappings that match no tracked file", async (t) => {
  const root = await createRepository(t, `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\nsources:\n  - packages/missing/src/**\n---\n# Fixture docs\n`);
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /docs\/index\.md: source ownership pattern matches no tracked file: packages\/missing\/src\/\*\*/);
});

test("generated package references are checked for stable page ownership", async (t) => {
  const root = await createRepository(t, `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n`);
  await mkdir(path.join(root, ".docs-site/docs/reference"), { recursive: true });
  await writeFile(path.join(root, ".docs-site/docs/reference/client.md"), "# Generated package API\n");
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /.docs-site\/docs\/reference\/client\.md: missing required frontmatter field `slug`/);
});

test("changed public source reports its owning documentation page", async (t) => {
  const root = await createRepository(t, `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\nsources:\n  - apps/web/src/app/api/v1/**\n---\n# Fixture docs\n`);
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  await writeFile(path.join(root, "apps/web/src/app/api/v1/shapes/route.ts"), "export const GET = () => ({ ok: true });\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "change public source"], { cwd: root });
  const result = runDocsCheck(root, "--base-ref", base);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /apps\/web\/src\/app\/api\/v1\/shapes\/route\.ts -> \/ \(docs\/index\.md\)/);
});

test("changed public source without an owner fails with an actionable diagnostic", async (t) => {
  const root = await createRepository(t, `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\nsources: []\n---\n# Fixture docs\n`);
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  await writeFile(path.join(root, "apps/web/src/app/api/v1/shapes/route.ts"), "export const POST = () => null;\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "change public source"], { cwd: root });
  const result = runDocsCheck(root, "--base-ref", base);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /route\.ts: changed public source has no owning page; add a matching `sources` entry to page frontmatter/);
});

const packageExampleSources = [
  { language: "TypeScript", path: "packages/sketchforge-client/examples/bolt-plate.macro.mjs", updated: "export default () => 'changed';\n" },
  { language: "Python", path: "packages/sketchforge-py/examples/bolt_plate.py", updated: "def main():\n    return 'changed'\n" },
];

for (const example of packageExampleSources) {
  test(`changed ${example.language} package example reports the package guide owner`, async (t) => {
    const root = await createRepository(
      t,
      `---\nslug: "/docs/guides/package-examples"\ntitle: Package examples\naudience: Contributors\nowner: Packages\nsources:\n  - packages/sketchforge-client/examples/**\n  - packages/sketchforge-py/examples/**\n---\n# Package examples\n`,
      "docs/guides/package-examples.md",
    );
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(root, example.path), example.updated);
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-qm", `change ${example.language} example`], { cwd: root });

    const result = runDocsCheck(root, "--base-ref", base);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes(`${example.path} -> /docs/guides/package-examples (docs/guides/package-examples.md)`), result.stdout);
  });

  test(`changed ${example.language} package example without a source mapping fails actionably`, async (t) => {
    const root = await createRepository(
      t,
      `---\nslug: "/docs/guides/package-examples"\ntitle: Package examples\naudience: Contributors\nowner: Packages\nsources: []\n---\n# Package examples\n`,
      "docs/guides/package-examples.md",
    );
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(root, example.path), example.updated);
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-qm", `change ${example.language} example`], { cwd: root });

    const result = runDocsCheck(root, "--base-ref", base);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const diagnostic = `${example.path}: changed public source has no owning page; add a matching \`sources\` entry to page frontmatter`;
    assert.ok(`${result.stdout}\n${result.stderr}`.includes(diagnostic), `${result.stdout}\n${result.stderr}`);
  });
}

test("the package examples page maps the source trees it includes and tests", async () => {
  const guide = await readFile(path.join(repository, "docs/guides/package-examples.md"), "utf8");
  assert.match(guide, /sources:[\s\S]*packages\/sketchforge-client\/examples\/\*\*/);
  assert.match(guide, /sources:[\s\S]*packages\/sketchforge-py\/examples\/\*\*/);
});

test("docs CI fetches the base commit and supplies it to the ownership checker", async () => {
  const workflow = await readFile(path.join(repository, ".github/workflows/docs.yml"), "utf8");
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /DOCS_BASE_REF:\s*\$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
});
