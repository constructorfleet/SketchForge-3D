import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { test } from "node:test";

const siteRoot = resolve("docs-site-dist");
const basePath = process.env.STATIC_EXPORT_BASE_PATH ?? "/SketchForge-3D/Demo";
const pagesRoot = basePath.slice(0, -"/Demo".length);
const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

test("static editor demo loads and keeps editor navigation under the Pages subpath", async (context) => {
  await access(resolve(siteRoot, "Demo/index.html"));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const route = decodeURIComponent(url.pathname);
      if (!route.startsWith(pagesRoot)) throw new Error("request is outside the Pages path");
      let relative = route.slice(pagesRoot.length);
      if (!relative || relative.endsWith("/")) relative += "index.html";
      const file = resolve(siteRoot, `.${relative}`);
      if (!file.startsWith(`${siteRoot}${sep}`)) throw new Error("request is outside the site artifact");
      const contents = await readFile(file);
      response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" });
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  context.after(() => browser.close());
  const page = await browser.newPage();
  const failedRequests = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`http://127.0.0.1:${address.port}${basePath}/`, { waitUntil: "domcontentloaded" });
  const brokenImages = await page.locator("img").evaluateAll((images) =>
    images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src));
  assert.deepEqual(brokenImages, [], "public images should load from the Demo subdirectory");

  await page.getByRole("button", { name: "Create new 3D design" }).click();
  await page.waitForURL((url) => url.pathname === `${basePath}/` && url.searchParams.get("editor") === "1");
  await page.locator("canvas").first().waitFor({ state: "visible" });
  assert.deepEqual(failedRequests, [], "the editor should not request assets above the Demo subpath");
});
