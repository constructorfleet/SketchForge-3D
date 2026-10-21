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
