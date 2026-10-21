import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);
const require = createRequire(import.meta.url);
const packageVersion = require("../../package.json").version;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootPath, encoding: "utf8" }).trim();

test("built docs emit the project-site shell, imported README, and local search", () => {
  const indexPath = new URL("../../docs-site-dist/index.html", import.meta.url);
  assert.ok(existsSync(indexPath), "VitePress output should include index.html");
  const html = readFileSync(indexPath, "utf8");
  assert.match(html, /href="\/SketchForge-3D\/assets\//);
  assert.match(html, /name="description"/);
  assert.doesNotMatch(html, /sketchforge3d\.com\/assets\//, "site shell should not fetch README imagery remotely");
  assert.ok(html.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/LICENSE`));
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

test("built pages identify their release and link to source at the represented revision", () => {
  const output = path.join(rootPath, "docs-site-dist");
  const home = readFileSync(path.join(output, "index.html"), "utf8");
  const packageGuide = readFileSync(path.join(output, "docs/packages/typescript-client.html"), "utf8");
  const builtPages = walk(output)
    .filter((file) => file.endsWith(".html") && path.basename(file) !== "404.html")
    .map((file) => readFileSync(file, "utf8"));

  assert.ok(builtPages.length > 1, "the smoke test should cover the rendered site pages");
  for (const html of builtPages) {
    assert.match(html, new RegExp(`Documentation version: <code>${packageVersion}</code>`));
    assert.match(html, new RegExp(`Repository revision: <a[^>]*><code>${revision}</code></a>`));
    assert.ok(html.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/`),
      "each page should include a source link pinned to the represented revision");
    assert.doesNotMatch(html, /fetch\([^)]*(?:version|revision|provenance)/i,
      "provenance should be rendered into static HTML, not fetched at runtime");
  }
  assert.ok(home.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/README.md`),
    "the landing page should link to the README revision it was built from");
  assert.ok(packageGuide.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/docs/packages/typescript-client.md`),
    "the package guide should link to its exact source revision");
});

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}
