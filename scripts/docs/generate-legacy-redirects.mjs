import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".docs-site", "docs");
const repository = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" })
  .trim().match(/(?:github\.com[:/])([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1];
if (!repository) throw new Error("Cannot derive GitHub repository for compatibility source links");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

// Preserve lower-case slugs that are commonly produced when links are copied
// from case-sensitive source paths into systems that normalize URL casing.
const compatibilityRoutes = [
  ["rest-api", "REST_API", "REST API"],
  ["skf-project-format", "SKF_PROJECT_FORMAT", ".skf project format"],
  ["publishing-clients", "PUBLISHING_CLIENTS", "publishing clients"],
  ["shape-request-reference", "SHAPE_REQUEST_REFERENCE", "shape request reference"],
];

await mkdir(output, { recursive: true });
for (const [legacySlug, canonicalSlug, label] of compatibilityRoutes) {
  const sourcePath = `docs/${canonicalSlug}.md`;
  const sourceUrl = `https://github.com/${repository}/blob/${revision}/${sourcePath}`;
  const revisionUrl = `https://github.com/${repository}/tree/${revision}`;
  const page = `---\ntitle: ${label}\n---\n\n<script setup>\nimport { onMounted } from 'vue'\nimport { withBase } from 'vitepress'\n\nconst destination = withBase('/docs/${canonicalSlug}')\nonMounted(() => window.location.replace(destination))\n</script>\n\nThis documentation page has moved.

<a :href="destination">Continue to the current documentation</a>.\n
---\n\nDocumentation version: \`${version}\` · Repository revision: [\`${revision}\`](${revisionUrl}) · [View source](${sourceUrl})\n`;

  await writeFile(path.join(output, `${legacySlug}.md`), page);
}

console.log(`Prepared ${compatibilityRoutes.length} legacy documentation compatibility routes.`);
