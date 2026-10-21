import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createMarkdownRenderer } from "vitepress";

import siteConfig from "../../docs/.vitepress/config.mts";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const srcDir = path.join(root, "docs");

const DIAGRAM = ["```mermaid", "graph TD;", "  A[Specification] --> B[Implementation];", "```", ""].join("\n");

async function renderedWithSiteMarkdown(markdown) {
  const config = await siteConfig;
  const renderer = await createMarkdownRenderer(srcDir, config.markdown ?? {}, config.base);
  return renderer.render(markdown);
}

test("a mermaid fence becomes a rendered diagram rather than a code listing", async () => {
  const html = await renderedWithSiteMarkdown(DIAGRAM);

  assert.match(
    html,
    /<Mermaid/,
    "the docs site must render ```mermaid fences as diagrams, so specifications can use them instead of ASCII art",
  );
  assert.doesNotMatch(
    html,
    /language-mermaid/,
    "a mermaid fence left as a highlighted code block means the diagram never renders",
  );
});

test("the site registers the mermaid component so built pages can mount a diagram", async () => {
  const config = await siteConfig;
  const plugins = (config.vite?.plugins ?? []).flat(Infinity).filter(Boolean);
  const names = plugins.map((plugin) => plugin.name).filter(Boolean);

  assert.ok(
    names.some((name) => /mermaid/i.test(name)),
    `the Vite plugin that resolves the Mermaid component should be configured, saw: ${names.join(", ") || "none"}`,
  );
});
