---
slug: /docs/adr/0001-dependency-ordered-recompute
title: Dependency-ordered parametric recomputation
audience: Contributors
owner: Engine
---

# ADR 0001: Dependency-ordered parametric recomputation

- Status: Accepted
- Date: 2026-10-26
- Issue: [#351](https://github.com/constructorfleet/SketchForge-3D/issues/351)

## Context

Parametric edits currently split responsibility across `engine.changeShape`
and `parametricRecompute.ts`. `changeShape` rebuilds a sketch-backed output and
replays its supported retained operations. The recompute module then finds
that output in the nested shape tree and rebuilds retained boolean ancestors.
This preserves atomic writes, but ordering is implicit in recursive traversal.

The `.skf` project already persists sketch-source IDs, feature inputs, and
nested boolean-group membership. A separate persisted history format would
duplicate those inputs and require a migration without adding information the
recompute path needs today.

## Decision

Build a transient directed acyclic graph from the loaded project for each
recompute request. Do not persist synthetic feature nodes or change the `.skf`
schema in this work.

- Each shape ID identifies one recompute node. A sketch-source ID points to
  its retained output node; the recompute seam rebuilds that output and its
  supported retained treatments before scheduling downstream dependencies.
- A boolean-group node depends on each retained operand and produces the group
  output. Plain grouping remains a container node, so changed child outputs
  flow through it without a kernel operation.
- The node graph is derived from the nested shape tree and its existing source
  IDs. No generated feature IDs or new persisted records are needed.

Use a deterministic topological sort. Persisted child order breaks ties between
independent operands. A cycle or missing/ambiguous input is a recompute failure
that names the affected node; it is not silently skipped.

Keep failure atomic: compute the changed source and every dependent node in
memory, then write the project once after all nodes succeed. On failure, keep
the last saved project untouched and return the first failed node and its
underlying reason. This matches current transaction behavior and avoids a
project containing downstream geometry built from a mixture of old and new
inputs.

Expose one engine entry point, `recompute(project, changedSourceIds)`, which
constructs the graph, rebuilds changed sketch-source outputs, schedules their
affected dependents, and returns either the complete replacement shape tree or
a node-scoped failure. `engine.changeShape` supplies the changed recipe and
calls this seam; the engine transaction remains the only place that writes the
returned tree.

## Consequences

- Existing project files remain readable and writable without a schema
  migration.
- Ordering and failure behavior become explicit and testable at one seam.
- A failed feature does not leave a partially recomputed tree.
- New retained group dependencies are derived from the shape tree and do not
  add another traversal branch at each caller.
- The graph is rebuilt per request. This favors correctness and locality over
  caching; caching can be considered only after profiling demonstrates a need.

## Validation completed

- Preserve every existing recompute test unchanged.
- Cover an unspecial-cased chain such as extrusion → prism draft → fillet →
  boolean → second boolean, asserting either correct recomputed geometry or an
  atomic failure that names the failed node.
- Cover deterministic ordering and cycle detection at the graph interface.
- Verify atomic failure by comparing the complete persisted project before and
  after a deliberately invalid downstream operation.

The recompute seam, source recipe replay, scheduler, and node-scoped failures
are implemented in PR #580. The nested draft → fillet → boolean → boolean
regression verifies that an ineffective downstream cut names its shape ID and
leaves the stored project unchanged. Direct tests cover deterministic ordering
and cycle detection. The focused suite preserves the existing recompute tests.

## Open question

This decision treats the current shape tree and `.skf` feature inputs as the
canonical dependency record. Arbitrary branching feature history, independent
feature editing, and persistent failed-node status would require an explicit
feature-node schema and a separate compatibility decision.
