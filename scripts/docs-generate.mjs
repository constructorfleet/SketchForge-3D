import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".docs-site");
const repository = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" })
  .trim().match(/(?:github\.com[:/])([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1];
if (!repository) throw new Error("Cannot derive GitHub repository for canonical source links");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const documentationVersion = packageMetadata.version;
const pagesBase = `/${repository.split("/").at(-1)}`;
const trackedMarkdown = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);
const untrackedMarkdown = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "*.md"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);
const markdownSources = [...new Set([...trackedMarkdown, ...untrackedMarkdown])];

function includeMarkdown(source, from) {
  return source.replace(/!!!include\(([^)]+)\)!!!/g, (_directive, relativePath) => {
    const includedPath = path.resolve(path.dirname(from), relativePath.trim());
    if (!includedPath.startsWith(`${root}${path.sep}`) && includedPath !== root) {
      throw new Error(`Documentation include escapes the repository: ${relativePath}`);
    }
    return includeMarkdown(readFileSync(includedPath, "utf8"), includedPath);
  });
}

// Read synchronously during recursive expansion so an include cannot turn a
// missing canonical source into an empty page.
import { readFileSync } from "node:fs";

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "docs/.vitepress"), path.join(output, ".vitepress"), { recursive: true });
await mkdir(path.join(output, "assets/sketchforge"), { recursive: true });
await cp(
  path.join(root, "apps/web/public/assets/sketchforge/sketchforge-logo-transparent.png"),
  path.join(output, "assets/sketchforge/sketchforge-logo-transparent.png"),
);
await cp(path.join(root, "docs/site-assets/favicon.svg"), path.join(output, "public/favicon.svg"));
await cp(path.join(root, "docs/openapi-v1.json"), path.join(output, "public/openapi-v1.json"));

for (const sourceRelative of markdownSources) {
  if (sourceRelative === "README.md" || sourceRelative === "docs/index.md") continue;
  const sourcePath = path.join(root, sourceRelative);
  const outputPath = path.join(output, sourceRelative);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const source = await readFile(sourcePath, "utf8");
  await writeFile(outputPath, includeMarkdown(source, sourcePath));
}

const landingSource = path.join(root, "docs/index.md");
const landing = includeMarkdown(await readFile(landingSource, "utf8"), landingSource)
  .replace(/<h1(\s[^>]*)>([\s\S]*?)<\/h1>/, "<h2$1>$2</h2>");
await writeFile(path.join(output, "index.md"), landing);

// Preserve repository-relative image and downloadable-file paths referenced by
// canonical Markdown. Markdown pages themselves are already staged above.
const markdownFiles = [path.join(output, "index.md"), ...markdownSources
  .filter((item) => item !== "README.md" && item !== "docs/index.md")
  .map((item) => path.join(output, item))];
const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
for (const generatedPath of markdownFiles) {
  let contents = await readFile(generatedPath, "utf8");
  const sourceRelative = generatedPath === path.join(output, "index.md")
    ? "README.md"
    : path.relative(output, generatedPath);
  contents = contents.replace(markdownLink, (whole, rawHref) => {
    if (whole.startsWith("!")) return whole;
    const href = rawHref.replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return whole;
    const sourceTarget = path.resolve(root, path.dirname(sourceRelative), decodeURIComponent(href.split(/[?#]/, 1)[0]));
    if (!sourceTarget.startsWith(`${root}${path.sep}`)) return whole;
    const targetRelative = path.relative(root, sourceTarget);
    if (targetRelative.startsWith(".github/") || !targetRelative.endsWith(".md")) {
      const sourceUrl = `https://github.com/${repository}/blob/${revision}/${targetRelative}`;
      return whole.replace(/\]\([^)]*\)$/, `](${sourceUrl})`);
    }
    return whole;
  });
  contents = contents.replace(/href=["']([^"']+)["']/g, (whole, href) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return whole;
    const sourceTarget = path.resolve(root, path.dirname(sourceRelative), decodeURIComponent(href.split(/[?#]/, 1)[0]));
    if (!sourceTarget.startsWith(`${root}${path.sep}`)) return whole;
    const targetRelative = path.relative(root, sourceTarget);
    if (targetRelative.startsWith(".github/") || !targetRelative.endsWith(".md")) {
      return `href="https://github.com/${repository}/blob/${revision}/${targetRelative}"`;
    }
    return whole;
  });
  contents = contents
    .replaceAll('href="/openapi-v1.json"', `href="${pagesBase}/openapi-v1.json"`)
    .replace(/!\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(
      'src="https://sketchforge3d.com/assets/sketchforge/sketchforge-logo-transparent.png"',
      'src="./assets/sketchforge/sketchforge-logo-transparent.png"',
    );
  const sourceUrl = `https://github.com/${repository}/blob/${revision}/${sourceRelative}`;
  contents += `\n\n---\n\nDocumentation version: \`${documentationVersion}\` · Repository revision: [\`${revision}\`](https://github.com/${repository}/tree/${revision}) · [View source](${sourceUrl})\n`;
  for (const match of contents.matchAll(markdownLink)) {
    const href = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) continue;
    const linkedSource = path.resolve(root, path.dirname(sourceRelative), decodeURIComponent(href.split(/[?#]/, 1)[0]));
    if (!linkedSource.startsWith(`${root}${path.sep}`) || !(await exists(linkedSource))) continue;
    if (linkedSource.endsWith(".md")) continue;
    const linkedRelative = path.relative(root, linkedSource);
    const linkedOutput = path.join(output, linkedRelative);
    await mkdir(path.dirname(linkedOutput), { recursive: true });
    await cp(linkedSource, linkedOutput, { recursive: true, force: true });
  }
  await writeFile(generatedPath, contents);
}

console.log(`Prepared ${markdownFiles.length} canonical Markdown pages in .docs-site/`);

async function exists(file) {
  try { await readFile(file); return true; } catch { return false; }
}
