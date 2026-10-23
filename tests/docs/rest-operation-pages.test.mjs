import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../../", import.meta.url).pathname);
const operationPagesScript = path.join(root, "scripts/generate-rest-operation-pages.mjs");

test("REST operation reference generator publishes every OpenAPI operation with its contract details", () => {
  const output = mkdtempSync(path.join(os.tmpdir(), "sketchforge-rest-operation-pages-"));
  try {
    execFileSync(process.execPath, [operationPagesScript, "--output-dir", output], { cwd: root });
    const openapi = JSON.parse(readFileSync(path.join(root, "docs/openapi-v1.json"), "utf8"));
    const operations = Object.entries(openapi.paths).flatMap(([route, methods]) => Object.entries(methods)
      .filter(([method]) => method !== "options")
      .map(([method, operation]) => ({ route, method, ...operation })));
    const pages = readdirSync(output).filter((entry) => entry.endsWith(".md") && entry !== "index.md");

    assert.equal(operations.length, 28);
    assert.equal(pages.length, 28);
    const firstOutput = readOutput(output);
    for (const operation of operations) {
      const markdown = readFileSync(path.join(output, `${operation.operationId}.md`), "utf8");
      assert.ok(markdown.includes(`**operationId:** \`${operation.operationId}\``));
      assert.ok(markdown.includes(`${operation.method.toUpperCase()} ${operation.route}`));
      assert.match(markdown, /## Authentication/);
      assert.match(markdown, /Provide either authentication method/);
      assert.match(markdown, /## Responses/);
      assert.match(markdown, /## Source/);
      assert.match(markdown, /apps\/web\/src\/app\/api\/v1\/.*\/route\.ts/);
    const routeRelative = operation.route.replace(/^\/api\/v1\/?/, "");
    const sourcePath = path.join(root, "apps/web/src/app/api/v1", routeRelative, "route.ts");
    assert.ok(existsSync(sourcePath), `${operation.operationId} links to an existing handler source`);
      for (const responseStatus of Object.keys(operation.responses)) assert.match(markdown, new RegExp(`### ${responseStatus}\\b`));
      for (const parameter of operation.parameters ?? []) assert.ok(markdown.includes(parameter.name));
      for (const contentType of Object.keys(operation.requestBody?.content ?? {})) assert.ok(markdown.includes(contentType));
    }

    const index = readFileSync(path.join(output, "index.md"), "utf8");
    assert.equal((index.match(/\]\(\.\/[^)]+\.md\)/g) ?? []).length, 28);
    assert.match(index, /OpenAPI contract/);
    execFileSync(process.execPath, [operationPagesScript, "--output-dir", output], { cwd: root });
    assert.deepEqual(readOutput(output), firstOutput, "generation from the same OpenAPI input is deterministic");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

function readOutput(directory) {
  return readdirSync(directory).sort().map((entry) => [entry, readFileSync(path.join(directory, entry), "utf8")]);
}
