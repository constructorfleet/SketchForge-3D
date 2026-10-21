# Implementation gaps and next steps

Status: refreshed against `main` at `b831290` (2026-10-21). PR #142 added
independent cubic-Bezier handle depth to the 3D sweep path; PR #146 added a
local rank-based sketch constraint degree-of-freedom estimate; and PR #147
preserved STEP component colors in regular imports. These merged steps narrow
the sweep, sketch, and STEP gaps below but do not provide editable feature
history, assembly hierarchy, or a global constraint solver. This file tracks
user-facing gaps, not every unused OCCT method.

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
- Face-based drafting is available in the shape inspector for exact B-rep
  solids. It selects a face by the stable-ID-backed face listing, drafts along
  local CAD +Z, and replaces the selection with baked exact geometry. The
  resulting faces receive fresh IDs; face colors and edge-treatment metadata
  are cleared. Unsupported face/angle combinations return a localized error.
  Measured support is geometry-specific: the editor's XZ-profile, +Y
  extrusion fixture accepts faces 1, 3, 4, and 5 at ±5° along +Z; a 10 mm box
  accepts faces 0–3 at ±5° along +Z. These 36-case fixtures do not establish
  general support for arbitrary solids, other axes, or all draft angles.
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
workplane and draw exactly one open spine. Start the spine near the section
origin. Each section region is positioned at the spine's first point and
oriented perpendicular to its initial tangent; the spine may use line or cubic
Bezier segments, and OCCT uses rounded-corner transitions. Selecting a spine
point exposes a 3D depth offset along the section workplane's third axis, so
connected line and Bezier segments can leave the orthogonal sketch plane. Cubic
Bezier handles each expose an independent depth on that same workplane axis, so
the path can bend in 3D between its endpoints; handles without an explicit depth
inherit their endpoint's depth. The first segment must still start perpendicular
to the section plane. The editor retains the source sketch profile and marks
the result as a `sketch-sweep`, but the resulting geometry is baked rather than
represented by an editable feature-history node. This is a local editor
operation, not a REST or client-library operation.

Draft prism remains available in the editor, REST, and client libraries, but
supports one straight closed sketch loop, draft angles strictly between -45°
and 45° excluding zero, and stores baked geometry. Face-based drafting is now
available in the shape inspector with bounded, fixture-verified support: the
documented extrusion fixture accepts faces 1, 3, 4, and 5 at ±5° along +Z, and
a 10 mm box accepts faces 0–3 at ±5° along +Z. These cases do not establish
support for arbitrary solids, other pull axes, or all draft angles. More work
remains for broader face-draft support and dependency-ordered editable feature
history.

### 2. STEP assembly hierarchy and color verification

Explosion preserves XCAF product names and explicit per-component colors in a
generated STEP assembly fixture. When the installed XCAF label API does not
expose those colors, the server reads display materials from the XCAF
document's GLB export as a conservative fallback. A component receives a
GLB-derived color only when its name maps uniquely to one GLB node and one XCAF
leaf, any node and mesh names present agree, and every primitive has the same
explicit color. Ambiguous names or mixed/partial materials retain the inherited
or default color. Existing XCAF label colors and inherited parent colors take
precedence. Generated STEP fixtures verify component names and explicit XCAF
colors; constructed GLB payload tests verify the fallback's ambiguity and
material rules. Arbitrary external STEP variants still need representative
coverage. Regular STEP import now maps available explicit component colors to
stable face IDs on its combined mesh. The viewport displays those colors, and
the IDs and assignments persist with the project. Color extraction is bounded
to 200 solids and 8 MiB of source data; ambiguous coincident components and
unavailable or partial color metadata retain the default shape color. The
import remains one combined mesh rather than editable component objects. The
explode operation refuses sources above 200 solids or 8 MiB. Nested assembly
hierarchy is still flattened into independent parts. The current `occt-wasm` XCAF authoring API can create
only the single-level fixtures covered here: attempts to make a child component
a nested assembly fail, and compound-based exports round-trip as unnamed flat
leaves. A representative externally authored nested STEP fixture, plus a
project-model decision about editable assembly nodes, is required before
hierarchy preservation can be implemented and verified.

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

The inspector reports an estimated local degree-of-freedom count by subtracting
the numerical rank of the supported constraint equations' Jacobian from the
profile's editable scalar parameters. Duplicate or dependent equations count
only once. Bezier handle coordinates and sweep spine depths count as free
parameters because these constraints do not constrain them. At a zero-length
distance pair, the distance equation has no unique local direction, so the
report is indeterminate instead of presenting a misleading count. The
supported relations are translation-invariant, so even a fully constrained
relative layout retains two global translation freedoms.

This remains a local rank estimate at the current geometry, not a full CAD
solver: it does not prove global solvability, detect every nonlinear or
second-order dependency, move geometry to satisfy constraints, or provide a
global nonlinear solve. Extrusion/revolve still bake the resulting geometry
instead of recomputing a dependency-ordered feature tree. Those capabilities
remain open work.

## Verification notes

The shipped claims and remaining gaps above were rechecked against `main` at
  `b831290`, including the engine modules, REST API, client package, project
serialization, and editor source. The remaining items are limits in the
current model or workflows, not unused kernel calls. Recheck limits and surface
coverage before raising them, especially for large STEP assemblies and
offline/static builds.
