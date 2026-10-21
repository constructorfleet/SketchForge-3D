# Implementation gaps and next steps

Status: refreshed against `main` at `efd3ef6` and the verified changes in this
branch (2026-10-20). This file tracks user-facing gaps, not every unused OCCT
method.

## Shipped since the earlier audit

These are implemented and should not be filed as missing features:

- Exact B-rep volume, surface area, centre of mass, and bounds are available
  through shape properties. Mesh-backed imports report tessellated precision.
- Edge and face measurements, plus minimum distances and planar-face angles
  between entities, are exposed through `/measurements` and the TypeScript and
  Python clients. Values use the kernel representation; mesh imports remain
  limited to their tessellated geometry, and undefined measurements include a
  reason.
- Interference checking is available through the engine and REST API, with an
  AABB candidate prefilter and bounded pair count; wall thickness is available
  as a sampled estimate with its sampling method disclosed.
- STEP assemblies can be exploded into separate solids, preserving product
  names and available XCAF colors, subject to limits of 200 solids and 8 MiB of
  source data. Assembly hierarchy is still flattened.
- Kernel-backed hidden-line projection, scene SVG, section SVG, and section DXF
  exports are implemented. DXF requires an explicit section plane.
- Baked mirrors, per-face color persistence, and per-triangle 3MF colors are
  implemented. `GET /faces` exposes stable application-owned IDs alongside
  compatibility indexes; colors use those IDs and survive project round trips.
  Unchanged faces retain IDs through CAD treatments when the kernel result can
  be matched unambiguously; new or ambiguous faces receive new IDs without
  inherited colors. Viewport and 3MF previews map B-rep triangle groups to the
  same identities. Numeric face indexes remain supported for older projects
  and callers.
- A bounded draft-prism operation is available in the shape inspector, over
  REST, and in the TypeScript and Python clients. The editor builds from a
  retained straight, single-loop sketch extrusion in its local CAD worker and
  stores exact geometry; the result is baked without an editable feature node.
- OBJ import is supported alongside STL, SVG, and STEP, and imported source
  assets are preserved in `.skf` projects.
- Camera view orientation, target, and zoom are saved with the project and
  restored when it is reopened. Older projects without camera data retain the
  default view.
- Server-side project reads regenerate source-backed STEP meshes with the
  server kernel, so STEP imports can reopen from server-backed storage.

Relevant implementation seams include `serverCadProperties.ts`,
`serverCadMeasure.ts`, `serverCadInterference.ts`, `serverCadThickness.ts`,
`serverStepExplode.ts`, `serverCadProjection.ts`, and `serverCadSection.ts` in
`packages/sketchforge-engine/src/`.

## Remaining gaps

### 1. Sweep and broader draft modeling operations

The Sketch workspace has a planar sketch sweep alongside extrusion and
revolve. The workflow has two stages: draw one or more closed section loops on
the selected workplane (nested loops become holes and disjoint loops become
separate swept solids), then switch to the orthogonal plane derived from that
workplane and draw exactly one open, planar spine. Start the spine near the
section origin. Each section region is positioned at the spine's first point
and oriented perpendicular to its initial tangent; the spine may use line or
cubic Bezier segments, and OCCT uses rounded-corner transitions. The editor
retains the source sketch profile and marks the result as a `sketch-sweep`, but
the resulting geometry is baked rather than represented by an editable
feature-history node. This is a local editor operation, not a REST or
client-library operation.

Draft prism remains available in the editor, REST, and client libraries, but
supports one straight closed sketch loop and also stores baked geometry. More
work remains for arbitrary 3D sweep paths, face-based drafting, and
dependency-ordered editable feature history.

### 2. STEP assembly hierarchy and color verification

Explosion preserves XCAF product names and explicit per-component colors in a
generated STEP assembly fixture. When the installed XCAF label API does not
expose those colors, the server reads the display materials from the XCAF
document's GLB export and matches them to named component labels. Existing
XCAF label colors and inherited parent colors take precedence. This verifies
the generated fixture path; arbitrary external STEP variants still need
representative coverage. Regular STEP import still creates a combined mesh
with the default color, and does not preserve assembly component colors. The
operation refuses sources above 200 solids or 8 MiB. Nested assembly hierarchy
is still flattened into independent parts. The current `occt-wasm` XCAF
authoring API can create only the single-level fixtures covered here: attempts
to make a child component a nested assembly fail, and compound-based exports
round-trip as unnamed flat leaves. A representative externally authored nested
STEP fixture, plus a project-model decision about editable assembly nodes,
is required before hierarchy preservation can be implemented and verified.

### 3. Stable face identity and broader preview mapping

**Implemented:** `GET /faces` returns app-owned IDs plus compatibility indexes;
face colors are keyed by ID and persisted in `.skf`. Viewport and 3MF mapping
use those IDs for STEP-imported and other B-rep-backed shapes. Unambiguous
unchanged faces retain their colors through supported CAD treatments; split,
merged, generated, or otherwise ambiguous faces do not inherit assignments.
Numeric keys remain supported for existing projects and clients.

**Remaining:** Stable semantic identity across arbitrary topology edits is not
guaranteed. The kernel may not provide useful correspondence for every
operation, and geometry signatures are only a best-effort match. Unsupported
or ambiguous correspondences receive fresh IDs and no inherited color.

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
client package, project serialization, and editor source. The remaining items
are limits in the current model or workflows, not unused kernel calls. Recheck
limits and surface coverage before raising them, especially for large STEP
assemblies and offline/static builds.
