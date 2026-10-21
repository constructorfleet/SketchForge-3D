import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const output = path.resolve("docs-site-dist");
const compatibilityPages = [
  ["docs/rest-api.html", "/docs/REST_API", "docs_rest-api.md."],
  ["docs/skf-project-format.html", "/docs/SKF_PROJECT_FORMAT", "docs_skf-project-format.md."],
  ["docs/publishing-clients.html", "/docs/PUBLISHING_CLIENTS", "docs_publishing-clients.md."],
  ["docs/shape-request-reference.html", "/docs/SHAPE_REQUEST_REFERENCE", "docs_shape-request-reference.md."],
];

test("legacy lowercase documentation paths redirect to canonical pages with a fallback link", () => {
  for (const [relativePage, canonicalPath, pageBundlePrefix] of compatibilityPages) {
    const pagePath = path.join(output, relativePage);
    assert.ok(existsSync(pagePath), `compatibility page ${relativePage} should be published`);
    const html = readFileSync(pagePath, "utf8");
    assert.match(html, /Continue to the current documentation/i,
      `${relativePage} should provide a usable fallback link`);
    assert.match(html, new RegExp(canonicalPath.replaceAll("/", "\\/")),
      `${relativePage} should link to its canonical destination`);

    const bundleName = html.match(new RegExp(`href="([^"]*${pageBundlePrefix}[^\"]+\\.js)"`))?.[1];
    assert.ok(bundleName, `${relativePage} should load its page-specific redirect`);
    const bundlePath = bundleName.split("/assets/").at(-1).replace(".lean.js", ".js");
    const bundle = readFileSync(path.join(output, "assets", bundlePath), "utf8");
    assert.match(bundle, /location\.replace/, `${relativePage} should redirect automatically`);
    assert.ok(bundle.includes(canonicalPath), `${relativePage} should redirect to ${canonicalPath}`);
  }
});
