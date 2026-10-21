import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("docs scripts generate and check each deterministic reference", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const generators = [
    "scripts/docs/generate-package-references.mjs",
    "scripts/generate-shape-reference.mjs",
    "scripts/generate-cli-reference.mjs",
    "scripts/generate-operator-configuration.mjs",
    "scripts/generate-skf-format-reference.mjs",
    "scripts/generate-mcp-reference.mjs",
  ];

  for (const generator of generators) {
    assert.ok(scripts["docs:generate"].includes(generator), `docs:generate must invoke ${generator}`);
    assert.ok(scripts["docs:check"].includes(`${generator} --check`), `docs:check must check ${generator}`);
  }
  assert.ok(scripts["docs:generate"].includes("npm run engine:build"), "generated package references require built engine declarations");
  assert.ok(scripts["docs:generate"].includes("npm run client:build"), "generated package references require built client declarations");
  assert.ok(scripts["docs:check"].includes("npm run engine:build"), "package checks require built engine declarations");
  assert.ok(scripts["docs:check"].includes("npm run client:build"), "package checks require built client declarations");
  assert.ok(scripts["docs:check"].includes("tests/docs/generator-hooks.test.mjs"), "CI docs checks must run the generator wiring test");
  assert.ok(scripts["docs:check"].includes("tests/docs/mcp-reference.test.mjs"), "CI docs checks must compare MCP schemas with live tools/list");
});
