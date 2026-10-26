import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("release-process guide documents the configured release path", async () => {
  const guide = await read("docs/RELEASE_PROCESS.md");
  for (const phrase of [
    "Conventional Commit",
    "release-please",
    "release pull request",
    "Docker",
    "Python",
    "desktop installers",
    "docs/CHANGELOG.md",
  ]) assert.match(guide, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("Windows release documentation names the workflow artifact and unsigned policy", async () => {
  const [readme, setup, release] = await Promise.all([
    read("README.md"),
    read(".github/SETUP.md"),
    read("docs/RELEASE_PROCESS.md"),
  ]);
  assert.match(readme, /## Windows Desktop Release/);
  assert.match(readme, /SketchForge-Setup-<version>-x64\.exe/);
  assert.match(readme, /SmartScreen/);
  assert.match(setup, /Windows.*unsigned|unsigned.*Windows/is);
  assert.match(release, /SketchForge-Setup-<version>-x64\.exe/);
});

test("release metadata versions and release-please package coverage stay aligned", async () => {
  const [root, engine, client, python, manifestText, configText, workflow] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("packages/sketchforge-engine/package.json").then(JSON.parse),
    read("packages/sketchforge-client/package.json").then(JSON.parse),
    read("packages/sketchforge-py/pyproject.toml"),
    read(".release-please-manifest.json"),
    read("release-please-config.json"),
    read(".github/workflows/release-please.yml"),
  ]);
  const version = root.version;
  assert.equal(engine.version, version);
  assert.equal(client.version, version);
  assert.match(python, new RegExp(`^version\\s*=\\s*"${version.replaceAll(".", "\\.")}"`, "m"));
  assert.equal(JSON.parse(manifestText)["."], version);

  const config = JSON.parse(configText);
  const releasePackage = config.packages["."];
  assert.equal(releasePackage["release-type"], "node");
  for (const file of [
    "packages/sketchforge-engine/package.json",
    "packages/sketchforge-client/package.json",
    "packages/sketchforge-py/pyproject.toml",
  ]) assert.ok(releasePackage["extra-files"].some((entry) => entry.path === file), `missing release version target: ${file}`);
  assert.match(workflow, /config-file:\s*release-please-config\.json/);
  assert.match(workflow, /manifest-file:\s*\.release-please-manifest\.json/);
  assert.match(workflow, /gh workflow run release\.yml/);
  assert.match(workflow, /gh workflow run desktop-release\.yml/);
});

test("the release pull request is opened by the app, so its own checks run", async () => {
  const workflow = await read(".github/workflows/release-please.yml");

  assert.match(workflow, /uses:\s*actions\/create-github-app-token@v\d/,
    "release-please needs an identity other than GITHUB_TOKEN: GitHub starts no workflow run for an event its own token created, so the release pull request would never be checked");
  assert.match(workflow, /app-id:\s*\$\{\{\s*secrets\.APP_ID\s*\}\}/);
  assert.match(workflow, /private-key:\s*\$\{\{\s*secrets\.APP_KEY\s*\}\}/);

  const releaseStep = workflow.match(/uses:\s*googleapis\/release-please-action@v4[\s\S]*?(?=\n\s{6}- |\n\s{2}\w)/);
  assert.ok(releaseStep, "the release-please step should still be present");
  assert.match(releaseStep[0], /token:\s*\$\{\{\s*steps\.[\w-]+\.outputs\.token\s*\}\}/,
    "release-please must run with the app token, not the default one");
});

test("a release runs once: the app-pushed tag does not duplicate the dispatched runs", async () => {
  for (const file of [".github/workflows/release.yml", ".github/workflows/desktop-release.yml"]) {
    const workflow = await read(file);
    const triggers = workflow.match(/^on:\n([\s\S]*?)^\w/m);
    assert.ok(triggers, `${file} should declare triggers`);
    assert.doesNotMatch(triggers[1], /tags:/,
      `${file} is dispatched by release-please.yml. Once release-please holds an app identity its tag push starts workflows too, so a tag trigger here would publish every release twice.`);
    assert.match(triggers[1], /workflow_dispatch:/, `${file} must stay dispatchable`);
  }
});

test("every changelog entry sits under a section heading", async () => {
  const changelog = await read("docs/CHANGELOG.md");
  const body = changelog.replace(/^---\n[\s\S]*?\n---\n/, "");
  const beforeFirstSection = body.slice(0, body.search(/^## /m));
  assert.doesNotMatch(beforeFirstSection, /^\s*[-*] /m,
    "entries above the first ## heading belong under ## Unreleased");
});
