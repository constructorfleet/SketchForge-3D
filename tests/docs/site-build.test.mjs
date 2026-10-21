import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);

test("built docs emit the project-site shell, imported README, and local search", () => {
  const indexPath = new URL("../../docs-site-dist/index.html", import.meta.url);
  assert.ok(existsSync(indexPath), "VitePress output should include index.html");
  const html = readFileSync(indexPath, "utf8");
  assert.match(html, /href="\/SketchForge-3D\/assets\//);
  assert.match(html, /name="description"/);
  assert.doesNotMatch(html, /sketchforge3d\.com\/assets\//, "site shell should not fetch README imagery remotely");
  assert.match(html, /github\.com\/constructorfleet\/SketchForge-3D\/blob\/main\/LICENSE/);
  assert.doesNotMatch(html, /href="LICENSE"/, "repository-relative HTML links should not become broken site links");

  const output = path.join(rootPath, "docs-site-dist");
  const files = walk(output);
  const searchFiles = files.filter((file) => file.endsWith(".json") || file.endsWith(".js"));
  const search = searchFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.match(search, /SketchForge/);
  assert.match(search, /REST API/);
  assert.match(search, /search/i, "built-in client search code should be present");
  assert.match(html, /docs\/packages\/typescript-client/, "package guides should be reachable from site navigation");
  assert.match(html, /docs\/reference\/typescript-client/, "generated API references should be reachable from site navigation");
  assert.match(html, /docs\/CLI_REFERENCE/, "published CLI reference should be reachable from site navigation");
});

test("documentation suite status distinguishes merged work from open PRs", () => {
  const spec = readFileSync(new URL("../../docs/DOCUMENTATION_SUITE_SPEC.md", import.meta.url), "utf8");
  const changelog = readFileSync(new URL("../../docs/CHANGELOG.md", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../docs/site-migration.md", import.meta.url), "utf8");

  assert.match(spec, /first GitHub Pages deployment after PR #116 merged succeeded/i);
  assert.match(spec, /Package\/example references merged in PR #118/i);
  assert.match(spec, /`GET \/faces` contract merged in PR #120/i);
  assert.match(spec, /operator configuration[^\n]*PR #121[^\n]*merged/i);
  assert.match(spec, /`\.skf` reference merged in PR #123/i);
  assert.match(spec, /MCP[^\n]*PR #122[^\n]*open/i);
  assert.match(spec, /PATCH faceColors[^\n]*PR #125[^\n]*open/i);
  assert.match(spec, /STEP[^\n]*PR #119[^\n]*open/i);
  assert.match(spec, /merged in PR #112/i);
  assert.match(spec, /PR #115/i);
  assert.match(spec, /PR #117/i);
  assert.doesNotMatch(spec, /before the first deployment|first published deployment.*not verified|Pages publishing source.*not changed/i);

  assert.match(changelog, /first GitHub Pages deployment after PR #116\s+merged succeeded/i);
  assert.match(changelog, /Merged PR #118/i);
  assert.match(changelog, /Merged PR #120/i);
  assert.match(changelog, /Merged PR #121/i);
  assert.match(changelog, /Merged PR #123/i);
  assert.match(changelog, /open documentation PRs: #119/i);
  assert.match(changelog, /MCP tool schema reference/i);
  assert.match(changelog, /open PR #125/i);
  assert.match(changelog, /Merged PR #116/i);
  assert.match(changelog, /Merged PR #117/i);
  assert.doesNotMatch(changelog, /before the first deployment|must select GitHub Actions as the publishing source/i);

  assert.match(migration, /first GitHub Pages deployment after PR #116\s+merged succeeded/i);
  assert.match(migration, /package references and executable examples merged in PR #118/i);
  assert.match(migration, /stable-face `GET \/faces` contract merged in\s+PR #120/i);
  assert.match(migration, /operator configuration \(#121\)[^\n]*and `\.skf` format reference \(#123\) have\s+merged/i);
  assert.match(migration, /STEP documentation PR #119 and MCP reference PR #122 remain open/i);
  assert.match(migration, /`PATCH faceColors`\s+contract in PR #125 is open/i);
  assert.doesNotMatch(migration, /still needs to be set|before the first deployment|could not be confirmed/i);
});

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}
