import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readme = await readFile(path.join(root, "README.md"), "utf8");
const config = await readFile(path.join(root, "docs/.vitepress/config.mts"), "utf8");

test("README has a distinct installation section covering supported install paths", () => {
  const installation = readme.split(/^## /m).find((section) => section.startsWith("Installation\n")) ?? "";
  assert.ok(installation, "README should have a top-level Installation section");
  for (const pathName of ["Desktop releases", "Docker", "run from source", "static export"]) {
    assert.match(installation, new RegExp(pathName, "i"), `Installation should explain ${pathName}`);
  }
});

test("VitePress top navigation groups documentation instead of listing every category", () => {
  const nav = config.match(/nav:\s*\[([\s\S]*?)\n\s*\],\n\s*sidebar:/)?.[1] ?? "";
  const topLevelLinks = [...nav.matchAll(/^      \{\s*text:/gm)];
  assert.ok(topLevelLinks.length <= 5, `Expected at most 5 top-level nav entries, found ${topLevelLinks.length}`);
  assert.match(nav, /Install/i, "installation should be reachable from the top navigation");
  assert.match(nav, /items:/, "related documentation categories should be grouped in dropdowns");
});
