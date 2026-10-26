---
slug: /docs/adr/0001-dependency-ordered-recompute
title: Dependency-ordered parametric recomputation
audience: Contributors
owner: Engine
---

# ADR 0001: Dependency-ordered parametric recomputation

- Status: Proposed
- Date: 2026-10-26
- Issue: [#351](https://github.com/constructorfleet/SketchForge-3D/issues/351)

## Context

Parametric edits currently split responsibility across `engine.changeShape`
and `parametricRecompute.ts`. `changeShape` rebuilds a sketch-backed output and
replays its supported retained operations. `recomputeSketchOutput` then finds
that output in the nested shape tree and rebuilds retained boolean ancestors.
This preserves atomic writes, but each new dependency relationship adds
another special case and ordering is implicit in recursive traversal.

The `.skf` project already persists sketch-source IDs, feature inputs, and
nested boolean-group membership. A separate persisted history format would
duplicate those inputs and require a migration without adding information the
recompute path needs today.

## Decision proposed

Build a transient directed acyclic graph from the loaded project for each
recompute request. Do not persist synthetic feature nodes or change the `.skf`
schema in this work.

- A sketch-source node produces its retained output shape.
- A retained operation on that shape is represented as an ordered feature step
  using the inputs already stored on the shape (draft settings, face-draft
  settings, treatment history, or revolve settings).
- A boolean-group node depends on each retained operand and produces the group
  output. Plain grouping remains a container and does not add a geometry step.
- Stable source IDs identify sketch inputs; shape IDs identify retained output,
  operation, and group nodes. Where a node needs a more specific ID, derive it
  from its owning shape ID and operation position rather than storing another
  identifier.

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
constructs the graph, schedules affected nodes, and returns either the complete
replacement project or a node-scoped failure. Keep CAD builders as internal
feature evaluators behind this interface. The engine transaction remains the
only place that writes the returned project.

## Consequences

- Existing project files remain readable and writable without a schema
  migration.
- Ordering and failure behavior become explicit and testable at one seam.
- A failed feature does not leave a partially recomputed tree.
- New retained feature types must provide their input dependencies and an
  evaluator; they do not add a new traversal branch at each caller.
- The graph is rebuilt per request. This favors correctness and locality over
  caching; caching can be considered only after profiling demonstrates a need.

## Validation required before acceptance

- Preserve every existing recompute test unchanged.
- Cover an unspecial-cased chain such as extrusion → prism draft → fillet →
  boolean → second boolean, asserting either correct recomputed geometry or an
  atomic failure that names the failed node.
- Cover deterministic ordering and cycle detection at the graph interface.
- Verify atomic failure by comparing the complete persisted project before and
  after a deliberately invalid downstream operation.

## Open question

This proposal treats the current shape tree and `.skf` feature inputs as the
canonical dependency record. If maintainers require arbitrary branching feature
history, independent feature editing, or persistent failed-node status, that
would require an explicit feature-node schema and a separate compatibility
decision before implementation.
