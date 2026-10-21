# Implementation gaps and next steps

Status: refreshed against the working tree at `e699b20` (2026-10-20). This file
tracks user-facing gaps, not every unused OCCT method. Several proposals from
the earlier audit have shipped since it was written.

## Shipped since the earlier audit

These are implemented and should not be filed as missing features:

- Exact B-rep volume, surface area, centre of mass, and bounds are available
  through shape properties. Mesh-backed imports report tessellated precision.
- Interference checking is available through the engine and REST API, with an
  AABB candidate prefilter and bounded pair count; wall thickness is available
  as a sampled estimate with its sampling method disclosed.
- STEP assemblies can be exploded into separate solids, subject to limits of
  200 solids and 8 MiB of source data.
- Kernel-backed hidden-line projection, scene SVG, section SVG, and section DXF
  exports are implemented. DXF requires an explicit section plane.
- Baked mirrors, per-face color persistence, and per-triangle 3MF colors are
  implemented. Face colors are keyed to current face indexes and are discarded
  when geometry changes.

Relevant implementation seams include `serverCadProperties.ts`,
`serverCadInterference.ts`, `serverCadThickness.ts`, `serverStepExplode.ts`,
`serverCadProjection.ts`, and `serverCadSection.ts` in
`packages/sketchforge-engine/src/`.

## Remaining gaps

### 1. Sweep and draft modeling operations

The kernel exposes sweep and draft operations, but SketchForge does not yet
offer them as user-facing modeling operations. A useful first increment should
reuse existing sketch profiles and persist enough operation data to rebuild the
result. Prefer a simple planar sweep or draft-on-extrusion before introducing
arbitrary 3D paths or face-associated editable features. Keep geometry
rebuild/refusal behavior consistent across the editor, Engine, REST API, and MCP
surfaces that support the operation.

### 2. STEP assembly names, colors, and hierarchy

Explosion currently creates numbered children and inherits the parent
appearance. It does not preserve component names, per-component colors, or the
STEP assembly hierarchy. The operation also refuses sources above 200 solids or
8 MiB. Use STEP/XCAF labels to map names and colors to solids; treat nested
assembly structure as a separate format decision if it cannot be represented by
the existing groups without loss.

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
