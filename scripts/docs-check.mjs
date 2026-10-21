import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const rootArgumentIndex = process.argv.indexOf("--root");
const rootArgument = rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : undefined;
if (rootArgumentIndex >= 0 && !rootArgument) throw new Error("--root requires a value");
const root = rootArgument ? path.resolve(rootArgument) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);
const sources = [...new Set([...tracked, "README.md", "docs/index.md"])];
const failures = [];
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
