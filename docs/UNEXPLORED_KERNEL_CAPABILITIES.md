# Implementation gaps and next steps

Status: refreshed against `main` at `aae1285` (2026-10-21). PR #142 added
independent cubic-Bezier handle depth to the 3D sweep path; PR #146 added a
local rank-based sketch constraint degree-of-freedom estimate; and PR #147
preserved STEP component colors in regular imports. These merged steps narrow
the sweep, sketch, and STEP gaps below but do not provide editable feature
history and assembly hierarchy. Merged PR #153 adds a bounded deterministic
least-squares solve for supported coupled constraints. It is a local bounded
solver, not a symbolic or global guarantee. This file tracks
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
workplane and draw exactly one open spine. The new spine's first point snaps to
the section origin. Each section region is positioned at that point and oriented
perpendicular to its initial tangent; the first segment must begin perpendicular
to the section plane. The spine may use line or cubic
Bezier segments, and OCCT uses rounded-corner transitions. Selecting a spine
point exposes a 3D depth offset along the section workplane's third axis, so
connected line and Bezier segments can leave the orthogonal sketch plane. Cubic
Bezier handles each expose an independent depth on that same workplane axis, so
the path can bend in 3D between its endpoints; handles without an explicit depth
inherit their endpoint's depth. The editor retains the source sketch profile,
which remains editable, and marks the result as a `sketch-sweep`. The result is
not a rebuildable, dependency-tracked feature-history node. This is a local
editor operation, not a REST or client-library operation.

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
coverage. Regular STEP import maps available component colors, using
explicit/inherited XCAF colors and the conservative GLB fallback described
above, to app-owned face IDs on its combined mesh. These IDs persist with the
imported shape, and color assignments persist with the project; IDs are not
deterministic across a fresh re-import. The viewport displays the mapped colors.
Extraction is bounded to 200 solids and
8 MiB of source data; ambiguous coincident components or a component without a
usable color retain the default shape color while other components can still
receive colors. The import remains one combined mesh rather than editable
component objects. The explode operation refuses sources above 200 solids or
8 MiB. Nested assembly hierarchy is still flattened into independent parts.
The current `occt-wasm` XCAF authoring API has only been verified with
single-level fixtures; nested authoring attempts have failed, and compound-
based exports round-trip as unnamed flat leaves. A representative externally
authored nested STEP fixture, plus a project-model decision about editable
assembly nodes, is required before hierarchy preservation can be implemented
and verified.

### 3. Stable face identity and broader preview mapping

**Implemented:** `GET /faces` returns an ID and index. If IDs have not been
materialized on the shape, the response derives them from the shape ID and
current face index; listing alone does not persist them, so stability depends
on face ordering until a color update or CAD operation stores IDs. Face colors
are keyed by ID and persisted in `.skf`. Viewport face-color mapping applies to
shapes with stored imported-mesh face groups; 3MF triangle mapping uses those
IDs. Unambiguous unchanged faces retain their colors through supported CAD
treatments such as fillet, chamfer, shell, and mirror; split, merged, generated,
or otherwise ambiguous faces do not inherit assignments. Draft prism assigns
fresh IDs to every result face and drops prior colors. Numeric keys remain
supported for existing projects and clients.

**Remaining:** Stable semantic identity across arbitrary topology edits is not
guaranteed. Ordinary shape-parameter edits also clear face IDs and colors, even
when some geometry may be unchanged. The kernel may not provide useful
correspondence for every operation, and geometry signatures are only a
best-effort match. Unsupported or ambiguous correspondences receive fresh IDs
and no inherited color. The ID-to-triangle mapping has focused tests, but lacks
a full scene-export color regression test.

### 4. Geometric sketch constraints and a parametric feature tree

`SketchProfile` now optionally stores coincident point pairs, horizontal or
vertical segments, and fixed point-to-point distances in millimeters. The
inspector adds and removes these constraints; point drags run a bounded
deterministic damped least-squares solve that anchors the dragged points, and
the editor reports unsatisfied constraint IDs. `.skf` round trips the declarations while older
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
relative layout retains two global translation freedoms. The degree-of-freedom
estimate is a local rank estimate, not a solvability test.

The estimate does not prove global solvability or detect every nonlinear or
second-order dependency. The drag solver is a bounded local damped least-squares
solve; incompatible equations, singular systems, or iteration limits can leave
unsatisfied constraint IDs, which the editor reports. It is not a symbolic or
globally guaranteed CAD solver. Extrusion/revolve still bake the resulting
geometry instead of recomputing a dependency-ordered feature tree. Editable
feature history remains open work.

## Verification notes

The shipped claims and remaining gaps above were rechecked against `main` at
`aae1285`, including the engine modules, REST API, client packages, project
serialization, and editor source. The remaining items are limits in the
current model or workflows, not unused kernel calls. Recheck limits and surface
coverage before raising them, especially for large STEP assemblies and
offline/static builds.
