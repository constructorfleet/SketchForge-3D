import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("documentation suite status records REST and runnable-fence coverage accurately", async () => {
  const spec = await readFile(path.join(repository, "docs/DOCUMENTATION_SUITE_SPEC.md"), "utf8");

  assert.match(spec, /Current status is 26 of 32; 6 remain omitted/i);
  assert.match(spec, /23 supported-language runnable fences.*exact tracked source with linked test and CI command, or carry a concrete reasoned exemption/i);
  assert.match(spec, /other fence languages[\s\S]*?ownership coverage for other content sources remain open/i);
  assert.match(spec, /6\. \*\*Partial:\*\*.*23 supported-language runnable fences/i);
  assert.match(spec, /7\. \*\*Partial:\*\*.*runnable-fence check covers 23 maintained-doc fences/i);
  assert.match(spec, /10\. \*\*Partial:\*\*.*23 supported-language runnable fences/i);
});

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

async function createRunnableBlockRepository(t, page) {
  const root = await createRepository(t, page);
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  await writeFile(path.join(root, ".github/workflows/ci.yml"), "      - run: npm run test:integration\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { "test:integration": "vitest run --config tests/vitest.integration.config.ts" },
  }));
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "tests/vitest.integration.config.ts"), 'include: ["packages/**/tests/**/*.integration.ts"]\n');
  const source = path.join(root, "packages/sketchforge-client/examples/bolt-plate.macro.mjs");
  await writeFile(source, "export default () => 'fixture';\n");
  const testFile = path.join(root, "packages/sketchforge-client/tests/examples.integration.ts");
  await mkdir(path.dirname(testFile), { recursive: true });
  await writeFile(testFile, 'import example from "../examples/bolt-plate.macro.mjs";\n');
  await writeFile(path.join(root, "docs/index.md"), page);
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "add runnable example fixture"], { cwd: root });
  return root;
}

function runDocsCheck(root, ...args) {
  return runDocsCheckWithEnvironment(root, process.env, ...args);
}

function runDocsCheckWithEnvironment(root, parentEnvironment, ...args) {
  const env = { ...parentEnvironment };
  delete env.DOCS_BASE_REF;
  return spawnSync(process.execPath, [path.join(repository, "scripts/docs-check.mjs"), "--root", root, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
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

test("runnable code fences require source inclusion metadata or an explicit exemption", async (t) => {
  const root = await createRunnableBlockRepository(
    t,
    `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n\n\`\`\`js\nconsole.log("unowned");\n\`\`\`\n`,
  );
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /docs\/index\.md:\d+: runnable js block needs runnable-source or runnable-exempt metadata/);
});

test("documentation checker fixtures ignore the workflow's parent-repository base ref", async (t) => {
  const root = await createRepository(
    t,
    `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n`,
  );
  const result = runDocsCheckWithEnvironment(root, { ...process.env, DOCS_BASE_REF: "unavailable-parent-commit" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("runnable source metadata requires the fence to include the exact source and name a test", async (t) => {
  const root = await createRunnableBlockRepository(
    t,
    `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n\n<!-- runnable-source: packages/sketchforge-client/examples/bolt-plate.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->\n\`\`\`js\n!!!include(../packages/sketchforge-client/examples/bolt-plate.macro.mjs)!!!\n\`\`\`\n`,
  );
  const result = runDocsCheck(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("runnable source metadata rejects drift from its included source", async (t) => {
  const root = await createRunnableBlockRepository(
    t,
    `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n\n<!-- runnable-source: packages/sketchforge-client/examples/bolt-plate.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->\n\`\`\`js\nconsole.log("stale copy");\n\`\`\`\n`,
  );
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /runnable source block must include its declared source with a matching `!!!include\(\.\.\/packages\/sketchforge-client\/examples\/bolt-plate\.macro\.mjs\)!!!` directive/);
});

test("runnable source metadata requires the named test to reference the included example", async (t) => {
  const root = await createRunnableBlockRepository(
    t,
    `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n\n<!-- runnable-source: packages/sketchforge-client/examples/bolt-plate.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->\n\`\`\`js\n!!!include(../packages/sketchforge-client/examples/bolt-plate.macro.mjs)!!!\n\`\`\`\n`,
  );
  await writeFile(path.join(root, "packages/sketchforge-client/tests/examples.integration.ts"), "export const tested = true;\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "remove example test reference"], { cwd: root });
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /runnable source test does not reference packages\/sketchforge-client\/examples\/bolt-plate\.macro\.mjs/);
});

test("runnable source metadata requires its test command in both the runner and CI workflow", async (t) => {
  const root = await createRunnableBlockRepository(
    t,
    `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n\n<!-- runnable-source: packages/sketchforge-client/examples/bolt-plate.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->\n\`\`\`js\n!!!include(../packages/sketchforge-client/examples/bolt-plate.macro.mjs)!!!\n\`\`\`\n`,
  );
  await writeFile(path.join(root, ".github/workflows/ci.yml"), "      - run: npm run test:unit\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "remove integration test command"], { cwd: root });
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /runnable source test is not wired to CI command npm run test:integration/);
});

test("runnable exemptions must include a concrete reason", async (t) => {
  const root = await createRunnableBlockRepository(
    t,
    `---\nslug: /\ntitle: Fixture docs\naudience: Contributors\nowner: Docs\n---\n# Fixture docs\n\n<!-- runnable-exempt: -->\n\`\`\`sh\nnpm run example\n\`\`\`\n`,
  );
  const result = runDocsCheck(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /runnable-exempt metadata needs a concrete reason/);
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

async function createChangedEditorSourceRepository(t, guide) {
  const editorSource = "apps/web/src/components/SketchForgeEditor.tsx";
  const root = await createRepository(t, guide, "docs/guides/edit-and-export-model.md");
  await mkdir(path.dirname(path.join(root, editorSource)), { recursive: true });
  await writeFile(path.join(root, editorSource), "export function SketchForgeEditor() { return null; }\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "add editor source fixture"], { cwd: root });
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  await writeFile(path.join(root, editorSource), "export function SketchForgeEditor() { return 'changed'; }\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "change editor source"], { cwd: root });
  return { root, base, editorSource };
}

test("changed SketchForgeEditor source reports the edit-and-export guide owner", async (t) => {
  const { root, base, editorSource } = await createChangedEditorSourceRepository(
    t,
    `---\nslug: "/docs/guides/edit-and-export-model"\ntitle: Edit and export\naudience: Editor users\nowner: Editor\nsources:\n  - apps/web/src/components/SketchForgeEditor.tsx\n---\n# Edit and export\n`,
  );
  const result = runDocsCheck(root, "--base-ref", base);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(`${editorSource} -> /docs/guides/edit-and-export-model (docs/guides/edit-and-export-model.md)`), result.stdout);
});

test("changed SketchForgeEditor source without an owner fails actionably", async (t) => {
  const { root, base, editorSource } = await createChangedEditorSourceRepository(
    t,
    `---\nslug: "/docs/guides/edit-and-export-model"\ntitle: Edit and export\naudience: Editor users\nowner: Editor\nsources: []\n---\n# Edit and export\n`,
  );
  const result = runDocsCheck(root, "--base-ref", base);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const diagnostic = `${editorSource}: changed public source has no owning page; add a matching \`sources\` entry to page frontmatter`;
  assert.ok(`${result.stdout}\n${result.stderr}`.includes(diagnostic), `${result.stdout}\n${result.stderr}`);
});

for (const source of [
  "apps/web/src/components/SketchForgeEditor.tsx",
  "apps/web/src/components/SketchWorkspace.tsx",
  "apps/web/src/lib/sketchConstraints.ts",
]) {
  test(`changed sketch constraint source ${source} reports the sketch workflow owner`, async (t) => {
    const sources = [
      "apps/web/src/components/SketchForgeEditor.tsx",
      "apps/web/src/components/SketchWorkspace.tsx",
      "apps/web/src/lib/sketchConstraints.ts",
    ];
    const root = await createRepository(
      t,
      `---\nslug: "/docs/guides/sketch-constraints"\ntitle: Constrain sketch geometry\naudience: Editor users\nowner: Editor\nsources:\n${sources.map((entry) => `  - ${entry}`).join("\n")}\n---\n# Constrain sketch geometry\n`,
      "docs/guides/sketch-constraints.md",
    );
    for (const entry of sources) {
      await mkdir(path.dirname(path.join(root, entry)), { recursive: true });
      await writeFile(path.join(root, entry), "export const constraintSource = 'initial';\n");
    }
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-qm", "add sketch constraint source fixture"], { cwd: root });
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    await writeFile(path.join(root, source), "export const constraintSource = 'changed';\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-qm", "change sketch constraint source"], { cwd: root });

    const result = runDocsCheck(root, "--base-ref", base);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes(`${source} -> /docs/guides/sketch-constraints (docs/guides/sketch-constraints.md)`), result.stdout);
  });
}

test("changed SketchWorkspace source without the sketch workflow owner fails actionably", async (t) => {
  const source = "apps/web/src/components/SketchWorkspace.tsx";
  const root = await createRepository(
    t,
    `---\nslug: "/docs/guides/sketch-constraints"\ntitle: Constrain sketch geometry\naudience: Editor users\nowner: Editor\nsources: []\n---\n# Constrain sketch geometry\n`,
    "docs/guides/sketch-constraints.md",
  );
  await mkdir(path.dirname(path.join(root, source)), { recursive: true });
  await writeFile(path.join(root, source), "export const constraintUI = 'initial';\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "add sketch constraint source fixture"], { cwd: root });
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  await writeFile(path.join(root, source), "export const constraintUI = 'changed';\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "change sketch constraint source"], { cwd: root });

  const result = runDocsCheck(root, "--base-ref", base);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /SketchWorkspace\.tsx: changed public source has no owning page/);
});

test("SketchForgeEditor changes report both documented editor workflows", async (t) => {
  const constraintSources = [
    "apps/web/src/components/SketchForgeEditor.tsx",
    "apps/web/src/components/SketchWorkspace.tsx",
    "apps/web/src/lib/sketchConstraints.ts",
  ];
  const root = await createRepository(
    t,
    `---\nslug: "/docs/guides/sketch-constraints"\ntitle: Constrain sketch geometry\naudience: Editor users\nowner: Editor\nsources:\n${constraintSources.map((source) => `  - ${source}`).join("\n")}\n---\n# Constrain sketch geometry\n`,
    "docs/guides/sketch-constraints.md",
  );
  const editGuide = `---\nslug: "/docs/guides/edit-and-export-model"\ntitle: Create, edit, save, and export\naudience: Editor users\nowner: Editor\nsources:\n  - apps/web/src/components/SketchForgeEditor.tsx\n---\n# Create, edit, save, and export\n`;
  await mkdir(path.join(root, "docs/guides"), { recursive: true });
  await writeFile(path.join(root, "docs/guides/edit-and-export-model.md"), editGuide);
  for (const source of constraintSources) {
    await mkdir(path.dirname(path.join(root, source)), { recursive: true });
    await writeFile(path.join(root, source), "export const editorSource = 'initial';\n");
  }
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "add editor workflow ownership fixture"], { cwd: root });
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  await writeFile(path.join(root, "apps/web/src/components/SketchForgeEditor.tsx"), "export const editorSource = 'changed';\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "change editor source"], { cwd: root });

  const result = runDocsCheck(root, "--base-ref", base);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const editorOwnerDiagnostic = result.stdout.split("\n").find((line) => line.includes("SketchForgeEditor.tsx ->"));
  assert.ok(editorOwnerDiagnostic?.includes("/docs/guides/sketch-constraints"), result.stdout);
  assert.ok(editorOwnerDiagnostic?.includes("/docs/guides/edit-and-export-model"), result.stdout);
});

test("the sketch constraints guide maps only its editor, UI, and solver implementation files", async () => {
  const guide = await readFile(path.join(repository, "docs/guides/sketch-constraints.md"), "utf8");
  const sources = guide.match(/^sources:\n((?:\s+- .+\n)+)/m)?.[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\s+- /, ""));
  assert.deepEqual(sources, [
    "apps/web/src/components/SketchForgeEditor.tsx",
    "apps/web/src/components/SketchWorkspace.tsx",
    "apps/web/src/lib/sketchConstraints.ts",
  ]);
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

test("agent instruction documents are not treated as published site pages", async (t) => {
  // `docs/agents/` holds instructions AGENTS.md points agents at, not pages the
  // site publishes. Holding them to the published-page contract would mean they
  // could not be committed at all, leaving AGENTS.md citing files that are
  // absent from a fresh checkout.
  const root = await createRepository(
    t,
    "# Issue tracker\n\nUse the `gh` CLI:\n\n```sh\ngh pr list --repo constructorfleet/SketchForge-3D\n```\n",
    "docs/agents/issue-tracker.md",
  );
  const result = runDocsCheck(root);
  assert.equal(result.status, 0, `agent instruction docs should pass unchanged:\n${result.stdout}${result.stderr}`);
});

test("changed REST example source reports the REST API guide owner", async (t) => {
  const source = "docs/examples/rest-hole-plate.mjs";
  const root = await createRepository(
    t,
    `---\nslug: "/docs/REST_API"\ntitle: REST API\naudience: API users\nowner: API\nsources:\n  - ${source}\n---\n# REST API\n`,
    "docs/REST_API.md",
  );
  await mkdir(path.dirname(path.join(root, source)), { recursive: true });
  await writeFile(path.join(root, source), "export const walkthrough = 'initial';\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "add REST walkthrough source fixture"], { cwd: root });
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  await writeFile(path.join(root, source), "export const walkthrough = 'changed';\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-qm", "change REST walkthrough source"], { cwd: root });

  const result = runDocsCheck(root, "--base-ref", base);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /docs\/examples\/rest-hole-plate\.mjs -> \/docs\/REST_API \(docs\/REST_API\.md\)/);
});
