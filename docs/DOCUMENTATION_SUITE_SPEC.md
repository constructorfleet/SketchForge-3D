# Documentation suite specification

**Status (2026-10-21, verified at `39ab478`):** The searchable VitePress site is deployed on GitHub Pages. Package/examples (#118), stable-face REST contracts (#120, #125), operator configuration (#121), `.skf` format (#123), MCP schemas/navigation (#122), static provenance (#126), deterministic reference-generator wiring (#128), the local MCP example (#135), stable face identity in the editor (#138), STEP color guidance (#119), release-process checks (#132), lower-case compatibility routes (#134), Python reference type checks and source links (#136), API reference sources (#139), face-based drafting (#140), and the REST measurement listing (#137) have merged. Open documentation work includes PR #141 (built-site browser smoke coverage). Full REST schemas/OpenAPI, broader end-to-end examples, and complete accessibility acceptance remain in progress. PR #141 adds the first real-browser built-site smoke checks for keyboard navigation, mobile layout, landmarks/headings, and local search.
**Scope:** Public product, developer, API, package, and operator documentation
**Hosting target:** GitHub Pages
**Canonical URL:** `https://constructorfleet.github.io/SketchForge-3D/` unless the repository is later configured with a custom domain

## Repository baseline (verified at `39ab478`, 2026-10-21)

The current default branch builds a static VitePress site under
`/SketchForge-3D/`, with local search, canonical Markdown staging, local link
and include checks, generated package/CLI/shape/configuration/format/MCP
references, deterministic reference drift checks, a local preview command,
and a GitHub Pages workflow. The first GitHub Pages deployment after PR #116 merged succeeded.
PR #134 added lower-case compatibility routes. The Pages API's initial 404
was a temporary setup blocker, not current status. The app's
`scripts/build-static.mjs` remains separate and builds SketchForge for
Cloudflare Workers. Existing built-site tests check static output and provenance. PR #141 adds a
real browser smoke test for keyboard navigation, visible focus, landmarks and
headings, mobile navigation, local search, and layout overflow at 390px.

The migration starts with useful maintained sources already in place:
`README.md`, `docs/REST_API.md`, `docs/SKF_PROJECT_FORMAT.md`,
`docs/PUBLISHING_CLIENTS.md`, `docs/TRANSLATIONS.md`,
`packages/sketchforge-client/README.md`,
`packages/sketchforge-engine/README.md`,
`packages/sketchforge-py/README.md`, and the MCP skill under
`docs/skills/sketchforge-mcp-skill/`. Preserve their inbound links and identify
which are canonical prose, package-registry readmes, or compatibility pages
before moving content. The TypeScript client, Python client, and engine are
separate packages; the published CLI entry points are declared by the client
package and Python project metadata, while root npm scripts are repository
developer commands. Do not present those root scripts as a standalone product
CLI.

| Audited gap or contradiction | Evidence and consequence for the first implementation phases |
| --- | --- |
| The initial audit found no complete REST operation contract; route behavior lived in individual `apps/web/src/app/api/v1/*/route.ts` handlers and `docs/REST_API.md` was explanatory prose and tables. | The initial route inventory and first runtime-consumed request contract merged in PR #112. Full request/response schemas and OpenAPI generation remain incomplete; do not describe the inventory as a complete contract. |
| Configuration has no central schema. Environment reads and defaults are distributed across API, storage, MCP, macro, and desktop modules. | The operator configuration reference merged in PR #121. It documents supported operator settings; it does not establish one central schema or make every `process.env` use a supported setting. |
| The version source was inconsistent in the initial audit. Root and package manifests now report `1.13.0`, while the README badge still displays `1.0.9`. | The release authority is the root/package manifests. The badge remains stale and should be reconciled; it is not an alternate version source. |
| Project-format documentation contained a camera-state contradiction. `docs/SKF_PROJECT_FORMAT.md` said camera state is preserved, then later said camera position is omitted, despite `cameraView` in the workspace model and round-trip test. | The `.skf` reference update merged in PR #123 and resolves the stale format description. |
| The public CLI surface differs from root developer scripts. `packages/sketchforge-client/package.json` declares `sketchforge-macro` and `sketchforge-mcp`; `packages/sketchforge-py/pyproject.toml` declares its `sketchforge-macro`. | `docs/CLI_REFERENCE.md` is now generated from the published entry points and actual usage/help output (merged in PR #117). Keep root npm scripts separate as contributor commands. |
| At the initial audit, GitHub Actions did not publish documentation to Pages; it built/tests the app and deployed app content to Cloudflare separately. | PR #116 added the Pages workflow and was merged; the first deployment succeeded. Pages publication is no longer an unverified or outstanding setup decision. |

The repository observations were initially audited on 2026-10-21. The status
column tracks later implementation and merge evidence; the underlying gap list
should be rechecked as the remaining phases land.

## 1. Objective

Build a public, searchable documentation site from the repository's code, package metadata, executable examples, and carefully bounded explanatory prose. Publish it as a static site on GitHub Pages. A change to a public interface or example should either update the generated documentation automatically or fail a required pull-request check when the source and documentation contract disagree.

The site must not create a second hand-maintained copy of API signatures, endpoint lists, CLI options, environment variables, shape fields, package versions, or runnable examples. Human-written explanations remain appropriate for concepts, design rationale, workflows, limitations, and troubleshooting; every factual listing that can be extracted from source must be extracted or checked against source.

VitePress 1.6.4 is the selected static-site tool and already satisfies the
project-site build and local-search requirements. The generated result must be
plain static assets and work under the GitHub Pages project-site path on a
clean build without secrets or production connectivity.

## 2. Audiences and outcomes

| Audience | They need to accomplish |
| --- | --- |
| New editor user | Install or open SketchForge, complete a first model, save it, and export it. |
| Experienced editor user | Find a workflow by task, understand supported operations and limitations, and recover from common failures. |
| API user | Configure a local/server deployment, authenticate, discover operations and schemas, and safely automate projects. |
| TypeScript or Python client user | Install the correct package, understand the client surface, and run a working macro. |
| MCP user | Configure local and remote MCP use, understand tool behavior, and see safe, tested examples. |
| Contributor | Find architecture and contribution guidance, run checks, and update documentation from its source. |
| Operator | Configure storage, tokens, deployment, backups, and supported runtime behavior. |

## 3. Information architecture

The navigation should follow user tasks and audience, not the repository's directory tree.

### Learn SketchForge

- Overview and capability map
- Quick start: open the editor, create a solid, edit it, save a project, and export a model
- Core concepts: shapes, sketches, workplanes, groups, baked operations, exact CAD data, project files, and undo/redo
- Task guides: sketch and extrude, import, modify, arrange, measure, inspect, save, and export
- Supported formats and known limitations
- Troubleshooting and common errors

### Automate SketchForge

- Automation overview and choosing REST, TypeScript, Python, or MCP
- Server setup and authentication
- REST API reference generated from the route contract
- TypeScript client reference generated from published declarations
- Python client reference generated from exported symbols and type/doc metadata
- Macro authoring and runner behavior
- MCP setup, tool reference, and examples
- Idempotency, revisions, errors, limits, and safe token handling

### Project files and formats

- `.skf` format overview and compatibility rules
- Generated schema/field reference from the project validators and serializers
- Import/export format matrix from supported format registries
- Asset layout, integrity checks, and migration/version behavior

### Build and operate

- Local development setup
- Configuration and environment variable reference generated from the configuration schema
- Storage, Docker, deployment, backup, and upgrade guides
- Architecture map and engine boundaries
- Contributing, quality gates, release process, and support policy

### Reference and release history

- Searchable API/package/CLI/config references
- Release notes sourced from `docs/CHANGELOG.md` or the canonical release metadata
- Glossary generated from the canonical term list, with explanatory definitions maintained once
- Version selector only if the project begins supporting more than one maintained docs version

The site must retain useful inbound links from the current `README.md`, `docs/REST_API.md`, `docs/SKF_PROJECT_FORMAT.md`, and package READMEs. During migration, publish redirects or compatibility pages for existing paths where feasible.

## 4. Source-of-truth rules

Each fact has one authoritative source. Site pages may include generated output or import source documents, but must not copy these facts into a parallel table.

| Information | Authoritative source | Documentation output and drift check |
| --- | --- | --- |
| REST paths, methods, auth, query/body/response schemas, errors, limits | A typed API operation contract consumed or validated by each route handler | Generate OpenAPI and endpoint pages; contract tests exercise every registered operation against the running app. Fail on unregistered public routes or mismatched runtime behavior. |
| TypeScript client exports and signatures | Built `.d.ts` output from `packages/sketchforge-client` | Generate API reference from declarations; build package before site generation. |
| Python public symbols, types, and signatures | `packages/sketchforge-py/src` exports, annotations, and docstrings | Generate API reference from installed-package metadata/source; fail if examples import unavailable symbols. |
| Engine public API | `packages/sketchforge-engine/src/index.ts` and package export map | Generate package reference from declarations and exports; do not list internal modules as stable public API. |
| Shape kinds and accepted fields | Runtime shape definitions/validators and request types shared by browser and API | Generate shape catalog and field matrix; parity test browser, REST, TypeScript, and Python surfaces. |
| `.skf` structure and supported features | Validators, schema/version constants, serializer, importer, and migration code | Generate machine-readable schema and field reference; run round-trip and compatibility fixtures referenced by docs. |
| CLI commands and options | Actual command parser and package scripts that are part of the public CLI | Generate command pages from `--help` or parser metadata; compare examples to executable invocations. |
| Environment variables and defaults | Central configuration schema/readers | Generate a reference table including defaults, validation, security sensitivity, and affected subsystem. Reject undocumented public configuration keys. |
| Executable code examples | Existing package examples, MCP examples, tests, and designated tutorial fixtures | Embed the source file or named region; typecheck/lint/execute the same file in the docs CI lane. No copied fenced blocks for runnable code. |
| UI labels and localized strings | English locale catalog and UI action/command registries | Generate labels and searchable command names where useful; prose explains intent and workflow. Check generated labels exist in the source catalog. |
| Release version and release notes | `package.json`, package manifests, tags/releases, and the canonical changelog | Inject version data at build time and import release notes from one canonical source. Fail if published package versions drift unexpectedly. |
| Concepts, rationale, workflows, limitations | Maintained documentation source | Require an owning page and review when relevant behavior changes; automated examples and capability assertions validate concrete claims. |

The API operation contract is the main required extraction seam. It should define a stable operation ID, route, method, authentication, schemas, response statuses, errors, limits, and examples. Route handlers must use the contract's validators or be covered by generated contract tests. A manually maintained OpenAPI file that merely resembles the implementation does not satisfy this spec.

Where the current implementation has no structured source to extract from, add the smallest shared registry/schema needed to establish one. Do not introduce a generator that parses arbitrary implementation details with brittle regular expressions.

## 5. Examples and tutorials

Examples are product behavior, not decorative text.

- Each code sample is included from a source file or generated from a test fixture using a stable directive such as `example: packages/sketchforge-client/examples/bolt-plate.macro.mjs#run`.
- The site build fails if a directive points to a missing file, missing symbol/region, or empty excerpt.
- TypeScript examples must typecheck against the currently built package. Python examples must import and run against the current package.
- REST examples run in a local integration job with temporary project storage and a generated test token. They must not call production services.
- MCP examples validate against the current tool schema and use temporary local fixtures or a local test server.
- Examples that create or mutate projects state their execution mode and cleanup behavior. Destructive examples must operate only on temporary data.
- Tutorial steps that describe editor behavior must have a behavioral acceptance check where feasible. Screenshots are captured from the current app workflow in a reproducible browser job; manually curated images are allowed for conceptual illustrations only and must be labeled as illustrations.
- Generated output records the source path and, in contributor diagnostics, the source line or symbol so a stale claim can be fixed at its origin.
- A test that exists only to demonstrate a code block is not copied into a second implementation; the documentation invokes that test fixture or example directly.

## 6. Site requirements

- Static HTML, CSS, JavaScript, search index, and assets; no runtime server or private environment variables.
- Correct project-site base path at `/SketchForge-3D/`, including deep links, search, images, CSS, and client-side navigation.
- Responsive layouts, keyboard navigation, semantic headings, visible focus, sufficient contrast, and useful alt text.
- Built-in search indexes page titles, headings, generated API symbols, and reference tables. Search works without third-party SaaS.
- Stable page slugs and redirects when pages move. External and internal links are checked in CI.
- Pages identify the documentation version/repository revision they describe and display the release version used for generated references.
- No page depends on fetching live application state during build or render.
- Support source links that point to the exact repository path and commit represented by a page.
- Images and downloads have explicit licenses/provenance and reasonable size budgets.

## 7. Build and publishing workflow

### Required commands

Expose stable repository scripts, independent of the chosen site generator:

```text
npm run docs:generate   # build generated references and include executable examples
npm run docs:check      # links, source directives, schema parity, API coverage, and generated diff checks
npm run docs:build      # produce the static Pages artifact
npm run docs:preview    # serve the artifact locally under the project-site base path
```

The build must be deterministic: two clean builds from the same commit and dependency lockfile produce equivalent output. Generated files should either live only in the build directory or be checked in only when the repository already requires generated artifacts; the policy must be consistent and documented.

### Pull request checks

On every pull request that changes application code, packages, tests/examples, docs, or site tooling:

1. Install from the lockfile and build the public packages.
2. Generate API, configuration, shape, format, package, and CLI reference inputs.
3. Check that generation is clean and has no uncommitted diff where generated artifacts are committed.
4. Verify source directives, internal links, fragments, redirects, and image references.
5. Typecheck and execute the examples described in section 5.
6. Run API route/contract parity and project-format compatibility checks.
7. Build the static site with the exact `/SketchForge-3D/` base path.
8. Smoke-test representative deep links, search, and assets from the built artifact.

When practical, upload the built site as a pull-request artifact for reviewers. Do not deploy unmerged changes to the production Pages URL.

### GitHub Pages deployment

- Deploy only from the protected default branch after required checks pass.
- Use the official Pages artifact/deploy workflow with narrowly scoped `pages: write` and `id-token: write` permissions in the deployment job; all earlier jobs remain read-only.
- Configure repository Pages to use **GitHub Actions** as the publishing source.
- Set the Pages base path from repository metadata rather than duplicating a literal across configuration files.
- Use a concurrency group so an older deployment cannot overwrite a newer commit. Do not cancel a deploy after it has started publishing.
- Pin third-party GitHub Actions according to the repository's existing dependency/security policy.
- On deployment failure, keep the previous published site available and surface the failed commit and artifact link in Actions.
- No production secrets are needed to build or publish public documentation.

## 8. Content ownership and change policy

- Every maintained page has front matter containing a stable slug, title, audience, owner area, and optional reviewed revision.
- Each public code area maps to at least one reference page and one tested example or an explicit reason no example is appropriate.
- A pull request that changes public behavior must either update the source-derived reference automatically or update the owning concept/workflow page when user-facing explanation changes.
- Reviewers should reject manually copied signatures, endpoint lists, config tables, shape catalogs, and runnable code blocks when source directives or generators can provide them.
- A `docs:check` job reports the changed source symbol/route/config key and the owning page or missing example to make failures actionable.
- Translate stable prose only after the English source and generated contract are current. Generated API signatures and code examples remain language-neutral; localized UI labels come from locale catalogs.

## 9. Migration plan

Deliver the suite in small steps while retaining current published docs until replacement coverage exists.

### Phase 1: establish the site and guardrails

- [x] Select VitePress 1.6.4; verify project base-path build support, built-in local search, source includes, static output, and Actions artifact deployment workflow.
- [x] Add site shell, navigation, base path derived from repository metadata, Pages workflow, local source/link checks, and local preview command.
- [x] Import tracked repository Markdown from canonical sources without rewriting factual tables.
- [x] Publish a migration map and retain repository-relative Markdown paths in the generated source tree.
- [x] Configure the repository Pages publishing source as GitHub Actions and verify the first published deployment. The first deployment succeeded after PR #116 merged.

Phase 1 established and deployed the site shell. Package references and
executable examples (#118), stable-face `GET /faces` and `PATCH faceColors`
contracts (#120, #125), operator configuration (#121), project-format
reference (#123), MCP reference/navigation (#122), source provenance (#126),
STEP color guidance (#119), and lower-case compatibility routes (#134) have
merged. Deterministic generator-hook integration (#128) has also merged.
Full API schemas/OpenAPI and remaining accessibility and behavioral smoke
checks are incomplete; this branch adds an initial browser smoke slice, not a
complete accessibility audit.

The built-site browser test uses the pinned Playwright dependency. On a local
checkout, install its Chromium binary with `npm run docs:browser:install`
before `npm run docs:build`; the documentation workflow installs Chromium and
its Ubuntu system dependencies before running the build.

### Phase 2: generate package and example documentation

- **Merged PR #118:** `scripts/docs/generate-package-references.mjs` builds deterministic Markdown references from the built TypeScript client and engine declaration entry points; `scripts/docs/generate-python-reference.py` lists the Python package's `__all__` exports with available signatures and summaries. Generated pages live under `docs/reference/`, are built by `docs:generate`, and are linked from the docs site's reference navigation. The three `docs/packages/*.md` pages recursively include the registry-facing package READMEs as their canonical prose source. `docs/guides/package-examples.md` includes the six existing client and Python macro example files directly. The TypeScript and Python integration suites exercise those same files against a local server; dedicated CI jobs generate references and execute the examples.
- **Merged PR #136:** adds Python static type checking and symbol-level source links. PR #137 adds the complete REST measurement listing contract, #139 adds API reference source links, and #140 adds face-based drafting documentation.
- Build TypeScript and engine declaration references from the package build; generate Python references from public exports and annotations/docstrings; convert examples into source includes and execute them in CI.
- Reuse package README content for package registries and the site from a shared source or generated subset.

### Phase 3: make the REST reference authoritative

- **Initial slice merged in PR #112:** `apps/web/src/lib/apiV1OperationContract.ts` registers each public route method with its method, path, operation ID, and auth mode (including unauthenticated `OPTIONS`). A parity test discovers route handlers and fails on missing or duplicate registrations. `POST /projects` is the first route with a runtime-consumed request contract and verified response-status set. The inventory is not yet a full schema contract; the generated OpenAPI currently covers only operations with faithful schemas.
- **Merged PRs #120 and #125:** stable application-owned IDs are included in `GET /faces` and are the persisted `faceColors` keys for `PATCH /shapes`. The operation inventory still lacks complete schemas for the rest of the REST surface.
- **This slice:** `docs/openapi-v1.json` is generated from the runtime operation registry and currently documents six project/shape CRUD operations whose request/query/status schemas can be represented accurately. The document enumerates omitted operations with reasons; this partial output does not make the REST reference authoritative for the whole API.
- Define the typed operation contract and migrate routes incrementally.
- Expand the generated OpenAPI coverage as operation metadata becomes a faithful description of runtime validation and response behavior; generate endpoint pages from the same source.
- Assert all public `/api/v1` routes are registered and execute representative contract cases against the local app.
- Replace endpoint/schema tables in `docs/REST_API.md` with generated output or a compatibility link to the site after full operation coverage exists. Until then, keep generated and hand-written coverage boundaries explicit.

### Phase 4: formats, configuration, CLI, and workflow guides

- **Merged slices:** Parameterized shape requests (PR #115), published CLI (PR #117), operator configuration (PR #121), `.skf` format (PR #123), MCP schemas/navigation (PR #122), and STEP color guidance (PR #119). Generator hooks for deterministic package, format, config, and MCP drift checks merged in PR #128. Broader workflow guides remain outstanding.
- Extract structured registries for shape kinds, project formats, environment variables, CLI options, and MCP tool schemas.
- Generate references and add round-trip/command/tool smoke examples.
- Retain human-authored tutorials for context and task flow; embed live examples and generated UI labels.

### Phase 5: close the stale-content loop

- Add coverage rules for every public route, exported symbol, config key, format, and example.
- Add a recurring link check for external links as a non-blocking report; internal broken links stay blocking.
- **Merged PR #126:** generated site pages show the package version, full repository revision, and source links pinned to that revision. PR #134 adds redirect coverage for legacy public paths.
- This slice adds a release process guide and checks release metadata consistency. Broader coverage rules remain outstanding.
- Remove superseded manually maintained tables and duplicate code blocks.

## 10. Acceptance criteria

The suite is ready for general use when all of these are true:

1. A clean checkout can build and preview the docs without secrets or production connectivity.
2. A default-branch merge deploys the built site to GitHub Pages at the configured canonical URL.
3. The site loads all assets and deep links under the repository path prefix.
4. Public API route coverage is complete and the generated OpenAPI/reference is tested against the running route behavior.
5. TypeScript, Python, engine, configuration, and format references are generated from authoritative source inputs.
6. Every runnable code example in the site is sourced from a repository file and typechecked or executed in CI.
7. CI fails on missing source includes, broken internal links, undocumented public configuration, unregistered public routes, example failures, or generated-reference drift.
8. Search, keyboard navigation, responsive behavior, and accessibility basics are smoke-checked on the built artifact. This branch covers local search, skip navigation, visible focus, mobile menu keyboard operation, landmarks/headings, and overflow at 390px; contrast, alt text, and broader workflow checks remain open.
9. Existing public documentation links either resolve to the new site or have intentional redirects/compatibility pages. Lower-case compatibility paths merged in PR #134; the full historical inbound-link inventory remains to be audited.
10. Maintainers can identify the source file and owning page from a generated-reference check failure.

## 11. Explicit non-goals

- Replacing product UI help or in-editor tutorials with the docs site.
- Rewriting all explanatory prose as generated text.
- Building documentation from the production application or production data.
- Claiming that generated signatures alone explain behavioral semantics, kernel limitations, persistence behavior, or security constraints.
- Versioned documentation branches until the project has a concrete policy for maintaining multiple supported releases.

## 12. Risks and decisions to settle during implementation

- **API contract extraction cost:** the current REST reference is prose and endpoint tables alongside route handlers. A contract registry is needed to keep request/response docs honest; migrate incrementally and prove it against handlers rather than scraping them.
- **Pages base path:** app deployment and static export currently have their own build assumptions. Keep the docs artifact independent so documentation deployment cannot change production app hosting.
- **Shared README content:** package registries expect README files. Choose a shared-source/include strategy that works for both package publishing and the site, and test the actual packed packages.
- **Screenshot stability:** UI screenshots can be noisy across browser/OS versions. Capture them in a pinned browser environment, compare only stable workflows, and treat explanatory diagrams separately.
- **Generated docs readability:** generated API references need curated summaries and runnable examples, but those summaries must link back to authoritative symbols and tested examples.
- **External link availability:** never make the docs build depend on arbitrary external hosts; report external link failures separately from required internal-link checks.
