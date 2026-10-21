# Documentation site status and migration map

The static VitePress site is published at
[`https://constructorfleet.github.io/SketchForge-3D/`](https://constructorfleet.github.io/SketchForge-3D/).
The repository remains the source for maintained prose, examples, and
generated references. The required CI order is to refresh generated output,
commit any allowlisted updates to the PR branch, validate the resulting commit,
build static pages, run built-site checks, and publish the Pages artifact from
the default branch. The current workflow still runs freshness checks before
generation and does not commit refreshed outputs; correcting that order is an
open pipeline task.

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
- CLI, shape, operator configuration, `.skf`, MCP, publishing-client, and
  OpenAPI references have source generators and drift checks. These generators
  write source-controlled Markdown outputs. `docs/openapi-v1.json` is currently
  a tracked generated artifact. Generated files may remain committed for
  repository browsing; CI must regenerate the allowlisted outputs before
  checks, commit any refreshed files to the PR branch, and run required checks
  against the resulting commit.
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
- **Generated-output automation:** run `docs:generate` before `docs:check` and
  the site build. `docs:check` currently compares generated Markdown with
  sources before the full generator command runs, so stale output fails CI
  instead of being refreshed first. Generated Markdown may remain tracked; CI
  should commit refreshed allowlisted outputs to the PR branch and run required
  checks against the resulting commit.
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
