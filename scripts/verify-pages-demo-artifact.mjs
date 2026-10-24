import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const basePath = process.env.STATIC_EXPORT_BASE_PATH?.trim();
if (!basePath || !basePath.startsWith("/") || basePath.endsWith("/") || basePath.includes("//")) {
  throw new Error("STATIC_EXPORT_BASE_PATH must be set to a non-root URL path for the Pages demo.");
}

const demoRoot = path.join(repositoryRoot, "docs-site-dist", "Demo");
const html = await readFile(path.join(demoRoot, "index.html"), "utf8");
const assetPrefix = `${basePath}/_next/`;
if (!html.includes(assetPrefix)) {
  throw new Error(`Demo index.html does not reference its expected ${assetPrefix} assets.`);
}

const urls = [...html.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)].map((match) => match[1]);
for (const url of urls) {
  if (!url.startsWith(`${basePath}/`)) {
    throw new Error(`Demo HTML contains an unprefixed root asset URL: ${url}`);
  }

  const relativePath = url.slice(basePath.length + 1);
  await access(path.join(demoRoot, relativePath));
}

console.log(`Verified ${urls.length} prefixed demo assets under ${demoRoot}.`);
