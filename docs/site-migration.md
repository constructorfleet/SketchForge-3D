---
slug: "/docs/site-migration"
title: "Documentation site status and migration map"
audience: "Contributors"
owner: "Contributors"
---

# Documentation site status and migration map

The static VitePress site is published at
[`https://constructorfleet.github.io/SketchForge-3D/`](https://constructorfleet.github.io/SketchForge-3D/).
The repository remains the source for maintained prose, examples, and
generated references. On pull requests, docs CI generates references before
verification and site build, then uploads the generated outputs. A trusted
default-branch follow-up validates the artifact and PR before committing only
allowlisted updates to same-repository PR branches. A separate trusted workflow
checks the exact resulting SHA in read-only jobs and records the required
contexts without checking out PR code in the check-writing job. Fork PRs use
the generated artifact fallback because their branches cannot be pushed.
Successful docs builds on main also upload their outputs; a trusted writer
opens or refreshes a bot repair PR if tracked outputs differ. Main remains
stale only until that repair PR is merged, and CI regenerates before validation
so stale tracked output alone does not fail the docs check.

## Delivered site capabilities

- Project-path routing, local search, navigation, recursive source includes,
  local-link checks, a local preview command, and GitHub Pages deployment.
- Compatibility pages and redirects preserve the repository's public
  documentation paths. See the
  [historical inbound-link inventory](./HISTORICAL_INBOUND_LINKS.md) for the
  repository-controlled paths and their destinations.
- Source provenance is rendered into built pages: package version, repository
  revision, and source links point to the revision represented by the build.
- The built-site browser checks cover navigation, visible focus, landmarks,
  headings, search, responsive behavior, accessible names, contrast, alt text,
  reduced motion, and 320px reflow. A separate browser check exercises the
  editor quick-start. The docs workflow installs its pinned browser runtime.
- External-link availability is reported in a separate advisory job. Remote
  failures do not block the deterministic local docs check or site build.

## Current reference coverage

- TypeScript, Python, and engine references are generated into
  `.docs-site/docs/reference/` from package declarations and public exports.
  Their rendered pages are validated as part of the Pages artifact.
- Seven generators write tracked output for repository browsing:
  `docs/PUBLISHING_CLIENTS.md`, `docs/SHAPE_REQUEST_REFERENCE.md`,
  `docs/CLI_REFERENCE.md`, `docs/OPERATOR_CONFIGURATION.md`,
  `docs/SKF_FORMAT_REFERENCE.md`, `docs/mcp/TOOLS_REFERENCE.md`, and
  `docs/openapi-v1.json`. The OpenAPI JSON is linked directly from
  `docs/REST_API.md`. PR docs CI runs `docs:generate` before generated-output
  verification and site build, then uploads generated output. A trusted
  `workflow_run` handler treats that artifact as untrusted input, verifies its
  manifest and source PR, and writes only allowlisted generated paths. It
  commits changed outputs to same-repository PR branches and dispatches a
  default-branch verifier for the exact resulting SHA. Fork PRs use the
  artifact fallback. Successful main docs runs create or refresh one bot repair
  PR when generated tracked output differs; protected main is never written
  directly by the workflow. The TypeScript, Python, and engine
  references remain generated in `.docs-site/docs/reference/` for the Pages
  artifact, not tracked source files.
- Package guides include registry-facing README files, and package examples
  run against a local API. Python package references and examples are checked
  with mypy and integration tests. The MCP example is checked against the
  server's current advertised tool schemas.
- The editor quick-start and the create/edit/save/reload/export guide are tested
  through browser acceptance. Broader task-oriented guides and corresponding
  workflow checks remain incomplete.

## REST API coverage

[`apps/web/src/lib/apiV1OperationContract.ts`](../apps/web/src/lib/apiV1OperationContract.ts)
registers all 32 public route operations, and route tests check parity between
the registry and handlers. 21 operations have runtime-backed request and
response contracts and appear in generated OpenAPI. The other 11 are listed
with omission reasons in the generated contract; full route coverage remains
open.

`PATCH /api/v1/shapes` accepts `sketchProfile` for a retained sketch sweep,
targeted by either its output shape ID or persisted `sketchSourceId`, and
rebuilds the solid while preserving shape and source IDs. Editing a
sketch-backed sweep also recomputes retained boolean descendants bottom-up and
persists the result atomically. Other downstream operation types remain
unsupported. The sweep-profile operation is still omitted from OpenAPI because
the combined custom face-color and profile validation is not fully represented
there.
See the [REST API guide](./REST_API.md#sketch-sweeps) and the
[kernel capability inventory](./UNEXPLORED_KERNEL_CAPABILITIES.md).

## Durable gaps

- **Complete REST reference:** add runtime-backed request/response contracts
  for the remaining operations, generate endpoint pages from those contracts,
  and replace or clearly bound hand-maintained endpoint details.
- **Generated-output automation — implemented with limits:** generators run
  before verification/build, and a trusted artifact-only writer commits
  allowlisted updates to same-repository PR branches before exact-SHA checks
  are recorded by a default-branch workflow. Fork PRs use artifact fallback.
  Successful main docs runs open or refresh a bot repair PR for stale tracked
  output; main remains stale until that repair PR is merged.
- **Configuration ownership — implemented for the declared supported
  inventory:** the generated operator reference is backed by a registry of
  supported server/container, desktop, TypeScript/Python client, and local MCP
  settings. The desktop entry includes `SKETCHFORGE_DESKTOP_PORT`; the registry
  links settings to their implementation readers and owning pages, and tests
  detect unregistered readers within those tracked scopes. It does not treat
  every environment read as a supported setting: for example,
  `SKETCHFORGE_DESKTOP_DEV_URL` is an internal launcher handoff and `NODE_PATH`
  is pass-through. Build, test, CI, launcher, pass-through, and other readers
  outside the declared inventory remain out of scope.
- **Examples and page ownership — partial:** all maintained
  `docs/**/*.md` pages and staged generated package references have required
  audience/owner metadata. A separate docs check covers 23 supported-language
  runnable fences: each must include its exact tracked source with a named test
  and CI command, or carry a concrete reasoned exemption. Exemptions do not
  establish execution coverage, and other fence languages and runnable content
  outside this set are not covered.
  Changed-source ownership diagnostics cover selected source trees, including
  REST routes, TypeScript client/MCP, engine, Python client, and the package
  example trees. The mapping is path-based and is not symbol-level or complete
  repository coverage. The local-project MCP shell command is included from and
  executed as the same source fixture; package examples are sourced and tested.
  Remaining work is to expand source/test coverage to runnable content outside
  this bounded set, and to cover editor/UI sources, other examples, and all
  content sources with ownership diagnostics.
- **Task workflows:** expand tested task guides beyond the editor quick-start,
  package examples, and current REST/MCP workflows.
- **Inbound links:** local links, compatibility paths, and repository history
  are inventoried. External backlinks outside repository history cannot be
  established by this inventory.

See the [documentation suite specification](./DOCUMENTATION_SUITE_SPEC.md)
for the full objective, source-of-truth rules, implementation phases, and
acceptance audit.
