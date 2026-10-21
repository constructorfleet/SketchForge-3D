import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = path.join(root, "docs/PUBLISHING_CLIENTS.md");
const manifest = JSON.parse(await readFile(path.join(root, ".release-please-manifest.json"), "utf8"));
const version = manifest["."];
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(".release-please-manifest.json must contain a valid root release version");
}

const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const engine = JSON.parse(await readFile(path.join(root, "packages/sketchforge-engine/package.json"), "utf8"));
const client = JSON.parse(await readFile(path.join(root, "packages/sketchforge-client/package.json"), "utf8"));
const python = await readFile(path.join(root, "packages/sketchforge-py/pyproject.toml"), "utf8");
const pythonVersion = python.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
for (const [name, actual] of [
  ["package.json", rootPackage.version],
  ["packages/sketchforge-engine/package.json", engine.version],
  ["packages/sketchforge-client/package.json", client.version],
  ["packages/sketchforge-client/package.json engine dependency", client.dependencies?.["@constructorfleet/sketchforge-engine"]],
  ["packages/sketchforge-py/pyproject.toml", pythonVersion],
]) {
  if (actual !== version) throw new Error(`${name} is ${actual}; expected release-please version ${version}`);
}

const start = "<!-- publishing-version-table:start -->";
const end = "<!-- publishing-version-table:end -->";
const table = [
  start,
  `| \`@constructorfleet/sketchforge3d\` | npm | \`${version}\` | <!-- x-release-please-version -->`,
  `| \`@constructorfleet/sketchforge-engine\` | npm | \`${version}\` | <!-- x-release-please-version -->`,
  `| \`sketchforge3d\` | PyPI | \`${version}\` | <!-- x-release-please-version -->`,
  end,
].join("\n");
const current = await readFile(outputPath, "utf8");
const markerPattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
if (!markerPattern.test(current)) throw new Error(`${path.relative(root, outputPath)} is missing publishing version table markers`);
const generated = current.replace(markerPattern, table);

if (process.argv.includes("--check")) {
  if (generated !== current) {
    console.error(`${path.relative(root, outputPath)} has a stale package version table; run node scripts/docs/generate-publishing-clients.mjs`);
    process.exitCode = 1;
  } else {
    console.log(`${path.relative(root, outputPath)} package versions are current (${version})`);
  }
} else {
  await writeFile(outputPath, generated);
  console.log(`Generated publishing client versions (${version}) in ${path.relative(root, outputPath)}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
