import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { chromium } from "playwright";
import path from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);
const require = createRequire(import.meta.url);
const packageVersion = require("../../package.json").version;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootPath, encoding: "utf8" }).trim();

test("built docs emit the project-site shell, imported README, and local search", () => {
  const indexPath = new URL("../../docs-site-dist/index.html", import.meta.url);
  assert.ok(existsSync(indexPath), "VitePress output should include index.html");
  const html = readFileSync(indexPath, "utf8");
  assert.match(html, /href="\/SketchForge-3D\/assets\//);
  assert.match(html, /name="description"/);
  assert.doesNotMatch(html, /sketchforge3d\.com\/assets\//, "site shell should not fetch README imagery remotely");
  assert.ok(html.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/LICENSE`));
  assert.doesNotMatch(html, /href="LICENSE"/, "repository-relative HTML links should not become broken site links");

  const output = path.join(rootPath, "docs-site-dist");
  const files = walk(output);
  const searchFiles = files.filter((file) => file.endsWith(".json") || file.endsWith(".js"));
  const search = searchFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.match(search, /SketchForge/);
  assert.match(search, /REST API/);
  assert.match(search, /search/i, "built-in client search code should be present");
  assert.match(html, /docs\/packages\/typescript-client/, "package guides should be reachable from site navigation");
  assert.match(html, /docs\/reference\/typescript-client/, "generated API references should be reachable from site navigation");
  assert.match(html, /docs\/CLI_REFERENCE/, "published CLI reference should be reachable from site navigation");
  assert.match(html, /docs\/SKF_FORMAT_REFERENCE/, ".skf reference should be reachable from site navigation");
  assert.match(html, /docs\/OPERATOR_CONFIGURATION/, "operator configuration reference should be reachable from site navigation");
  assert.match(html, /docs\/mcp\/TOOLS_REFERENCE/, "MCP tool reference should be reachable from site navigation");
  const openapiPath = path.join(output, "openapi-v1.json");
  assert.ok(existsSync(openapiPath), "the generated OpenAPI document should be published as a downloadable asset");
  assert.deepEqual(JSON.parse(readFileSync(openapiPath, "utf8")), JSON.parse(readFileSync(path.join(rootPath, "docs/openapi-v1.json"), "utf8")));
  const restApi = readFileSync(path.join(output, "docs/REST_API.html"), "utf8");
  assert.match(restApi, /href="\/SketchForge-3D\/openapi-v1\.json"/, "the REST reference should link to the OpenAPI download under the project-site prefix");
});

test("Pages artifact contains generated TypeScript and Python package references", () => {
  const output = path.join(rootPath, "docs-site-dist/docs/reference");
  const references = [
    ["typescript-client.html", /TypeScript client API/, /SketchForgeClient/],
    ["typescript-engine.html", /Engine API/, /createEngine/],
    ["python-client.html", /Python client API/, /SketchForgeClient/],
  ];

  for (const [filename, title, symbol] of references) {
    const pagePath = path.join(output, filename);
    assert.ok(existsSync(pagePath), `${filename} must be included in the Pages artifact`);
    const html = readFileSync(pagePath, "utf8");
    assert.match(html, title, `${filename} should render its generated package title`);
    assert.match(html, symbol, `${filename} should expose an expected current package symbol`);
  }
});

test("built pages identify their release and link to source at the represented revision", () => {
  const output = path.join(rootPath, "docs-site-dist");
  const home = readFileSync(path.join(output, "index.html"), "utf8");
  const packageGuide = readFileSync(path.join(output, "docs/packages/typescript-client.html"), "utf8");
  const builtPages = walk(output)
    .filter((file) => file.endsWith(".html") && path.basename(file) !== "404.html")
    .map((file) => readFileSync(file, "utf8"));

  assert.ok(builtPages.length > 1, "the smoke test should cover the rendered site pages");
  for (const html of builtPages) {
    assert.match(html, new RegExp(`Documentation version: <code>${packageVersion}</code>`));
    assert.match(html, new RegExp(`Repository revision: <a[^>]*><code>${revision}</code></a>`));
    assert.ok(html.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/`),
      "each page should include a source link pinned to the represented revision");
    assert.doesNotMatch(html, /fetch\([^)]*(?:version|revision|provenance)/i,
      "provenance should be rendered into static HTML, not fetched at runtime");
  }
  assert.ok(home.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/README.md`),
    "the landing page should link to the README revision it was built from");
  assert.ok(packageGuide.includes(`https://github.com/constructorfleet/SketchForge-3D/blob/${revision}/docs/packages/typescript-client.md`),
    "the package guide should link to its exact source revision");
});

test("documentation suite status distinguishes merged work from open PRs", () => {
  const spec = readFileSync(new URL("../../docs/DOCUMENTATION_SUITE_SPEC.md", import.meta.url), "utf8");
  const changelog = readFileSync(new URL("../../docs/CHANGELOG.md", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../docs/site-migration.md", import.meta.url), "utf8");
  const capabilities = readFileSync(new URL("../../docs/UNEXPLORED_KERNEL_CAPABILITIES.md", import.meta.url), "utf8");

  assert.match(spec, /first GitHub Pages deployment after PR #116 merged succeeded/i);
  assert.match(spec, /verified against `origin\/main` at `1c8e820` and live PR state/i);
  assert.match(spec, /runtime-backed `GET \/faces` contract \(#151\)/i);
  assert.match(spec, /PR #162 merged Mermaid fence rendering/i);
  assert.match(spec, /Open PR #168.*revolve source persistence \(#181\).*STEP component ancestry \(#183\).*not on `main`/i);
  assert.match(spec, /Open PR #187.*historical inbound-link inventory/i);
  assert.match(spec, /Open PR #188 proposes persisted source-sketch nodes and editor rebuild identity for sweeps; the REST API still cannot update a sweep profile and rebuild it/i);
  assert.match(spec, /Open PR #182 proposes runtime-backed contracts.*9 of 32 registered operations/i);
  assert.match(spec, /Publishing clients version row — closed by #156 and #167/i);
  assert.match(spec, /Cross-links between documentation and references — closed by #157/i);
  assert.match(spec, /Engine npm listing and generated reference — closed by #158/i);
  assert.match(spec, /Remote failures are advisory; internal broken links stay blocking/i);
  assert.match(spec, /REST reference authoritative for the whole API/i);
  assert.match(spec, /Main currently covers seven operations and records 25 of 32 registered operations as omitted/i);
  assert.match(capabilities, /shipped capabilities verified against `origin\/main` at `1c8e820`/i);
  assert.match(capabilities, /bounded deterministic\s+least-squares solve/i);
  assert.match(capabilities, /report unsatisfied constraint IDs/i);
  assert.match(capabilities, /does not guarantee global solvability/i);
  assert.match(capabilities, /shape-parameter edits and supported CAD\s+treatments when faces can be matched uniquely/i);
  assert.match(capabilities, /new or ambiguous faces get\s+fresh IDs and do not inherit colors/i);
  assert.match(capabilities, /separate source-sketch node and explicit feature input for\s+sketch extrusions/i);
  assert.match(capabilities, /Open PR #181[\s\S]*?proposes the equivalent source and edit\/rebuild slice for revolves/i);
  assert.match(capabilities, /Open PR #188[\s\S]*?proposes a persisted sweep source node and feature input/i);
  assert.match(capabilities, /The REST API can\s+create and read sweeps but still has no operation to update a sweep profile and\s+rebuild it/i);
  assert.match(capabilities, /STEP imports can expose bounded product names and nested `stepAssembly`\s+hierarchy metadata/i);
  assert.match(capabilities, /`POST \/explode` creates independently\s+selectable and movable top-level shapes/i);
  assert.match(capabilities, /PR #183[\s\S]*?`stepComponent` metadata[\s\S]*?not merged to `main`/i);
  assert.match(capabilities, /PR #180 also verifies face 0 at ±30° along \+X.*face 2 at \+10° along \+Y/is);
  assert.match(capabilities, /selectable local CAD pull axis/i);
  assert.doesNotMatch(spec, /before the first deployment|first published deployment.*not verified|Pages publishing source.*not changed/i);

  assert.match(changelog, /first GitHub Pages deployment after PR #116\s+merged succeeded/i);
  assert.match(changelog, /Merged PR #118/i);
  assert.match(changelog, /Merged PRs #120 and #125/i);
  assert.match(changelog, /Merged PR #121/i);
  assert.match(changelog, /Merged PR #123/i);
  assert.match(changelog, /Merged PR #119 clarifies STEP color fallback/i);
  assert.match(changelog, /MCP tool schema reference/i);
  assert.match(changelog, /Merged PR #122/i);
  assert.match(changelog, /PR #126 added version, revision, and pinned source links/i);
  assert.match(changelog, /Merged PR #128 wired/i);
  assert.match(changelog, /Merged PR #116/i);
  assert.match(changelog, /Merged PR #117/i);
  assert.doesNotMatch(changelog, /before the first deployment|must select GitHub Actions as the publishing source/i);

  assert.match(migration, /first GitHub Pages deployment after PR #116\s+merged succeeded/i);
  assert.match(migration, /package references and executable examples merged in PR #118/i);
  assert.match(migration, /`GET \/faces` and `PATCH \/shapes` stable face color\s+contracts merged in PRs #120 and #125/i);
  assert.match(migration, /operator configuration \(#121\), `\.skf` format \(#123\), and MCP schema\/navigation\s+\(#122\) references have merged/i);
  assert.match(migration, /STEP color guidance merged in PR #119/i);
  assert.match(migration, /deterministic reference-generator\s+checks merged in PR #128/i);
  assert.match(migration, /site version\/revision stamps and pinned source links merged in\s+PR #126/i);
  assert.match(migration, /PR #144 added generated OpenAPI for\s+six schema-backed CRUD operations/i);
  assert.match(migration, /Merged PR #151 adds runtime-backed `GET \/faces` query and response coverage/i);
  assert.match(migration, /STEP component-color\s+import support merged in PR #147/i);
  assert.match(migration, /face identity parity \(#145\) have merged/i);
  assert.match(migration, /browser smoke checks merged in PR #141/i);
  assert.match(migration, /external-link report merged in PR #143/i);
  assert.match(spec, /editor quick-start \(#150\).*merged/i);
  assert.match(migration, /tested editor quick-start from first\s+sketch through save\/export merged in PR #150/i);
  assert.match(migration, /Merged PR #156 resolves the publishing-clients version gap/i);
  assert.match(migration, /Merged PR #157 adds useful contextual links/i);
  assert.match(migration, /Merged PR #158 expands the engine package README and generated TypeScript/i);
  assert.match(migration, /Open PR #187 proposes an inventory of repository-controlled historical\s+inbound documentation paths/i);
  assert.match(migration, /Open PR #188 proposes persisted sweep source\s+sketches; REST profile update and rebuild remain unsupported/i);
  assert.match(migration, /PR #162 merged Mermaid fence rendering and CI checks/i);
  assert.match(migration, /broader task guides remain outstanding/i);
  assert.doesNotMatch(migration, /still needs to be set|before the first deployment|could not be confirmed/i);
});

test("built docs support accessible keyboard navigation and a narrow viewport", async () => {
  const output = path.join(rootPath, "docs-site-dist");
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = pathname.replace(/^\/SketchForge-3D\/?/, "") || "index.html";
    const requested = path.resolve(output, relativePath);
    if (!requested.startsWith(`${output}${path.sep}`) && requested !== path.join(output, "index.html")) {
      response.writeHead(403).end();
      return;
    }
    const file = requested.endsWith(path.sep) ? path.join(requested, "index.html") : requested;
    try {
      const content = readFileSync(file);
      const extension = path.extname(file);
      const contentType = ({ ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" })[extension] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType }).end(content);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/SketchForge-3D/`);

    assert.equal(await page.getByRole("main").count(), 1, "built page has a main landmark");
    assert.equal(await page.locator("h1").count(), 1, "built landing page has one top-level heading");
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    assert.match(await focused.innerText(), /skip to content/i, "first keyboard stop skips to page content");
    assert.equal(await focused.evaluate((element) => element.getAttribute("href")), "#VPContent");
    assert.notEqual(await focused.evaluate((element) => getComputedStyle(element).outlineStyle), "none", "keyboard focus is visible");

    const menuButton = page.getByRole("button", { name: /navigation/i });
    assert.equal(await menuButton.count(), 1, "mobile navigation toggle is available");
    for (let tab = 0; tab < 10 && !(await menuButton.evaluate((button) => button === document.activeElement)); tab += 1) {
      await page.keyboard.press("Tab");
    }
    assert.equal(await menuButton.evaluate((button) => button === document.activeElement), true, "keyboard reaches the mobile navigation toggle");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".VPNavBarHamburger")?.getAttribute("aria-expanded") === "true");
    assert.equal(await page.locator("#VPNavScreen").isVisible(), true, "keyboard opens the mobile navigation");
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#VPNavScreen")).opacity === "1");
    assert.equal(await page.getByRole("navigation").count(), 1, "mobile menu exposes a navigation landmark");
    const screenshotDirectory = path.join(rootPath, "output/playwright");
    mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDirectory, "docs-site-mobile-keyboard-smoke.png") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".VPNavBarHamburger")?.getAttribute("aria-expanded") === "false");
    await page.locator("#VPNavScreen").waitFor({ state: "hidden" });

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "390px viewport has no horizontal overflow");
    await page.keyboard.press("Control+k");
    const search = page.getByRole("searchbox");
    await search.fill("REST API");
    await page.getByRole("option").first().waitFor();
    assert.match(await page.getByRole("option").first().innerText(), /REST API/i, "built search returns the queried documentation");
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("representative built pages pass accessibility rules, reduced-motion, and 400% reflow checks", async () => {
  const output = path.join(rootPath, "docs-site-dist");
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = pathname.replace(/^\/SketchForge-3D\/?/, "") || "index.html";
    const requested = path.resolve(output, relativePath);
    if (!requested.startsWith(`${output}${path.sep}`) && requested !== path.join(output, "index.html")) {
      response.writeHead(403).end();
      return;
    }
    const file = requested.endsWith(path.sep) ? path.join(requested, "index.html") : requested;
    try {
      const content = readFileSync(file);
      const extension = path.extname(file);
      const contentType = ({ ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" })[extension] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType }).end(content);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pages = [
      "/SketchForge-3D/",
      "/SketchForge-3D/docs/REST_API.html",
      "/SketchForge-3D/docs/packages/python-client.html",
      "/SketchForge-3D/docs/mcp/TOOLS_REFERENCE.html",
    ];
    const violations = [];
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      for (const url of pages) {
        await page.goto(`http://127.0.0.1:${address.port}${url}`);
        assert.equal(await page.getByRole("button", { name: "Search" }).count(), 1, `${url} search control has an accessible name matching its visible text`);
        if (!(await page.evaluate(() => Boolean(window.axe)))) {
          await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
        }
        if (colorScheme === "light" && url.endsWith("/")) {
          assert.equal(await page.getByRole("img", { name: "SketchForge editor showing a selected model on the workplane" }).count(), 1,
            "landing screenshot renders as an image with its useful alternative text, not as a paragraph");
        }
        const result = await page.evaluate(async () => window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        }));
        violations.push(...result.violations.map((violation) => ({
          page: url,
          colorScheme,
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.slice(0, 8).map((node) => ({ target: node.target.join(" "), message: node.any[0]?.message ?? node.failureSummary })),
        })));

        await page.setViewportSize({ width: 320, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${url} reflows without horizontal page overflow at a 320 CSS pixel viewport (400% reflow)`);
        if (colorScheme === "light" && url.endsWith("/")) {
          mkdirSync(path.join(rootPath, "output/playwright"), { recursive: true });
          await page.screenshot({ path: path.join(rootPath, "output/playwright/docs-site-accessibility-320.png"), fullPage: true });
        }

        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true, "browser reduced-motion setting is active");
        const movingElements = await page.locator("*").evaluateAll((elements) => elements.flatMap((element) => {
          const style = getComputedStyle(element);
          return style.animationName !== "none" && style.animationDuration.split(",").some((value) => parseFloat(value) > 0)
            ? [{ tag: element.tagName, className: String(element.className), animation: style.animationName, duration: style.animationDuration }]
            : [];
        }));
        assert.deepEqual(movingElements, [], `${url} has no ongoing CSS animation with reduced motion enabled`);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    }
    assert.deepEqual(violations, [], `WCAG 2.1 A/AA axe-core violations: ${JSON.stringify(violations, null, 2)}`);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
  });
}

test("a mermaid diagram on a built page renders with labels that fit their nodes", async () => {
  const output = path.join(rootPath, "docs-site-dist");
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = pathname.replace(/^\/SketchForge-3D\/?/, "") || "index.html";
    const requested = path.resolve(output, relativePath);
    if (!requested.startsWith(`${output}${path.sep}`) && requested !== path.join(output, "index.html")) {
      response.writeHead(403).end();
      return;
    }
    const file = requested.endsWith(path.sep) ? path.join(requested, "index.html") : requested;
    try {
      const content = readFileSync(file);
      const extension = path.extname(file);
      const contentType = ({ ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" })[extension] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType }).end(content);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/SketchForge-3D/docs/DOCUMENTATION_SUITE_SPEC.html`);
    await page.waitForSelector(".mermaid svg", { timeout: 30000 });

    const diagram = await page.$eval(".mermaid svg", (svg) => ({
      nodes: svg.querySelectorAll(".node").length,
      labels: [...svg.querySelectorAll(".node")].map((node) => node.textContent.trim()),
      clipped: [...svg.querySelectorAll(".node foreignObject")]
        .map((box) => ({
          text: box.textContent.trim().slice(0, 40),
          box: Number(box.getAttribute("height")),
          content: box.firstElementChild?.scrollHeight ?? 0,
        }))
        .filter((label) => label.content > label.box),
    }));

    assert.equal(pageErrors.length, 0, `the diagram should render without page errors: ${pageErrors.join("; ")}`);
    assert.equal(diagram.nodes, 5, "the documentation pipeline diagram should render every stage");
    assert.ok(diagram.labels.some((label) => /docs:check/.test(label)), "diagram labels come from the committed fence");
    assert.deepEqual(diagram.clipped, [], "node labels must fit inside their nodes rather than overflowing the border");
  } finally {
    await browser.close();
    server.close();
  }
});
