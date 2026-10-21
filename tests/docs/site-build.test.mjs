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
  assert.match(html, /docs\/SKF_FORMAT_REFERENCE/, ".skf reference should be reachable from site navigation");
  assert.match(html, /docs\/OPERATOR_CONFIGURATION/, "operator configuration reference should be reachable from site navigation");
  assert.match(html, /docs\/mcp\/TOOLS_REFERENCE/, "MCP tool reference should be reachable from site navigation");
});

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}
