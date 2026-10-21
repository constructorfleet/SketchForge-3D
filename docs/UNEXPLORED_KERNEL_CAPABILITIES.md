# Implementation gaps and next steps

Status: refreshed against the working tree at `2cfc70a` (2026-10-20). This file
tracks user-facing gaps, not every unused OCCT method. Several proposals from
the earlier audit have shipped since it was written.

## Shipped since the earlier audit

These are implemented and should not be filed as missing features:

- Exact B-rep volume, surface area, centre of mass, and bounds are available
  through shape properties. Mesh-backed imports report tessellated precision.
- Interference checking is available through the engine and REST API, with an
  AABB candidate prefilter and bounded pair count; wall thickness is available
  as a sampled estimate with its sampling method disclosed.
- STEP assemblies can be exploded into separate solids, preserving product
  names and available XCAF colors, subject to limits of 200 solids and 8 MiB of
  source data. Assembly hierarchy is still flattened.
- Kernel-backed hidden-line projection, scene SVG, section SVG, and section DXF
  exports are implemented. DXF requires an explicit section plane.
- Baked mirrors, per-face color persistence, and per-triangle 3MF colors are
  implemented. Face colors are keyed to current face indexes and are discarded
  when geometry changes. The shape inspector can assign/remove them, though the
  viewport does not preview them yet.
- A bounded draft-prism operation is available over REST and in the TypeScript
  and Python clients. It accepts a retained straight, single-loop sketch
  extrusion and stores exact geometry; it has no editor control or editable
  feature-history node yet.

Relevant implementation seams include `serverCadProperties.ts`,
`serverCadInterference.ts`, `serverCadThickness.ts`, `serverStepExplode.ts`,
`serverCadProjection.ts`, and `serverCadSection.ts` in
`packages/sketchforge-engine/src/`.

## Remaining gaps

### 1. Sweep and broader draft modeling operations

The kernel exposes sweep operations, but SketchForge has no sweep workflow. The
new draft-prism operation is only available through REST and the client
libraries, and supports one straight closed sketch loop; it is not in the
editor, MCP, or an editable feature history. Next steps are editor access,
curved/multi-loop draft profiles, and a first planar sweep that reuses existing
sketch profiles. Arbitrary 3D paths and face-associated editable drafts need
additional model support.

### 2. STEP assembly hierarchy and color verification

Explosion now preserves XCAF product names and the per-component colors
available from the STEP reader, with inherited color fallback. The installed
kernel fixture does not round-trip explicit XCAF colors, so the positive color
path still needs verification with a representative real STEP file. The
operation refuses sources above 200 solids or 8 MiB. Nested assembly hierarchy
is still flattened into independent parts; representing it losslessly needs a
project-model decision.

### 3. Face-color preview and stable identity

The shape inspector now lets users add and remove face colors by the positional
indexes returned from `GET /faces`; the API persists them and 3MF exports them
per triangle. The viewport still does not preview those assignments because
its rendered triangles are not mapped to CAD face indexes. Geometry edits can
also invalidate positional indexes. A future persistent face identity model
and viewport mapping would make colors previewable and robust through topology
changes.

### 4. Geometric sketch constraints and a parametric feature tree

`SketchProfile` currently stores points, segments, and optional images; it has
no geometric constraints or dimensions. Sketches produce baked geometry rather
than a dependency-ordered feature history. This is a larger modeling and file
format change, so begin with a narrow sketch constraint model and solver for a
small set of constraints (for example coincident, horizontal/vertical, and
fixed distance), with deterministic under/fully constrained status and an
explicit unsatisfied-constraint result. Do not describe the full parametric
feature-tree workflow as supported until edits can recompute dependent features
and survive project round trips.

## Verification notes

The gap claims above were checked against the current engine modules, REST API,
client package, and editor source. The older version of this document described
mass properties, interference, wall thickness, projection, section DXF,
explosion, mirrors, and face-color storage as proposals; that status was no
longer accurate. Recheck limits and surface coverage against source before
raising them, especially for large STEP assemblies and offline/static builds.
