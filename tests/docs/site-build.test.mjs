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
    assert.equal(existsSync(path.join(output, filename.replace(/\.html$/, ".md"))), false,
      `${filename} must publish as rendered HTML rather than a Markdown source file`);
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

test("documentation status records durable capabilities and outstanding requirements", () => {
  const spec = readFileSync(new URL("../../docs/DOCUMENTATION_SUITE_SPEC.md", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../docs/site-migration.md", import.meta.url), "utf8");
  const capabilities = readFileSync(new URL("../../docs/UNEXPLORED_KERNEL_CAPABILITIES.md", import.meta.url), "utf8");
  const changelog = readFileSync(new URL("../../docs/CHANGELOG.md", import.meta.url), "utf8");

  assert.match(spec, /Current implementation status/i);
  assert.match(spec, /32 operations; generated OpenAPI describes 28 and explains why 4 remain omitted/i);
  assert.match(spec, /`PATCH \/api\/v1\/shapes` can rebuild a persisted sketch sweep from an updated profile/i);
  assert.match(spec, /`PATCH \/api\/v1\/shapes` can store or clear one `faceDraft` on an exact retained sketch extrusion, single-solid sketch sweep, or plain single-region full-turn sketch revolve/i);
  assert.match(spec, /`GET \/faces\?topology=exact` lists analytic B-rep revolve faces/i);
  assert.match(spec, /Source-profile edits replay the draft only when exactly one planar face matches the saved source normal/i);
  assert.match(capabilities, /profile rebuild\s+receives fresh face IDs and drops face colors[\s\S]*?symmetric 45° chamfer is replayed[\s\S]*?unsupported or\s+ambiguous treatment histories fail the edit atomically/i);
  assert.match(spec, /missing or ambiguous matches fail atomically/i);
  assert.match(spec, /a single-loop sketch extrusion accepts one all-edge fillet or symmetric 45° all-edge chamfer/i);
  assert.match(spec, /Changing only the face-draft angle on a treated single-loop sketch extrusion replays source, draft, then treatment\s+atomically/i);
  assert.match(spec, /Changing only the pull axis while a treatment is retained on a single-loop sketch extrusion replays source, draft, then treatment atomically/i);
  assert.match(spec, /a single-section, hole-free sketch sweep accepts one all-edge fillet or symmetric 45° all-edge chamfer/i);
  assert.match(spec, /Changing only the face-draft angle on such a treated sweep replays source, draft, then treatment atomically/i);
  assert.match(spec, /Relevant coverage includes `tests\/unit\/faceDraftSweepFilletRecompute\.test\.ts`, `tests\/unit\/faceDraftExtrusionFilletRecompute\.test\.ts`/i);
  assert.match(capabilities, /Changing only its pull\s+axis while treated replays source, draft, then treatment atomically/i);
  assert.match(capabilities, /Changing only the retained\s+face-draft angle on that treated sweep replays source, draft, then treatment\s+atomically/i);
  assert.match(capabilities, /Adding a second treatment, a prism\s+draft, or a shell to a face-drafted shape remains refused before writing/i);
  assert.match(spec, /A retained prism draft on a sketch extrusion can be followed by one all-edge fillet or symmetric 45° chamfer[\s\S]*?adding a prism draft after a treatment remains refused/i);
  assert.match(changelog, /adding a prism draft after a treatment[\s\S]*?draft\/treatment combinations outside the retained prism-draft-first single-treatment path remain unsupported/i);
  assert.match(changelog, /retained face draft on a single-section, hole-free sketch sweep can now[\s\S]*?change its angle[\s\S]*?treatment atomically/i);
  assert.match(spec, /does not establish general topology lineage/i);
  assert.match(spec, /editor's arbitrary-shape face-draft workflow remains baked/i);
  assert.match(spec, /OpenAPI baseline (?:is|remains) 28 of 32 operations; the four omitted operations are `OPTIONS` preflights/i);
  assert.match(spec, /Seven generators write tracked output/i);
  assert.match(spec, /`docs\/openapi-v1\.json` is linked directly from `docs\/REST_API\.md`/i);
  assert.match(spec, /Pull-request docs CI runs `docs:generate` before generated-output verification and the site build/i);
  assert.match(spec, /trusted `workflow_run` handler treats that artifact as untrusted input and validates the source run, PR, artifact manifest, and allowlist/i);
  assert.match(spec, /Fork PRs and workflow-control changes retain the generated artifact as a fallback/i);
  assert.match(spec, /create a repair PR when a successful default-branch docs run finds stale tracked output/i);
  assert.match(spec, /output drift alone does not fail CI/i);
  assert.match(spec, /Broader task-oriented workflows, complete REST contracts/i);
  assert.match(spec, /Publishing-client version — closed/i);
  assert.match(spec, /Cross-links between documentation and references — closed/i);
  assert.match(spec, /Engine package documentation — closed/i);
  assert.match(spec, /The npm README and generated engine reference[\s\S]*Node\.js 24/i);
  assert.doesNotMatch(spec, /PR \[#216\]/i);
  assert.match(spec, /external failures do\s+not fail the required local docs check or site build/i);
  assert.match(spec, /drift alone does not fail the docs build/i);
  assert.match(spec, /28 of 32 operations have runtime-backed request\/response contracts/i);
  assert.match(spec, /Stable ownership metadata is enforced for all maintained `docs\/\*\*\/\*\.md` pages/i);
  assert.match(spec, /Changed-source-to-page diagnostics are implemented for the REST route tree, the REST guide's included `docs\/examples\/rest-hole-plate\.mjs` fixture, TypeScript client source and MCP trees, engine source, and Python client source/i);
  assert.match(spec, /selected editor sources now include `apps\/web\/src\/components\/SketchForgeEditor\.tsx`, `apps\/web\/src\/components\/SketchWorkspace\.tsx`, and `apps\/web\/src\/lib\/sketchConstraints\.ts`; the editor component maps to both edit-and-export and sketch-constraints guides/i);
  assert.match(spec, /face-drafting guide[’']s browser acceptance covers one supported inspector case: face 1, local \+Z pull axis, and -5°; it captures a screenshot/i);
  assert.match(spec, /Other face-drafting combinations and most task-oriented editor workflows remain untested/i);
  assert.match(spec, /current baseline is 28 of 32 operations with runtime-backed request\/response contracts in generated OpenAPI; the four omitted operations are `OPTIONS` preflights/i);
  assert.match(spec, /End-to-end coverage from every changed source to its owning page and tested example remains open/i);
  assert.doesNotMatch(spec, /Page ownership metadata and source-to-owning-page diagnostics remain incomplete/i);
  assert.match(spec, /Desktop configuration ownership is met for `SKETCHFORGE_DESKTOP_PORT`, which has a registry row, implementation source, and owner page/i);
  assert.match(spec, /`SKETCHFORGE_DESKTOP_DEV_URL`.*internal handoff.*`NODE_PATH`.*pass-through/i);
  assert.match(spec, /Additional runtime schemas and route response validations remain outstanding/i);
  assert.match(spec, /`POST \/mirrors` validates normalized target IDs, principal-axis selection, successful shape summaries, and its reachable error responses/i);
  assert.match(spec, /`POST \/api\/v1\/patterns` contracts normalized IDs, defaults, count limits, finite numeric options, a 201 shape-summary response, and reachable errors/i);
  assert.match(spec, /creates or refreshes a bot repair PR if tracked outputs differ/i);
  assert.doesNotMatch(spec, /Open PR \[#209\]|Open PR \[#214\]/i);
  assert.match(spec, /Generated Markdown may remain tracked/i);
  assert.match(spec, /edit-and-export guide has browser acceptance/i);
  assert.match(spec, /The face-drafting guide has browser acceptance for one supported inspector case/i);
  assert.match(spec, /sketch-constraints guide has browser acceptance for Parallel and Perpendicular workflows/i);
  assert.match(spec, /`tests\/browser\/sketch-parallel-constraint\.test\.mjs`.*`docs\/screenshots\/sketch-parallel-constraint\.png`/i);
  assert.match(spec, /`docs\/screenshots\/sketch-perpendicular-constraint\.png`.*distorted corner.*90°/i);
  assert.match(spec, /These two cases do not establish full sketch-constraint or task-workflow coverage/i);
  assert.match(spec, /Task-oriented coverage and source\/example ownership — open/i);
  assert.match(spec, /End-to-end coverage from every changed source to its owning page and tested example remains open/i);

  assert.match(migration, /28 operations have runtime-backed request and\s+response contracts and appear in generated OpenAPI\. The other 4 are listed as\s+`OPTIONS` preflights/i);
  assert.match(migration, /desktop entry includes `SKETCHFORGE_DESKTOP_PORT`/i);
  assert.match(migration, /does not treat\s+every environment read as a supported setting/i);
  assert.match(migration, /required\s+audience\/owner metadata/i);
  assert.match(migration, /all maintained[\s\S]*?`docs\/\*\*\/\*\.md` pages[\s\S]*?staged generated package references[\s\S]*?audience\/owner metadata/i);
  assert.match(migration, /23 supported-language\s+runnable fences[\s\S]*?exact tracked source[\s\S]*?named test\s+and CI command[\s\S]*?concrete reasoned exemption/i);
  assert.match(migration, /Exemptions do not\s+establish execution coverage[\s\S]*?other fence languages[\s\S]*?not covered/i);
  assert.doesNotMatch(migration, /Remaining work is to require every runnable example to come from source and\s+execute in CI; add\s+consistent page audience\/owner metadata/i);
  assert.match(migration, /Changed-source ownership diagnostics cover selected source trees/i);
  assert.match(migration, /mapping\s+is path-based and is not symbol-level or complete/i);
  assert.match(migration, /The OpenAPI JSON is linked directly from\s+`docs\/REST_API\.md`/i);
  assert.match(migration, /On pull requests, docs CI generates references before\s+verification and site build/i);
  assert.match(migration, /trusted\s+default-branch follow-up validates the artifact and PR before committing only\s+allowlisted updates to same-repository PR branches/i);
  assert.match(migration, /Fork PRs use\s+the generated artifact fallback because their branches cannot be pushed/i);
  assert.match(migration, /Main remains\s+stale only until that repair PR is merged/i);
  assert.match(migration, /historical inbound-link inventory/i);
  assert.match(migration, /broader task-oriented guides and corresponding\s+workflow checks\s+remain incomplete/i);
  assert.match(migration, /browser acceptance covers the editor quick-start and the edit-and-export\s+guide[’']s create, edit, save, reload, and export workflow/i);
  assert.match(migration, /face-drafting\s+guide covers one inspector case.*face 1.*local \+Z.*-5°.*screenshot/i);
  assert.match(migration, /sketch-constraints guide covers Parallel and Perpendicular\s+workflows with screenshots/i);
  assert.match(migration, /sketch-constraints guide maps the selected editor sources[\s\S]*?`SketchWorkspace\.tsx`[\s\S]*?`sketchConstraints\.ts`[\s\S]*?also maps to the edit-and-export guide/i);
  assert.match(migration, /Other\s+editor\/UI sources, other examples, and all\s+content sources remain open for\s+ownership diagnostics/i);
  assert.match(spec, /Phase 4:[\s\S]*?Parallel and Perpendicular constraint workflows.*Broader task-oriented guides and corresponding workflow checks remain outstanding/i);

  assert.match(capabilities, /Dependency-ordered parametric recomputation/i);
  assert.match(capabilities, /retains one editable face draft[\s\S]{0,120}plain single-region full-turn sketch revolve/i);
  assert.match(capabilities, /Changing only its pull\s+axis while treated replays source, draft, then treatment atomically/i);
  assert.match(capabilities, /Changing only the retained\s+face-draft angle on that treated sweep replays source, draft, then treatment\s+atomically/i);
  assert.match(capabilities, /Adding a second treatment, a prism\s+draft, or a shell to a face-drafted shape remains refused before writing/i);
  assert.match(capabilities, /one all-edge fillet or symmetric 45°\s+chamfer is now\s+supported on a sketch extrusion[\s\S]*?Adding a prism draft after a treatment/i);
  assert.match(capabilities, /Broader and editable drafting/i);
  assert.match(capabilities, /Editable STEP assembly hierarchy and robust component association/i);
  assert.match(capabilities, /Stable face identity across arbitrary topology changes/i);
  assert.match(capabilities, /Broader sketch constraints and globally determined solutions/i);
  assert.match(capabilities, /source-sketch nodes and feature inputs for sketch extrusions,\s+revolves, sweeps, and boolean groups/i);
  assert.match(capabilities, /`PATCH \/shapes` can target a sketch sweep by\s+its persisted `sketchSourceId`/i);
  assert.match(capabilities, /`sketchProfile`[\s\S]*?`PATCH \/api\/v1\/shapes`[\s\S]*?retaining shape and source IDs/i);
  assert.match(capabilities, /rebuilds nested editable project groups when every exact\s+solid maps unambiguously to a source occurrence/i);
  assert.match(capabilities, /editing a\s+sketch-backed extrusion or sweep[\s\S]*?boolean ancestors bottom-up[\s\S]*?do\s+not yet participate in a general recompute graph/i);
  assert.match(capabilities, /uniquely\s+occurring cones, spheres, tori, and cylinders[\s\S]*?sampled normal changes/i);
  assert.match(capabilities, /coincident, horizontal, vertical, perpendicular, parallel, fixed-distance,\s+and\s+fixed-point sketch constraints/i);
  assert.match(capabilities, /bounded deterministic\s+least-squares solve/i);
  assert.match(capabilities, /report unsatisfied constraint IDs/i);
  assert.match(capabilities, /does not guarantee global solvability/i);
  assert.match(capabilities, /selector for all six signed local CAD pull axes/i);

  const statusDocs = `${spec}\n${migration}\n${capabilities}`;
  assert.doesNotMatch(statusDocs, /Open PR #\d+|Merged PR #\d+|origin\/main at `?[0-9a-f]{7,}/i);
  assert.doesNotMatch(spec, /seven operations|still lacks REST sweep profile rebuild|release PR #184/i);
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
    assert.ok(diagram.labels.some((label) => /workflow_run/.test(label)), "diagram labels come from the committed fence");
    assert.deepEqual(diagram.clipped, [], "node labels must fit inside their nodes rather than overflowing the border");
  } finally {
    await browser.close();
    server.close();
  }
});
