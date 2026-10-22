import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
const pageSlugs = new Map();
const ownerPages = [];
// Only public API/package source trees are required to map to documentation pages.
const publicSourceScopes = [
  "apps/web/src/app/api/v1/**",
  "packages/sketchforge-client/src/**",
  "packages/sketchforge-client/mcp/**",
  "packages/sketchforge-engine/src/**",
  "packages/sketchforge-py/src/**",
];
const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;

for (const sourceRelative of sources) {
  const sourcePath = path.join(root, sourceRelative);
  let contents;
  try {
    contents = await readFile(sourcePath, "utf8");
  } catch {
    failures.push(`${sourceRelative}: canonical Markdown source is missing`);
    continue;
  }

  if ((sourceRelative.startsWith("docs/") || sourceRelative.startsWith(".docs-site/docs/reference/")) && sourceRelative.endsWith(".md")) {
    const metadata = validatePageOwnership(sourceRelative, contents, failures, pageSlugs, trackedFiles);
    if (metadata) ownerPages.push({ path: sourceRelative, slug: metadata.slug, title: metadata.title, sources: metadata.sources });
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

if (baseRef) reportChangedSourceOwners(baseRef, ownerPages, failures);

if (failures.length) {
  console.error(`Documentation checks failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${sources.length} canonical Markdown sources, local links, and includes.`);
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
