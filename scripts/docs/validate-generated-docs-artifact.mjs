import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GENERATED_DOC_PATHS = Object.freeze([
  "docs/CLI_REFERENCE.md",
  "docs/OPERATOR_CONFIGURATION.md",
  "docs/PUBLISHING_CLIENTS.md",
  "docs/SHAPE_REQUEST_REFERENCE.md",
  "docs/SKF_FORMAT_REFERENCE.md",
  "docs/mcp/TOOLS_REFERENCE.md",
  "docs/openapi-v1.json",
]);

const shaPattern = /^[a-f0-9]{40}$/;

export function isRepositoryFullName(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function parseArguments(args) {
  const values = new Map();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Invalid argument: ${arg}`);
    values.set(match[1], match[2]);
  }
  for (const name of ["artifact-dir", "expected-repo", "expected-pull-request", "expected-head-sha", "expected-base-sha"]) {
    if (!values.has(name) || values.get(name) === "") throw new Error(`Missing --${name}`);
  }
  const pullRequest = Number(values.get("expected-pull-request"));
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) throw new Error("Invalid expected pull request number");
  for (const name of ["expected-head-sha", "expected-base-sha"]) {
    if (!shaPattern.test(values.get(name))) throw new Error(`Invalid --${name}`);
  }
  return {
    artifactDir: path.resolve(values.get("artifact-dir")),
    repo: values.get("expected-repo"),
    pullRequest,
    headSha: values.get("expected-head-sha"),
    baseSha: values.get("expected-base-sha"),
  };
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Artifact contains a non-file entry: ${relative}`);
  }
  return files;
}

export async function validateGeneratedDocsArtifact(expected) {
  const manifestPath = path.join(expected.artifactDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.repo !== expected.repo) throw new Error("Generated docs artifact repository does not match");
  if (manifest.pullRequest !== expected.pullRequest) throw new Error("Generated docs artifact pull request does not match");
  if (manifest.headSha !== expected.headSha) throw new Error("Generated docs artifact head SHA does not match");
  if (manifest.baseSha !== expected.baseSha) throw new Error("Generated docs artifact base SHA does not match");
  if (!Array.isArray(manifest.files) || JSON.stringify(manifest.files) !== JSON.stringify(GENERATED_DOC_PATHS)) {
    throw new Error("Generated docs artifact file list does not match the allowlist");
  }

  const expectedFiles = ["manifest.json", ...GENERATED_DOC_PATHS].sort();
  const actualFiles = (await listFiles(expected.artifactDir)).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Generated docs artifact contains missing or unapproved files");
  }
  for (const relative of GENERATED_DOC_PATHS) {
    const info = await lstat(path.join(expected.artifactDir, relative));
    if (!info.isFile() || info.size > 5_000_000) throw new Error(`Generated file is not a regular file under 5 MB: ${relative}`);
  }
  return GENERATED_DOC_PATHS;
}

async function main() {
  const expected = parseArguments(process.argv.slice(2));
  const files = await validateGeneratedDocsArtifact(expected);
  console.log(`Validated ${files.length} generated documentation files for PR #${expected.pullRequest} at ${expected.headSha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
