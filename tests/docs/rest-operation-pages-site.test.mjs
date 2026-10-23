import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../../", import.meta.url).pathname);

test("built REST operation references are linked and included in local search", () => {
  const output = path.join(root, "docs-site-dist");
  const restIndex = readFileSync(path.join(output, "docs/rest-api/index.html"), "utf8");
  const restGuide = readFileSync(path.join(output, "docs/REST_API.html"), "utf8");
  const searchCorpus = walk(output).filter((file) => file.endsWith(".json") || file.endsWith(".js"))
    .map((file) => readFileSync(file, "utf8")).join("\n");
  const openapi = JSON.parse(readFileSync(path.join(root, "docs/openapi-v1.json"), "utf8"));
  const operations = Object.entries(openapi.paths).flatMap(([route, methods]) => Object.entries(methods)
    .filter(([method]) => method !== "options")
    .map(([method, operation]) => ({ method: method.toUpperCase(), route, ...operation })));

  assert.equal(operations.length, 28);
  assert.ok(restGuide.includes('href="/SketchForge-3D/docs/rest-api/"'), "REST API guide links to the operation reference index");
  assert.ok(restIndex.includes('href="/SketchForge-3D/openapi-v1.json"'), "operation index links to the downloadable OpenAPI source");
  for (const operation of operations) {
    const page = path.join(output, "docs/rest-api", `${operation.operationId}.html`);
    assert.ok(statSync(page).isFile(), `${operation.operationId} has a rendered reference page`);
    const html = readFileSync(page, "utf8");
    assert.match(html, new RegExp(operation.operationId));
    assert.match(html, new RegExp(operation.method));
    assert.match(html, /Authentication/);
    assert.match(html, /Responses/);
    assert.match(html, /https:\/\/github\.com\/constructorfleet\/SketchForge-3D\/blob\/[0-9a-f]+\/apps\/web\/src\/app\/api\/v1\//);
    assert.ok(restIndex.includes(`href="./${operation.operationId}"`), `${operation.operationId} is linked from the REST reference index`);
    assert.ok(searchCorpus.includes(operation.operationId), `${operation.operationId} is indexed for local search`);
  }
});

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}
