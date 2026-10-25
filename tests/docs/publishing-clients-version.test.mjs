import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("publishing clients table shows the current release-please version", async () => {
  const [guide, manifestText, rootText, engineText, clientText, python, pythonInit] = await Promise.all([
    read("docs/PUBLISHING_CLIENTS.md"),
    read(".release-please-manifest.json"),
    read("package.json"),
    read("packages/sketchforge-engine/package.json"),
    read("packages/sketchforge-client/package.json"),
    read("packages/sketchforge-py/pyproject.toml"),
    read("packages/sketchforge-py/src/sketchforge3d/__init__.py"),
  ]);
  const version = JSON.parse(manifestText)["."];
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  for (const packageText of [rootText, engineText, clientText]) {
    assert.equal(JSON.parse(packageText).version, version);
  }
  assert.match(python, new RegExp(`^version\\s*=\\s*"${version.replaceAll(".", "\\.")}"`, "m"));
  assert.match(pythonInit, /from importlib\.metadata import PackageNotFoundError, version as _distribution_version/);
  assert.match(pythonInit, /return _distribution_version\("sketchforge3d"\)/);
  assert.match(pythonInit, /except PackageNotFoundError:/);
  assert.match(
    pythonInit,
    new RegExp(`^_SOURCE_VERSION\\s*=\\s*"${version.replaceAll(".", "\\.")}"\\s+# x-release-please-version$`, "m"),
    "Python source fallback should match the release-please manifest",
  );
  assert.match(pythonInit, /__version__ = _read_version\(\)/);

  for (const name of ["@constructorfleet/sketchforge3d", "@constructorfleet/sketchforge-engine", "sketchforge3d"]) {
    const row = guide.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
    assert.ok(row, `missing publishing row for ${name}`);
    assert.ok(row.includes(`| \`${version}\` |`), `${name} row should show ${version}: ${row}`);
  }
  assert.doesNotMatch(guide, /the release version/i);

  const releaseConfig = JSON.parse(await read("release-please-config.json"));
  assert.ok(
    releaseConfig.packages["."]["extra-files"].some(
      (file) => file.type === "generic" && file.path === "docs/PUBLISHING_CLIENTS.md",
    ),
    "release-please should update the publishing versions as part of every release PR",
  );
  assert.ok(
    releaseConfig.packages["."]["extra-files"].some(
      (file) => file.type === "generic" && file.path === "packages/sketchforge-py/src/sketchforge3d/__init__.py",
    ),
    "release-please should update the Python package version on every release PR",
  );
  for (const name of ["@constructorfleet/sketchforge3d", "@constructorfleet/sketchforge-engine", "sketchforge3d"]) {
    const row = guide.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
    assert.match(row, /x-release-please-version/, `${name} row needs a release-please version marker`);
  }
});
