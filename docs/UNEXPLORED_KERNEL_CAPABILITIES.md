# Implementation gaps and next steps

Status: shipped capabilities verified against `origin/main` at `1c8e820`
(2026-10-21), including PR #180's fixture-tested +X and +Y face-draft cases.
The open PR #168 branch also carries proposed revolve-source persistence
(#181) and STEP component ancestry (#183); those changes are not on `main`.
Open PR #188, stacked on #168, proposes sweep-source persistence. This file
tracks user-facing capability limits, not every unused OCCT method.

## Shipped capabilities

These are implemented and should not be filed as missing features:

- Exact B-rep volume, surface area, centre of mass, and bounds are available
  through shape properties. Mesh-backed imports report tessellated precision.
- Edge and face measurements, minimum distances, and planar-face angles
  between entities are exposed through `/measurements` and the TypeScript and
  Python clients. Mesh imports remain limited to their tessellated geometry,
  and unavailable measurements include a reason.
- Interference checking is available through the engine and REST API, with an
  AABB candidate prefilter and bounded pair count. Wall thickness is available
  as a sampled estimate with its sampling method disclosed.
- STEP imports can expose bounded product names and nested `stepAssembly`
  hierarchy metadata in shape summaries. Extraction is limited to inputs up to
  200 solids and 8 MiB, with at most 2,000 hierarchy nodes and depth 32.
  `POST /explode` produces independently selectable top-level solids. On
  `main`, exploded shapes do not retain source occurrence IDs or ancestry
  metadata. Nested assembly groups and transforms are not reconstructed as
  editable project groups.
- Kernel-backed hidden-line projection, scene SVG, section SVG, and section
  DXF exports are implemented. DXF requires an explicit section plane.
- Baked mirrors, per-face color persistence, and per-triangle 3MF colors are
  implemented. `GET /faces` exposes stable application-owned IDs alongside
  compatibility indexes; colors use those IDs and survive project round
  trips. IDs and colors survive shape-parameter edits and supported CAD
  treatments when faces can be matched uniquely. New or ambiguous faces get
  fresh IDs and do not inherit colors. Viewport and 3MF previews map B-rep
  triangle groups to the same identities. Numeric face indexes remain
  supported for older projects and callers.
- A bounded draft-prism operation is available in the shape inspector, over
  REST, and in the TypeScript and Python clients. It accepts a retained
  straight, single-loop sketch extrusion and stores exact geometry; the result
  is baked without an editable draft-feature node.
- Face-based drafting is available in the shape inspector for exact B-rep
  solids, with a selectable local CAD pull axis. Measured support remains
  geometry-specific: the documented XZ-profile, +Y extrusion fixture accepts
  faces 1, 3, 4, and 5 at ±5° along +Z; a 10 mm box accepts faces 0–3 at ±5°
  along +Z. PR #180 also verifies face 0 at ±30° along +X on a +90° Y-rotated
  fixture, and face 2 at +10° along +Y on a -90° X-rotated fixture. These are
  narrow cases, not broad support for other faces, solids, or angles.
  Unsupported face/angle/axis combinations return a localized error. Draft
  output is baked, gets fresh face IDs, and clears face colors and
  edge-treatment metadata.
- The Sketch workspace supports planar sweeps with one or more closed section
  loops and one open spine on the derived orthogonal plane. Nested section
  loops become holes; disjoint loops become separate solids. Spine points and
  cubic Bezier handles can move along the section plane's third axis, with
  independent handle depths. The editor retains the source profile for
  reopening and editing. `POST /shapes` also accepts `kind: "sketchSweep"`;
  the engine, TypeScript client, and Python client expose sweep creation and
  preserve the returned profile. The API has no dedicated profile-edit/rebuild
  request. The `.skf` feature index records sweeps, but sweeps do not yet have
  a separate source-sketch dependency node on `main`.
- `.skf` stores a separate source-sketch node and explicit feature input for
  sketch extrusions. Editing the profile keeps source and output identities
  while rebuilding its solid. Revolves and sweeps do not yet have this
  persisted source-sketch dependency on `main`.
- Coincident, horizontal, vertical, and fixed-distance sketch constraints are
  supported. Point drags use a deterministic, bounded damped least-squares
  solve for supported coupled constraints, keep directly dragged points
  anchored, and report unsatisfied constraint IDs. The inspector also reports
  an estimated local degree-of-freedom count from the supported equations'
  Jacobian rank.
- OBJ import is supported alongside STL, SVG, and STEP, and imported source
  assets are preserved in `.skf` projects.
- Camera view orientation, target, and zoom are saved with the project and
  restored when it is reopened. Older projects without camera data retain the
  default view.
- Server-side project reads regenerate source-backed STEP meshes with the
  server kernel, so STEP imports can reopen from server-backed storage.

Relevant implementation seams include `serverCadProperties.ts`,
`serverCadMeasure.ts`, `serverCadInterference.ts`, `serverCadThickness.ts`,
`serverStepExplode.ts`, `stepAssemblyHierarchy.ts`, `serverCadProjection.ts`,
and `serverCadSection.ts` in `packages/sketchforge-engine/src/`.

## Remaining gaps

### 1. General editable feature history and broader draft operations

On `main`, sketch extrusion is the only operation with a separate persisted
source-sketch node and feature input. Open PR #181, carried on the #168 branch,
proposes the equivalent source and edit/rebuild slice for revolves. Open PR
#188 proposes a persisted sweep source node and feature input, preserving
source identity when the editor rebuilds an edited sweep. The REST API can
create and read sweeps but still has no operation to update a sweep profile and
rebuild it. Draft operations replace selected geometry with baked results.
These source links do not yet make a general dependency-ordered feature tree:
upstream changes are not recomputed through booleans, drafts, or other
downstream operations.

Face draft accepts a chosen local CAD axis in the inspector. Fixtures verify
+Z cases at ±5° for the documented extrusion and box face sets, plus one +X
face at ±30° and one +Y face at +10° on physically rotated extrusion
fixtures. Arbitrary solids, other faces, and broader angle support remain
unverified; a selectable axis is not evidence that every combination works.

### 2. Editable STEP components and assembly operations

Nested STEP product names and parent/child relationships are available as
bounded `stepAssembly` metadata. On `main`, `POST /explode` creates independently
selectable and movable top-level shapes without retaining source occurrence
identity on each result. PR #183, carried on the #168 branch, proposes
`stepComponent` metadata with a source occurrence ID and root-to-leaf ancestry
path, persisted through `.skf` round trips when matching is unambiguous; this
proposal is not merged to `main`. Neither the shipped behavior nor that proposal
reconstructs nested groups or source assembly transforms as editable project
objects. Assembly authoring, per-component operations within the hierarchy,
and hierarchy-preserving export remain open. Metadata extraction remains
bounded to 200 solids, 8 MiB, 2,000 nodes, and depth 32; STEP writers with
unsupported or ambiguous product metadata may omit the tree.

### 3. Stable face identity across arbitrary topology changes

Stable IDs and color assignments survive shape-parameter edits and supported
CAD treatments when the engine finds a unique match. Matching uses exact face
B-rep or a unique planar support surface; it is not a semantic identity
contract. Split, merged, generated, or otherwise ambiguous faces receive new
IDs without inherited assignments. General identity across arbitrary topology
edits remains unsupported.

### 4. Global sketch solving and complete parametric modeling

The supported sketch constraints now use a bounded deterministic
least-squares solve, and the inspector provides a local Jacobian-rank estimate.
The supported relations remain coincident, horizontal, vertical, and fixed
distance. The solver does not guarantee global solvability, identify every
nonlinear or second-order dependency, or eliminate the two global translation
freedoms. Degenerate zero-length distance geometry has no determinate DOF
report. Sketch revolve, sweep, draft, and downstream feature operations do not
yet form a general recomputing dependency graph with sketch extrusion.

## Verification baseline

The shipped baseline was checked against `origin/main` at `1c8e820`; proposed
claims were checked against the #168 and #188 branches and their focused tests.
Coverage on `main` includes sweep API/client creation, extrusion source-sketch
serialization, STEP hierarchy metadata, face-ID matching, face-draft axis
cases, and sketch constraints. Relevant focused coverage includes
`tests/e2e/sketchCadSweep.e2e.ts`, `tests/e2e/restApi.e2e.ts`,
`tests/unit/skfProject.test.ts`, `tests/e2e/stepImportKernel.e2e.ts`,
`tests/unit/stepAssemblyProject.test.ts`, `tests/unit/apiV1FaceIdentity.test.ts`,
`tests/e2e/draftFaceEditor.e2e.ts`, and the sketch-constraint tests. These
tests define specific supported cases; they do not establish general kernel
coverage beyond those cases. Recheck limits and surface coverage before
raising them, especially for large STEP assemblies and static/offline builds.
