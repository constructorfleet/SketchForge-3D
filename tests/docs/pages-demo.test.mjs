import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = await readFile(path.join(root, ".github/workflows/docs.yml"), "utf8");
const config = await readFile(path.join(root, "apps/web/next.config.ts"), "utf8");
const verifier = await readFile(path.join(root, "scripts/verify-static-worker-assets.mjs"), "utf8");
const sketchWorker = await readFile(path.join(root, "apps/web/src/workers/sketchCad.worker.ts"), "utf8");
const readme = await readFile(path.join(root, "README.md"), "utf8");
const docsConfig = await readFile(path.join(root, "docs/.vitepress/config.mts"), "utf8");

test("Pages workflow builds and stages the editor at the Demo subpath", () => {
  assert.match(workflow, /STATIC_EXPORT_BASE_PATH:\s*\/\$\{\{\s*github\.event\.repository\.name\s*\}\}\/Demo/);
  assert.match(workflow, /npm run export/);
  assert.match(workflow, /apps\/web\/.next-export\/\.\s+docs-site-dist\/Demo\//);
  assert.match(workflow, /scripts\/verify-pages-demo-artifact\.mjs/);
  assert.match(workflow, /tests\/browser\/github-pages-demo\.test\.mjs/);
  const pagesArtifactUpload = workflow.match(/uses: actions\/upload-pages-artifact@[a-f0-9]{40}/)?.index ?? -1;
  assert.ok(workflow.indexOf("docs-site-dist/Demo") < pagesArtifactUpload);
});

test("static export config and worker verifier honor the configured subpath", () => {
  assert.match(config, /resolveStaticExportBasePath/);
  assert.match(config, /STATIC_EXPORT_BASE_PATH/);
  assert.match(config, /basePath/);
  assert.match(verifier, /STATIC_EXPORT_BASE_PATH/);
  assert.match(verifier, /occt-wasm\.js/);
  assert.match(verifier, /occt-wasm\.wasm/);
  assert.match(sketchWorker, /publicAssetPath\("\/occt\/occt-wasm\.js"\)/);
  assert.match(sketchWorker, /publicAssetPath\("\/occt\/occt-wasm\.wasm"\)/);
  assert.doesNotMatch(verifier, /does not use the root-relative \/_next\//);
});

test("README and docs navigation link to the GitHub Pages demo", () => {
  assert.match(readme, /https:\/\/constructorfleet\.github\.io\/SketchForge-3D\/Demo\//);
  assert.match(docsConfig, /text: "Demo", link: "\/Demo\/"/);
});
