---
slug: /docs/ROADMAP
title: Roadmap
audience: Contributors
owner: Contributors
---

# Roadmap

This page summarizes active tracked work. Issue status remains authoritative.

## Open epics

| Epic | Status |
| --- | --- |
| [#324: Project storage durability](https://github.com/constructorfleet/SketchForge-3D/issues/324) | Open; autosave, server volume, and project provenance work is tracked below the epic. |
| [#325: Server route and local MCP safety](https://github.com/constructorfleet/SketchForge-3D/issues/325) | Open; route hardening and caller isolation work is tracked below the epic. |
| [#326: Desktop release installers](https://github.com/constructorfleet/SketchForge-3D/issues/326) | Open; cross-platform installer and release work is in progress. |
| [#327: Parametric recompute and editable feature history](https://github.com/constructorfleet/SketchForge-3D/issues/327) | Open; bounded recompute support is in progress. |
| [#328: Client parity](https://github.com/constructorfleet/SketchForge-3D/issues/328) | Open; REST, TypeScript, Python, MCP, and CLI parity work is tracked below the epic. |
| [#329: Editor parity with engine and API](https://github.com/constructorfleet/SketchForge-3D/issues/329) | Open; editor parity work is tracked below the epic. |
| [#330: Translation completeness](https://github.com/constructorfleet/SketchForge-3D/issues/330) | Open; translation coverage for the seven shipped locales remains active work. |
| [#331: CI, dependency, and planning hygiene](https://github.com/constructorfleet/SketchForge-3D/issues/331) | Open; remaining CI and planning tasks are tracked below the epic. |

## CAD worker reliability

- [#361: Release exact-cut intermediate handles during an open edge-modifier session](https://github.com/constructorfleet/SketchForge-3D/issues/361) — implementation and real-kernel handle-baseline regression coverage complete; awaiting review. Cuts use an arena checkpoint and release their allocations on success or failure, preserving retained session geometry.

## Group evaluation

- [#500: Evaluate solid-only groups as a union](https://github.com/constructorfleet/SketchForge-3D/issues/500) — completed in [#510](https://github.com/constructorfleet/SketchForge-3D/pull/510). Properties, exports, sections, drawings, interference and thickness fuse a group record's visible children through OCCT, sewing mesh members from their triangles; a member hidden inside the group is left out, as the editor leaves it undrawn. Deferred: a Manifold fallback for mesh members OCCT cannot sew, and fillets, chamfers and shells applied to a group record without ungrouping it first.

## Documentation suite open work

- The [documentation suite specification](DOCUMENTATION_SUITE_SPEC.md) tracks partial source ownership diagnostics and broader task-workflow coverage as open work.
- The [site migration status](site-migration.md) records unmapped editor/UI sources, examples, and content sources as open ownership work.

## Dependency maintenance

- [#397: Keep Vitest's mocker out of production installs](https://github.com/constructorfleet/SketchForge-3D/issues/397) — security dependency fix.

## Project storage durability

Tracked under [epic #324](https://github.com/constructorfleet/SketchForge-3D/issues/324).

- [#332: Surface autosave failures while editing](https://github.com/constructorfleet/SketchForge-3D/issues/332) — P0, open.
- [#336: Secure local folder downloads](https://github.com/constructorfleet/SketchForge-3D/issues/336) — P0, open.
- [#377: Handle failed project thumbnail captures](https://github.com/constructorfleet/SketchForge-3D/issues/377) — capture failures are logged and retried; zero-size or lost-context canvases return an empty thumbnail; implementation and regression coverage complete, awaiting review.

## API request safety

Tracked under [route security epic #325](https://github.com/constructorfleet/SketchForge-3D/issues/325).

- [#338: Enforce request body size limits on REST routes](https://github.com/constructorfleet/SketchForge-3D/issues/338) — P2, open.

## API contract accuracy

- [#367: Honour If-Match on v1 write routes](https://github.com/constructorfleet/SketchForge-3D/issues/367) — P2, implementation and route/client coverage complete; awaiting review.
- [#366: Declare the projectId query on align and distribute](https://github.com/constructorfleet/SketchForge-3D/issues/366) — implementation and contract regression coverage complete; awaiting review.
- [#373: Add limit and cursor paging to project and shape listings](https://github.com/constructorfleet/SketchForge-3D/issues/373) — implementation and route/client coverage complete; awaiting review.
- [#372: Normalize status and error codes for limit violations across v1 routes](https://github.com/constructorfleet/SketchForge-3D/issues/372) — implementation and contract tests complete; awaiting review.

## Documentation accuracy

- [#371: Repair stale API-coverage statements in the changelog and client READMEs](https://github.com/constructorfleet/SketchForge-3D/issues/371) — changelog coverage is checked against generated OpenAPI; the current README method and grouping statements match the shipped client and API.

## Client command line

- [#374: Add direct project, import, and export commands to the macro CLI](https://github.com/constructorfleet/SketchForge-3D/issues/374) — implementation, generated reference, and mocked-server coverage complete; awaiting review.

## Client package releases

- [#370: Keep the Python package version in sync](https://github.com/constructorfleet/SketchForge-3D/issues/370) — ensure `sketchforge3d.__version__` follows release-please.

## MCP bridge

- [#369: Document local STL import and executable MCP workflows](https://github.com/constructorfleet/SketchForge-3D/issues/369) — the README and agent skill describe local project tools and path rules; the guides include an executable STL import, measure, and export workflow.
- [#368: Remove editor-only fields from local MCP tools](https://github.com/constructorfleet/SketchForge-3D/issues/368) — implementation and tests complete; awaiting review.
- [#502: Match the create_shape kind schema to each mode](https://github.com/constructorfleet/SketchForge-3D/issues/502) — implemented on `fix/502-create-shape-kind-schema`; awaiting review. Known limits, stated in the tool schema: local mode stores `gear`, `text`, and `icosahedron` but cannot measure or export them, because the server's CAD kernel has no exact builder for them; a `roundRoof` taller than half its width fails to build; a taper builds only on `box`, `cube`, and `cylinder`, and the editor bridge ignores taper fields; STEP export holds only `box`, `cube`, `cylinder`, `cone`, and `sphere`. Not yet done: exact builders for the stored-only kinds, local `sketch` extrusion from an `[x, z]` profile, which needs an engine request kind, and editor-bridge support for the remaining parameterized kinds.
- [#505: Set hole on create_shape for all kinds, and name/color on group and cut results](https://github.com/constructorfleet/SketchForge-3D/issues/505) — implemented on `feat/505-hole-and-result-names`, based on `main` now that [PR #509](https://github.com/constructorfleet/SketchForge-3D/pull/509) has merged; awaiting review. Editor-mode hole creation and result naming are covered by `tests/browser/editor-mcp-results.test.mjs`, which runs `next dev` because the editor bridge is off under `next start`. The REST `POST /api/v1/groups` and `POST /api/v1/booleans` endpoints do not take `name` or `color` yet.

## MCP host filesystem safety

- [#339: Confine MCP host file access and refuse silent overwrites](https://github.com/constructorfleet/SketchForge-3D/issues/339) — implemented on `security/339-mcp-filesystem-root`; awaiting review.
- [#365: Import STL, OBJ, and SVG files through the MCP bridge](https://github.com/constructorfleet/SketchForge-3D/issues/365) — implemented on `feat/365-mcp-import-obj-svg-stack`; awaiting review.

## Editor parity with the engine and API

Tracked under [epic #329](https://github.com/constructorfleet/SketchForge-3D/issues/329).

- [#385: Manage keyboard focus in editor dialogs](https://github.com/constructorfleet/SketchForge-3D/issues/385) — initial focus, modal Tab handling, Escape, and focus return are implemented with browser and axe coverage; in review.
- [#376: Avoid reserved editor shortcut keys](https://github.com/constructorfleet/SketchForge-3D/issues/376) — lock and visibility bindings avoid browser and macOS reserved keys; the editor has a keyboard-shortcuts dialog and guide section.
- [#379: Shell and tray (hollow) operation in the shape inspector](https://github.com/constructorfleet/SketchForge-3D/issues/379) — P2, implemented with browser coverage; in review.

## Geometry placement

- [#424: Keep server treatments in place on tilted shapes](https://github.com/constructorfleet/SketchForge-3D/issues/424) — P2, open.

## Editor parity

Tracked under [epic #329](https://github.com/constructorfleet/SketchForge-3D/issues/329).

- [#378: Explode imported STEP assemblies from the shape inspector](https://github.com/constructorfleet/SketchForge-3D/issues/378) — P2, implemented and in review.
- [#380: Interference check and wall-thickness analysis in the editor](https://github.com/constructorfleet/SketchForge-3D/issues/380) — P2, implemented and in review.
- [#386: Cover the core editor workflows in browser tests](https://github.com/constructorfleet/SketchForge-3D/issues/386) — browser regressions now cover file import/export, boolean hole grouping, edge treatments, pattern, mirror, align, distribution, prism draft and touch; implementation is ready for review.

## Editor CAD tools

Tracked under [epic #329](https://github.com/constructorfleet/SketchForge-3D/issues/329).

- [#381: 3D measurements and exact B-rep inspector properties](https://github.com/constructorfleet/SketchForge-3D/issues/381) — implementation and browser coverage complete; awaiting review.
- [#382: Section view and kernel hidden-line SVG/DXF export](https://github.com/constructorfleet/SketchForge-3D/issues/382) — implementation and browser coverage complete; awaiting review.
- [#506: Feature-edge (crease angle) drawing for mesh shapes](https://github.com/constructorfleet/SketchForge-3D/issues/506) — SVG projections and local `capture_image` draw meshes by feature edges, silhouettes and boundaries with an optional `featureAngle`; meshes and exact solids still occlude each other, and a mesh inside a group with no hole draws the same way. Implemented with regression coverage; awaiting review. Deferred: a group that cuts a hole in a mesh is still sewn and drawn by kernel hidden-line removal; typed `featureAngle` on the TypeScript and Python `exports` helpers (the REST body already accepts it).

## Client parity

- [#364: Python CAD resources and exact face listings](https://github.com/constructorfleet/SketchForge-3D/issues/364) — Python STEP explosion, sampled wall thickness, DXF export, and exact face listing in both clients implemented with regression coverage; awaiting review.

## CAD geometry correctness

- [#354: Preserve face lineage and replay non-45° chamfers](https://github.com/constructorfleet/SketchForge-3D/issues/354) — implementation and regression coverage complete; awaiting review.
- [#355: Report kernel failures and guard face reselection](https://github.com/constructorfleet/SketchForge-3D/issues/355) — implementation and regression coverage complete; awaiting review.
- [#356: Draft colored plain revolves](https://github.com/constructorfleet/SketchForge-3D/issues/356) — implementation and regression coverage complete; awaiting review.
- [#357: Remove duplicated sketch-sweep builder branch](https://github.com/constructorfleet/SketchForge-3D/issues/357) — completed on `main` and issue closed.
- [#435: Keep retained drafts in place across draft growth and rotated sketch edits](https://github.com/constructorfleet/SketchForge-3D/issues/435) — implementation and regression coverage in progress.
- [#412: Preserve non-uniform resize in face-draft paths](https://github.com/constructorfleet/SketchForge-3D/issues/412) — P2, implementation and regression coverage in progress.
- [#436: Preserve mirrors in REST face and prism drafts](https://github.com/constructorfleet/SketchForge-3D/issues/436) — implementation and regression coverage complete; awaiting merge.
- [#503: Keep partial-sweep revolves about their axis](https://github.com/constructorfleet/SketchForge-3D/issues/503) — REST, MCP (local and editor) and editor revolves place and rebuild by the axis, which summaries report; regression coverage by volume and centre of mass complete; awaiting review.
- [#504: Revolve resolution control](https://github.com/constructorfleet/SketchForge-3D/issues/504) — `sides` and `quality` are advertised on `create_shape` for revolves and threads and typed in both clients; regression coverage by volume and centre of mass complete; merged in #520. **Deferred to [#523](https://github.com/constructorfleet/SketchForge-3D/issues/523):** measuring, booleans, interference and STEP export of a plain revolve still sew its mesh. A plain full turn already has an exact OCCT solid for edges, faces, fillets and drafts (`exactRevolveSolidForShape`); using it in `placedSolidForShape`, and extending it to partial sweeps about the recorded axis (#503), would make those exact and report `precision: "exact"`. That change touches the shared solid builder and is tracked in #523.

## STEP interoperability

- [#353: Export native nested STEP assembly hierarchy](https://github.com/constructorfleet/SketchForge-3D/issues/353) — native XCAF group occurrences and nested reimport coverage implemented; direct editing of imported occurrence placements remains open.

## Engine limits and regression coverage

- [#358: Document engine limits in the REST reference](https://github.com/constructorfleet/SketchForge-3D/issues/358) — thresholds, status behavior, and a regression check for exported limits are documented; STEP import and explosion share one limit definition.
- [#360: Benchmark bounded kernel operations](https://github.com/constructorfleet/SketchForge-3D/issues/360) — cut, STEP explode, interference, section, and revolve fillet benchmarks with enforced budgets are implemented; awaiting review. See [performance budgets](PERFORMANCE.md).
- [#507: Section mesh shapes above 50k triangles](https://github.com/constructorfleet/SketchForge-3D/issues/507) — mesh shapes are sliced directly by plane-triangle intersection instead of being sewn into an OCCT solid; the cap is 2,000,000 triangles across the selection and its refusal names the `shapeIds` workaround; planes lying on interior mesh faces draw those faces' edges. Imported STEP shapes that carry exact B-rep are still sectioned from their mesh, as before; cutting them exactly is not yet done. Awaiting review.
- [#359: Add direct engine regression coverage](https://github.com/constructorfleet/SketchForge-3D/issues/359) — STEP hierarchy bounds, ambiguous metadata fallback, transformed separation/interference, and recompute placement coverage merged in #489; follow-up signed-volume/centroid assertions and a mirror-preserving interference fixture are awaiting review.
- [#508: Fast mesh-native shape properties](https://github.com/constructorfleet/SketchForge-3D/issues/508) — mesh-sourced shapes are measured from their triangles with multi-shell and void handling; exact shapes keep the OCCT path. Implemented with regression coverage; awaiting review.
- [#501: Exact paths for watertight meshes with internal voids](https://github.com/constructorfleet/SketchForge-3D/issues/501) — a mesh made of several closed shells is built into an exact solid one shell at a time, with voids cut out by nesting depth, so booleans and interference accept it (drawings and sections already read meshes directly after #511/#513); separate closed bodies that overlap without nesting are refused, since their assembly would not match the mesh's own volume; the refusal for an open mesh no longer mentions filleting. Builds on #508; awaiting review. The editor's own CAD modifier worker still sews a mesh as one shell and refuses a void mesh; deferred to [#527](https://github.com/constructorfleet/SketchForge-3D/issues/527).

## Sketch constraints

- [#352: Add bounded-solver sketch constraints](https://github.com/constructorfleet/SketchForge-3D/issues/352) — tangent-to-Bezier constraint implemented as the first constraint slice; remaining constraint types are tracked for separate PRs.
