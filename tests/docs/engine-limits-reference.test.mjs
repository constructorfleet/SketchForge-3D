import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith(".ts") ? [file] : [];
  });
}

test("every exported MAX_* engine constant is named in the REST reference", () => {
  const source = sourceFiles(path.join(root, "packages/sketchforge-engine/src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const restReference = readFileSync(path.join(root, "docs/REST_API.md"), "utf8");
  const exportedLimits = [...source.matchAll(/export\s+const\s+(MAX_[A-Z0-9_]+)/g)].map((match) => match[1]);
  const undocumented = [...new Set(exportedLimits)].filter((name) => !restReference.includes(name));

  assert.deepEqual(undocumented, [], `REST_API.md does not mention exported engine limits: ${undocumented.join(", ")}`);
});
