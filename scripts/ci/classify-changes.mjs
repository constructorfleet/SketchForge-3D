#!/usr/bin/env node
// Decides whether a pull request changes anything the code jobs in ci.yml and
// docker.yml can see. Prints nothing; appends `code=true` or `code=false` to
// $GITHUB_OUTPUT (or stdout when that is unset).
//
// Docs-only is decided per file, and conservatively: a file is docs-only when
// it is Markdown or a documentation image outside the code trees, or is part
// of the documentation site theme, and no code job reads it. Everything else,
// and any doubt, is code. The docs workflow checks and builds the site on every
// pull request regardless, so skipping code jobs loses no coverage of the
// documentation itself.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Read by a code job, so a change to one of these is a code change:
// - README.md: tests/unit/repositoryIdentity.test.ts
// - docs/REST_API.md: tests/unit/repositoryIdentity.test.ts
// - docs/SKF_FORMAT_REFERENCE.md: tests/unit/skfFormatReference.test.ts
// - docs/SHAPE_REQUEST_REFERENCE.md: tests/unit/shapeReferenceInventory.test.ts
// - docs/DOCUMENTATION_SUITE_SPEC.md: scripts/docs/generate-package-references.mjs,
//   run by tests/unit/docsPackageReferences.test.ts
// - docs/packages/, docs/guides/package-examples.md: tests/unit/docsPackageReferences.test.ts
// docs/openapi-v1.json and docs/examples/*.mjs are not Markdown, so they are
// code without being listed; the client tests parse and run them.
const READ_BY_CODE = new Set([
  "README.md",
  "docs/REST_API.md",
  "docs/SKF_FORMAT_REFERENCE.md",
  "docs/SHAPE_REQUEST_REFERENCE.md",
  "docs/DOCUMENTATION_SUITE_SPEC.md",
  "docs/guides/package-examples.md",
]);
const READ_BY_CODE_DIRS = ["docs/packages/"];

// Trees whose Markdown ships in a package or sits beside tests and tooling.
const CODE_TREES = ["apps/", "packages/", "scripts/", "tests/", "tools/", "deploy/"];

const MEDIA = /\.(?:png|jpe?g|gif|svg|webp|mp4|webm)$/i;

export function isDocsOnlyPath(file) {
  if (READ_BY_CODE.has(file)) return false;
  if (READ_BY_CODE_DIRS.some((dir) => file.startsWith(dir))) return false;
  if (CODE_TREES.some((dir) => file.startsWith(dir))) return false;
  if (file.startsWith("docs/.vitepress/")) return true;
  if (file.endsWith(".md")) return true;
  return file.startsWith("docs/") && MEDIA.test(file);
}

/** True unless every listed file is docs-only. An empty list is code. */
export function touchesCode(files) {
  const listed = files.map((file) => file.trim()).filter(Boolean);
  return listed.length === 0 || !listed.every(isDocsOnlyPath);
}

/**
 * Only a pull request can skip code. A push to main, a dispatch, or a failure
 * to list the changed files runs everything.
 */
export function decide({ eventName, listChangedFiles }) {
  if (eventName !== "pull_request") return true;
  try {
    return touchesCode(listChangedFiles());
  } catch (error) {
    console.error(`Could not list changed files; running code jobs: ${error.message}`);
    return true;
  }
}

// actions/checkout puts a pull_request run on the merge commit; its first
// parent is the base it was merged onto.
function gitChangedFiles() {
  return execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], { encoding: "utf8" }).split("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = decide({ eventName: process.env.GITHUB_EVENT_NAME, listChangedFiles: gitChangedFiles });
  const line = `code=${code}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
  console.error(code ? "Code changed: running code jobs." : "Documentation only: skipping code jobs.");
}
