# Documentation site status and migration map

The static VitePress site is published at
[`https://constructorfleet.github.io/SketchForge-3D/`](https://constructorfleet.github.io/SketchForge-3D/).
The repository remains the source for maintained prose, examples, and
generated references. On pull requests, docs CI generates references before
verification and site build, then uploads the generated outputs. A trusted
follow-up validates the artifact and PR before committing only allowlisted
updates to eligible same-repository PR branches. It dispatches CI, docs, and
title checks for the exact resulting commit SHA. Fork PRs and PRs changing
workflow-control files retain the generated artifact as a fallback and do not
get an automatic branch update. The initial docs run validates/builds the PR
head; the dispatched checks validate the head after any generated-output
commit.

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
  commits changed outputs to eligible same-repository PR branches, then
  dispatches CI, docs, and PR-title checks for the exact resulting commit SHA;
  each dispatched workflow verifies its expected SHA. Fork PRs and PRs changing
  `.github/workflows/` or `.github/actions/` controls use the artifact fallback
  without an automatic branch update. The TypeScript, Python, and engine
  references remain generated in `.docs-site/docs/reference/` for the Pages
  artifact, not tracked source files.
- Package guides include registry-facing README files, and package examples
  run against a local API. Python package references and examples are checked
  with mypy and integration tests. The MCP example is checked against the
  server's current advertised tool schemas.
- The editor quick-start is tested in a browser from the first sketch through
  save and export. Broader task-oriented guides and corresponding workflow
  checks remain incomplete.

## REST API coverage

[`apps/web/src/lib/apiV1OperationContract.ts`](../apps/web/src/lib/apiV1OperationContract.ts)
registers all 32 public route operations, and route tests check parity between
the registry and handlers. Nine operations have runtime-backed request and
response contracts and appear in generated OpenAPI. The other 23 are listed
with omission reasons in the generated contract; full route coverage remains
open.

`PATCH /api/v1/shapes` accepts `sketchProfile` for a retained sketch sweep and
rebuilds the solid while preserving shape and source IDs. The operation is
still omitted from OpenAPI because the combined custom face-color and profile
validation is not fully represented there. Sweep source persistence and
editing work, but downstream dependency-ordered recomputation is not available.
See the [REST API guide](./REST_API.md#sketch-sweeps) and the
[kernel capability inventory](./UNEXPLORED_KERNEL_CAPABILITIES.md).

## Durable gaps

- **Complete REST reference:** add runtime-backed request/response contracts
  for the remaining operations, generate endpoint pages from those contracts,
  and replace or clearly bound hand-maintained endpoint details.
- **Generated-output automation — implemented with limits:** generators run
  before verification/build, and a trusted artifact-only writer commits
  allowlisted updates to eligible same-repository PR branches before exact-SHA
  CI, docs, and title checks are dispatched. Fork PRs and PRs changing workflow
  controls use artifact fallback and require a maintainer to apply generated
  updates. The initial docs run checks/builds the source PR head; dispatched
  runs check the updated head containing any generated commit.
- **Configuration ownership:** the current generated operator reference
  documents supported server/container settings, not every environment read
  across server, desktop, tests, build tools, and browser code. A central
  supported-configuration schema and complete ownership checks remain open.
- **Examples and page ownership:** require runnable examples to come from
  source files and execute them in CI; add consistent page audience/owner
  metadata and diagnostics mapping changed sources to their owning pages.
- **Task workflows:** expand tested task guides beyond the editor quick-start,
  package examples, and current REST/MCP workflows.
- **Inbound links:** local links, compatibility paths, and repository history
  are inventoried. External backlinks outside repository history cannot be
  established by this inventory.

See the [documentation suite specification](./DOCUMENTATION_SUITE_SPEC.md)
for the full objective, source-of-truth rules, implementation phases, and
acceptance audit.
