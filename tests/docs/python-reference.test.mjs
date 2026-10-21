import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Python API entries link to their defining source lines", async () => {
  const reference = await readFile(path.join(root, "docs/reference/python-client.md"), "utf8");
  const entries = reference.split(/^## /m).slice(1);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry, /\[Source\]\(https:\/\/github\.com\/constructorfleet\/SketchForge-3D\/blob\/main\/packages\/sketchforge-py\/src\/sketchforge3d\/[\w.]+#L\d+\)/,
      `Python API entry lacks a precise source link: ${entry.split("\n", 1)[0]}`);
  }
});

test("Python documentation checks run the package and examples through mypy", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(scripts["docs:check"].includes("mypy"), "docs:check must run Python static checking");
  assert.ok(scripts["docs:check"].includes("cd packages/sketchforge-py && python3 -m mypy src examples"));
});
