import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { lintContract } from "./lib/contract-lint.mjs";

const rootArgumentIndex = process.argv.indexOf("--root");
const rootArgument = rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : undefined;
if (rootArgumentIndex >= 0 && !rootArgument) throw new Error("--root requires a value");
const baseRefArgumentIndex = process.argv.indexOf("--base-ref");
const baseRef = baseRefArgumentIndex >= 0 ? process.argv[baseRefArgumentIndex + 1] : process.env.DOCS_BASE_REF;
if (baseRefArgumentIndex >= 0 && !baseRef) throw new Error("--base-ref requires a value");
const root = rootArgument ? path.resolve(rootArgument) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);
const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const generatedReferenceDirectory = path.join(root, ".docs-site/docs/reference");
const generatedReferences = await readdir(generatedReferenceDirectory, { withFileTypes: true })
  .then((entries) => entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => path.posix.join(".docs-site/docs/reference", entry.name)))
  .catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
const sources = [...new Set([...tracked, ...generatedReferences, "README.md", "docs/index.md"])];
const failures = [];
const warnings = [];
const pageSlugs = new Map();
const ownerPages = [];
// Public API/package sources and the primary editor component map to documentation pages.
const publicSourceScopes = [
  "apps/web/src/components/SketchForgeEditor.tsx",
  "apps/web/src/app/api/v1/**",
  "packages/sketchforge-client/src/**",
  "packages/sketchforge-client/examples/**",
  "packages/sketchforge-client/mcp/**",
  "packages/sketchforge-engine/src/**",
  "packages/sketchforge-py/src/**",
  "packages/sketchforge-py/examples/**",
];
const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
const runnableLanguages = new Set(["bash", "js", "python", "sh", "ts"]);

for (const sourceRelative of sources) {
  const sourcePath = path.join(root, sourceRelative);
  let contents;
  try {
    contents = await readFile(sourcePath, "utf8");
  } catch {
    failures.push(`${sourceRelative}: canonical Markdown source is missing`);
    continue;
  }

  // A document that declares itself an acceptance contract is linted against
  // the contract rules; every other document is untouched. Blocking violations
  // fail this check; warnings are reported without failing it.
  for (const violation of lintContract(contents)) {
    const where = `${sourceRelative}:${violation.line}`;
    const detail = violation.span ? ` (${violation.span})` : "";
    if (violation.severity === "block") {
      failures.push(`${where}: [${violation.rule}] ${violation.message}${detail}`);
    } else {
      warnings.push(`${where}: [${violation.rule}] ${violation.message}${detail}`);
    }
  }

  if ((sourceRelative.startsWith("docs/") || sourceRelative.startsWith(".docs-site/docs/reference/")) && sourceRelative.endsWith(".md")) {
    const metadata = validatePageOwnership(sourceRelative, contents, failures, pageSlugs, trackedFiles);
    if (metadata) ownerPages.push({ path: sourceRelative, slug: metadata.slug, title: metadata.title, sources: metadata.sources });
    if (sourceRelative.startsWith("docs/") && !sourceRelative.startsWith("docs/reference/")) {
      await validateRunnableBlocks(sourceRelative, contents, failures, trackedFiles);
    }
  }

  for (const match of contents.matchAll(/!!!include\(([^)]+)\)!!!/g)) {
    const included = path.resolve(path.dirname(sourcePath), match[1].trim());
    if (!included.startsWith(`${root}${path.sep}`)) {
      failures.push(`${sourceRelative}: include escapes repository: ${match[1]}`);
      continue;
    }
    try {
      await readFile(included, "utf8");
    } catch {
      failures.push(`${sourceRelative}: included source not found: ${match[1]}`);
    }
  }

  for (const match of contents.matchAll(markdownLink)) {
    const rawHref = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(rawHref)) continue;
    let href;
    try { href = decodeURIComponent(rawHref); } catch {
      failures.push(`${sourceRelative}: invalid URL encoding in ${rawHref}`);
      continue;
    }
    const [relativePath, fragment] = href.split(/(?=[?#])/, 2);
    const target = path.resolve(path.dirname(sourcePath), relativePath.split(/[?#]/, 1)[0]);
    if (!target.startsWith(`${root}${path.sep}`)) {
      failures.push(`${sourceRelative}: link escapes repository: ${rawHref}`);
      continue;
    }
    try {
      const targetText = await readLocalTarget(target);
      const fragmentText = fragment?.replace(/^[?#]/, "");
      if (fragmentText && target.endsWith(".md") && !hasHeading(targetText, fragmentText)) {
        failures.push(`${sourceRelative}: heading #${fragmentText} not found in ${path.relative(root, target)}`);
      }
    } catch {
      failures.push(`${sourceRelative}: local link target not found: ${rawHref}`);
    }
  }

  for (const match of contents.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const rawHref = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(rawHref)) continue;
    let href;
    try { href = decodeURIComponent(rawHref); } catch {
      failures.push(`${sourceRelative}: invalid URL encoding in ${rawHref}`);
      continue;
    }
    const [relativePath, fragment] = href.split(/(?=[?#])/, 2);
    const target = path.resolve(path.dirname(sourcePath), relativePath.split(/[?#]/, 1)[0]);
    if (!target.startsWith(`${root}${path.sep}`)) {
      failures.push(`${sourceRelative}: link escapes repository: ${rawHref}`);
      continue;
    }
    try {
      const targetText = await readLocalTarget(target);
      const fragmentText = fragment?.replace(/^[?#]/, "");
      if (fragmentText && target.endsWith(".md") && !hasHeading(targetText, fragmentText)) {
        failures.push(`${sourceRelative}: heading #${fragmentText} not found in ${path.relative(root, target)}`);
      }
    } catch {
      failures.push(`${sourceRelative}: local link target not found: ${rawHref}`);
    }
  }
}

if (warnings.length) {
  console.warn(
    `Contract warnings (${warnings.length}) — reported, not blocking:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
  );
}
if (baseRef) reportChangedSourceOwners(baseRef, ownerPages, failures);

if (failures.length) {
  console.error(`Documentation checks failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${sources.length} canonical Markdown sources, local links, includes, and acceptance contracts.`);
}

function hasHeading(contents, fragment) {
  const wanted = fragment.toLowerCase().replace(/%20/g, " ");
  return contents.split("\n").some((line) => {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) return false;
    const slug = heading.toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    return slug === wanted;
  });
}

async function readLocalTarget(target) {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT" || !target.startsWith(`${root}${path.sep}`)) throw error;
    return readFile(path.join(root, ".docs-site", path.relative(root, target)), "utf8");
  }
}

function validatePageOwnership(sourceRelative, contents, failures, pageSlugs, trackedFiles) {
  const fields = readOwnershipFrontmatter(contents);
  if (!fields) {
    failures.push(`${sourceRelative}: missing required frontmatter field \`slug\``);
    return;
  }

  for (const field of ["slug", "title", "audience", "owner"]) {
    if (!fields[field]) failures.push(`${sourceRelative}: missing required frontmatter field \`${field}\``);
  }
  if (fields.slug && !(fields.slug === "/" || (/^\/docs\/[A-Za-z0-9._/-]*$/.test(fields.slug)
    && !fields.slug.split("/").some((segment) => segment === "." || segment === "..")))) {
    failures.push(`${sourceRelative}: slug must be an absolute site path starting with /docs/ (or / for the home page)`);
  }
  if (fields.slug) {
    const previous = pageSlugs.get(fields.slug);
    if (previous) failures.push(`${sourceRelative}: slug ${fields.slug} is already assigned to ${previous}`);
    else pageSlugs.set(fields.slug, sourceRelative);
  }
  if (fields.title && /[\r\n]/.test(fields.title)) failures.push(`${sourceRelative}: title must be a single line`);
  if (fields.owner && !/^[A-Za-z][A-Za-z0-9 &-]*$/.test(fields.owner)) {
    failures.push(`${sourceRelative}: owner must name a documentation owner area`);
  }
  for (const sourcePattern of fields.sources) {
    if (!isSafeSourcePattern(sourcePattern)) failures.push(`${sourceRelative}: invalid source ownership pattern ${sourcePattern}`);
    else if (!trackedFiles.some((file) => sourcePatternMatches(sourcePattern, file))) {
      failures.push(`${sourceRelative}: source ownership pattern matches no tracked file: ${sourcePattern}`);
    }
  }
  return fields;
}

function readOwnershipFrontmatter(contents) {
  const lines = contents.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  const fields = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    const match = line.match(/^(slug|title|audience|owner):\s*(.*?)\s*$/);
    if (match) fields[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    const sourceMatch = line.match(/^sources:\s*(.*?)\s*$/);
    if (sourceMatch) {
      fields.sources = [];
      if (sourceMatch[1] && sourceMatch[1] !== "[]") {
        fields.sources.push(...sourceMatch[1].replace(/^\[|\]$/g, "").split(",").map(cleanYamlScalar).filter(Boolean));
      } else if (!sourceMatch[1]) {
        while (index + 1 < end && /^\s+-\s+/.test(lines[index + 1])) {
          fields.sources.push(cleanYamlScalar(lines[index + 1].replace(/^\s+-\s+/, "")));
          index += 1;
        }
      }
    }
  }
  fields.sources ??= [];
  return fields;
}

function isSafeSourcePattern(pattern) {
  return typeof pattern === "string" && pattern.length > 0 && !pattern.startsWith("/")
    && !pattern.includes("\\") && !pattern.split("/").some((segment) => segment === ".." || segment === ".");
}

function sourcePatternMatches(pattern, sourcePath) {
  const expression = pattern.split("**").map((part) => part.split("*").map(escapeRegExp).join("[^/]*")).join(".*");
  return new RegExp(`^${expression}$`).test(sourcePath);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function cleanYamlScalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

async function validateRunnableBlocks(sourceRelative, contents, failures, trackedFiles) {
  const lines = contents.split("\n");
  let activeFence;
  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!fence) continue;
    if (!activeFence) {
      activeFence = {
        marker: fence[1][0],
        length: fence[1].length,
        language: fence[2].trim().split(/\s+/, 1)[0].toLowerCase(),
        start: index,
      };
      continue;
    }
    if (fence[1][0] !== activeFence.marker || fence[1].length < activeFence.length) continue;
    if (runnableLanguages.has(activeFence.language)) {
      await validateRunnableBlock(sourceRelative, lines, activeFence, index, failures, trackedFiles);
    }
    activeFence = undefined;
  }
}

async function validateRunnableBlock(sourceRelative, lines, fence, endIndex, failures, trackedFiles) {
  const location = `${sourceRelative}:${fence.start + 1}`;
  const declaration = lines[fence.start - 1]?.trim();
  const exemption = declaration?.match(/^<!--\s*runnable-exempt:\s*(.*?)\s*-->$/);
  if (exemption) {
    if (exemption[1].length < 20) failures.push(`${location}: runnable-exempt metadata needs a concrete reason`);
    return;
  }

  const sourceDeclaration = declaration?.match(/^<!--\s*runnable-source:\s*([^;]+);\s*tested-by:\s*([^;]+);\s*ci:\s*([^>]+?)\s*-->$/);
  if (!sourceDeclaration) {
    failures.push(`${location}: runnable ${fence.language} block needs runnable-source or runnable-exempt metadata`);
    return;
  }

  const source = sourceDeclaration[1].trim();
  const testedBy = sourceDeclaration[2].trim();
  const ciCommand = sourceDeclaration[3].trim();
  if (!isSafeSourcePattern(source) || source.includes("*") || !trackedFiles.includes(source)) {
    failures.push(`${location}: runnable source must name an existing tracked file: ${source}`);
    return;
  }

  const includedSource = lines.slice(fence.start + 1, endIndex).join("\n").trim()
    .match(/^!!!include\(([^)]+)\)!!!$/)?.[1];
  const resolvedSource = includedSource && path.relative(root, path.resolve(path.dirname(path.join(root, sourceRelative)), includedSource)).split(path.sep).join("/");
  if (resolvedSource !== source) {
    const includePath = path.relative(path.dirname(path.join(root, sourceRelative)), path.join(root, source)).split(path.sep).join("/");
    failures.push(`${location}: runnable source block must include its declared source with a matching \`!!!include(${includePath})!!!\` directive`);
    return;
  }

  if (!trackedFiles.includes(testedBy)) {
    failures.push(`${location}: runnable source test is missing or untracked: ${testedBy}`);
    return;
  }
  const testContents = await readFile(path.join(root, testedBy), "utf8");
  if (!testContents.includes(path.posix.basename(source))) {
    failures.push(`${location}: runnable source test does not reference ${source}: ${testedBy}`);
    return;
  }
  if (!(await runnableTestIsWired(testedBy, ciCommand, trackedFiles))) {
    failures.push(`${location}: runnable source test is not wired to CI command ${ciCommand}: ${testedBy}`);
  }
}

async function runnableTestIsWired(testedBy, ciCommand, trackedFiles) {
  const workflowPaths = trackedFiles.filter((file) => file.startsWith(".github/workflows/") && file.endsWith(".yml"));
  const workflows = await Promise.all(workflowPaths.map((file) => readFile(path.join(root, file), "utf8")));
  if (!workflows.some((workflow) => workflow.split("\n").some((line) => /^-?\s*run:\s*/.test(line.trim()) && line.trim().endsWith(ciCommand)))) return false;

  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (ciCommand === "npm run test:integration") {
    const integrationConfig = await readFile(path.join(root, "tests/vitest.integration.config.ts"), "utf8").catch(() => "");
    return packageManifest.scripts?.["test:integration"]?.includes("tests/vitest.integration.config.ts")
      && integrationConfig.includes("packages/**/tests/**/*.integration.ts")
      && testedBy.endsWith(".integration.ts");
  }
  if (ciCommand === "npm run client:test:py:integration") {
    return packageManifest.scripts?.["client:test:py:integration"]?.includes("unittest discover -s tests/integration")
      && testedBy.startsWith("packages/sketchforge-py/tests/integration/");
  }
  if (ciCommand === "npm run docs:verify") {
    return packageManifest.scripts?.["docs:verify"]?.includes(testedBy)
      && workflows.some((workflow) => workflow.includes("npm run docs:verify"));
  }
  return false;
}

function reportChangedSourceOwners(baseRef, ownerPages, failures) {
  let changedPaths;
  try {
    changedPaths = execFileSync("git", ["diff", "--name-only", "-z", "--diff-filter=ACDMRT", `${baseRef}...HEAD`], {
      cwd: root,
      encoding: "utf8",
    }).split("\0").filter(Boolean);
  } catch (error) {
    failures.push(`cannot compare documentation source changes against ${baseRef}: ${error.message}`);
    return;
  }

  for (const changedPath of changedPaths.filter((file) => publicSourceScopes.some((scope) => sourcePatternMatches(scope, file)))) {
    const owners = ownerPages.filter((page) => page.sources.some((pattern) => sourcePatternMatches(pattern, changedPath)));
    if (owners.length === 0) {
      failures.push(`${changedPath}: changed public source has no owning page; add a matching \`sources\` entry to page frontmatter`);
      continue;
    }
    console.log(`Changed source owner: ${changedPath} -> ${owners.map((owner) => `${owner.slug} (${owner.path})`).join(", ")}`);
  }
}
