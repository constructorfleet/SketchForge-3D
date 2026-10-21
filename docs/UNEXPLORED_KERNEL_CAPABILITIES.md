# Implementation gaps and next steps

Status: refreshed against the working tree at `a0aa980` (2026-10-20). This file
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
- A bounded draft-prism operation is available in the shape inspector, over
  REST, and in the TypeScript and Python clients. The editor builds from a
  retained straight, single-loop sketch extrusion in its local CAD worker and
  stores exact geometry; the result is baked without an editable feature node.

Relevant implementation seams include `serverCadProperties.ts`,
`serverCadInterference.ts`, `serverCadThickness.ts`, `serverStepExplode.ts`,
`serverCadProjection.ts`, and `serverCadSection.ts` in
`packages/sketchforge-engine/src/`.

## Remaining gaps

### 1. Sweep and broader draft modeling operations

SketchForge has no general profile-along-path sweep workflow; its revolve and
helical revolve remain specialized sketch operations. Draft prism is available
in the editor, REST, and client libraries, but supports one straight closed
sketch loop and stores baked geometry without an editable feature-history node.
Next steps are curved or multi-loop draft profiles and a first planar sweep
that reuses existing sketch profiles. Arbitrary 3D paths and face-associated
editable drafts need additional model support.

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

`SketchProfile` now optionally stores coincident point pairs, horizontal or
vertical segments, and fixed point-to-point distances in millimeters. The
inspector adds and removes these constraints; point drags run a deterministic
local projection that anchors the dragged points, and the editor reports
unsatisfied constraint IDs. `.skf` round trips the declarations while older
profiles without them remain valid. Splitting a constrained line carries its
axis constraint to each resulting segment.

This is a first constraint milestone, not a full CAD solver. It does not report
degrees of freedom or provide a global nonlinear solve, and extrusion/revolve
still bake the resulting geometry instead of recomputing a dependency-ordered
feature tree. Those capabilities remain open work.

## Verification notes

The gap claims above were checked against the current engine modules, REST API,
client package, and editor source. The older version of this document described
mass properties, interference, wall thickness, projection, section DXF,
explosion, mirrors, and face-color storage as proposals; that status was no
longer accurate. Recheck limits and surface coverage against source before
raising them, especially for large STEP assemblies and offline/static builds.
