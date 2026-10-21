import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".docs-site", "docs");

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
  const page = `---\ntitle: ${label}\n---\n\n<script setup>\nimport { onMounted } from 'vue'\nimport { withBase } from 'vitepress'\n\nconst destination = withBase('/docs/${canonicalSlug}')\nonMounted(() => window.location.replace(destination))\n</script>\n\nThis documentation page has moved.

<a :href="destination">Continue to the current documentation</a>.\n`;
  await writeFile(path.join(output, `${legacySlug}.md`), page);
}

console.log(`Prepared ${compatibilityRoutes.length} legacy documentation compatibility routes.`);
