# Implementation gaps and next steps

This inventory summarizes verified user-facing behavior and durable capability
limits. It is reconciled against the implementation and focused tests; PR and
release state are tracked in GitHub. The remaining gaps are ranked by product
value and implementation dependency, not by unused OCCT API surface.

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
  `POST /explode` produces independently selectable top-level solids. When a
  solid can be associated unambiguously, it retains `stepComponent` source
  occurrence identity and root-to-component ancestry, which survives `.skf`
  round trips. Ambiguous associations omit ancestry rather than guessing.
  Exploded parts remain top-level project shapes; arbitrary nested groups and
  source assembly transforms are not reconstructed as editable project groups.
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
  along +Z; a +90° Y-rotated fixture accepts face 0 at ±30° along +X; and a
  -90° X-rotated fixture accepts face 2 at +10° along +Y. These are narrow
  cases, not broad support for other faces, solids, or angles. Unsupported
  combinations return a localized error. Draft output is baked, gets fresh
  face IDs, and clears face colors and edge-treatment metadata.
- The Sketch workspace supports planar sweeps with one or more closed section
  loops and one open spine on the derived orthogonal plane. Nested section
  loops become holes; disjoint loops become separate solids. Spine points and
  cubic Bezier handles can move along the section plane's third axis, with
  independent handle depths. The editor retains the source profile for
  reopening and editing. `POST /shapes` accepts `kind: "sketchSweep"`; the
  engine and TypeScript and Python clients can create sweeps and replace
  `sketchProfile` through `PATCH /api/v1/shapes`, rebuilding geometry while
  retaining shape and source IDs. `PATCH /shapes` can target a sketch sweep by
  its persisted `sketchSourceId` or by output shape ID; it updates the source
  profile and rebuilds its dependent sweep before writing the project. Invalid
  profiles leave the persisted source and sweep unchanged. A profile rebuild
  receives fresh face IDs
  and drops face colors and edge-treatment metadata because old faces cannot
  be assumed to correspond to the new profile.
- `.skf` stores source-sketch nodes and feature inputs for sketch extrusions,
  revolves, and sweeps. The source profiles and operation parameters survive
  project round trips; profile edits in the editor rebuild the corresponding
  solid while retaining its shape and source identity. These operations do
  not yet participate in a general downstream recompute graph.
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

## Remaining gaps, ranked

### 1. Dependency-ordered parametric recomputation

Sketch extrusion, revolve, and sweep persist source sketches and operation
parameters; `.skf` also records dependency links for sketch outputs and boolean
groups. Runtime recomputation is still narrow: editing a sketch-backed sweep
now rebuilds it inside retained boolean groups, bottom-up, and writes the
updated result atomically. Invalid sketches or failed dependent booleans leave
the project unchanged. Extrusion/revolve descendants, drafts, and other
operation types do not yet recompute, and draft prism/face draft remain baked
rather than editable feature nodes. A general dependency-ordered graph with
consistent failure propagation remains the highest-value foundation before
expanding editable downstream operations.

### 2. Broader and editable drafting

Face drafting is selectable along local X, Y, or Z, but verification covers
only the fixture/face/angle combinations listed above. Other face orientations,
solid classes, and angle ranges are unverified or may be rejected by the
kernel. Both draft-prism and face-draft results are baked; neither can be
reopened as an editable operation or recomputed after its source changes.
Broader fixture coverage should establish the supported geometric envelope;
editable draft history depends on the feature-recompute work in gap 1.

### 3. Editable STEP assembly hierarchy and robust component association

The engine retains source occurrence IDs and ancestry on exploded solids when
association is unambiguous, and persists that metadata through `.skf`. The
identifiers describe a particular STEP source and may change when the source
file or product structure changes. Exploded parts are top-level project shapes:
nested assembly groups, arbitrary source transforms, and hierarchy-preserving
editing/export are not implemented. Some source trees also cannot be
associated reliably with imported solids, so those solids have no
`stepComponent` ancestry. Full assembly editing depends on representing nested
groups and transforms in the project model; improving identity matching alone
does not provide that behavior.

### 4. Stable face identity across arbitrary topology changes

Stable IDs and color assignments survive shape-parameter edits and supported
CAD treatments when the engine finds a unique match. Matching uses exact face
B-rep or a unique planar support surface; it is not a semantic identity
contract. Split, merged, generated, or otherwise ambiguous faces receive new
IDs without inherited assignments. General identity across arbitrary topology
edits remains unsupported.

### 5. Broader sketch constraints and globally determined solutions

The solver supports coincident, horizontal, vertical, and fixed-distance
relations with a bounded deterministic least-squares solve and a local
Jacobian-rank estimate. It does not guarantee global solvability, identify
every nonlinear or second-order dependency, or remove the two global
translation freedoms. Degenerate zero-length distance geometry has no
determinate degree-of-freedom report. Additional constraint types and a solver
that can robustly determine global placement remain open.

## Verification baseline

Focused coverage includes sweep creation and profile rebuilding
(`tests/e2e/sketchCadSweep.e2e.ts`, `tests/e2e/restApi.e2e.ts`,
`tests/unit/apiV1ShapeRoundTrip.test.ts`), sketch source and feature persistence
(`tests/unit/skfProject.test.ts`), STEP hierarchy and component persistence
(`tests/unit/serverStepExplode.test.ts`,
`tests/unit/stepAssemblyProject.test.ts`), face-ID matching
(`tests/unit/apiV1FaceIdentity.test.ts`), face-draft axis cases
(`tests/e2e/draftFaceEditor.e2e.ts`), and sketch constraints
(`tests/unit/sketchConstraints.test.ts`). These tests establish specific
supported cases; they do not establish general kernel coverage beyond those
cases. Recheck limits and surface coverage before raising them, especially for
large STEP assemblies and static/offline builds.
