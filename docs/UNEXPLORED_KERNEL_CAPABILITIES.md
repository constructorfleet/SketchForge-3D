---
slug: "/docs/UNEXPLORED_KERNEL_CAPABILITIES"
title: "Implementation gaps and next steps"
audience: "Contributors"
owner: "Engine"
---

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
  `POST /explode` rebuilds nested editable project groups when every exact
  solid maps unambiguously to a source occurrence using the imported GLB
  geometry and source hierarchy. Otherwise it falls back to independently
  selectable flat solids. Leaf solids retain project-space placement,
  `stepComponent` occurrence identity, and root-to-component ancestry through
  `.skf` round trips. STEP export writes grouped project parts under a single
  assembly level, encoding nested group paths in product names; on reimport,
  those names can reconstruct nested groups when solid-to-occurrence matching
  is unambiguous. Native nested STEP hierarchy export and STEP transform
  editing are not implemented.
- Kernel-backed hidden-line projection, scene SVG, section SVG, and section
  DXF exports are implemented. DXF requires an explicit section plane.
- Baked mirrors, per-face color persistence, and per-triangle 3MF colors are
  implemented. `GET /faces` exposes stable application-owned IDs alongside
  compatibility indexes; colors use those IDs and survive project round
  trips. IDs and colors survive shape-parameter edits and supported CAD
  treatments when faces can be matched uniquely. For parameter edits, uniquely
  occurring cones, spheres, tori, and cylinders can retain identity when their
  sampled normal changes; repeated curved surfaces remain unmatched. Fillet
  and symmetric-chamfer operations use OCCT face history for unique
  one-to-one modified faces. New, generated, or ambiguous faces get fresh IDs
  and do not inherit colors. Viewport and 3MF
  previews map B-rep triangle groups to the same identities. Numeric face
  indexes remain supported for older projects and callers.
- A bounded draft-prism operation is available in the shape inspector, over
  REST, and in the TypeScript and Python clients. It accepts a retained
  straight, single-loop sketch extrusion and stores exact geometry plus its
  angle and original extrusion frame/height. `changeShape` can update the angle
  by `sketchSourceId`; source profile edits reapply the draft and recompute
  retained boolean ancestors atomically.
- Face-based drafting is available in the shape inspector for exact B-rep
  solids, with a selector for all six signed local CAD pull axes. The engine
  canonicalizes the selected direction before invoking the kernel and maps the
  result back to the original orientation. Measured support is geometry-
  specific: on the unrotated editor-plane extrusion, faces 0, 2, 4, and 5 are
  verified at ±5° along +X; faces 0–3 at ±5° along +Y; and faces 1, 3, 4, and
  5 at ±5° along +Z. A +90° Y-rotated fixture accepts face 0 at ±30° along
  +X, and a -90° X-rotated fixture accepts face 2 at +10° along +Y. On a
  10 mm box, faces 0–3 are verified at ±5° and ±30° along +Z and -Z; face 2
  at +5° along +X; face 0 at +5° and +30° along -X; and face 2 at +5° and
  +30° along -Y. The box face 0/+5°/+X case is rejected because the pull axis
  is parallel to that face. These are measured cases, not broad support for
  other faces, solids, or angles. Other unsupported combinations return a
  localized error. The editor's arbitrary-shape draft remains baked. The
  engine/API can retain one face draft on a sketch extrusion, single-solid
  sketch sweep, or plain single-region full-turn sketch revolve. Revolves use
  `GET /faces?topology=exact` so analytic face selection does not change the
  default tessellated listing or its compatibility indexes. It stores the
  selected source face ID, signed pull axis, angle, unique planar-normal
  matching evidence, original source frame, and resized revolve scale. Source edits replay that draft
  only when exactly one planar face matches; missing or ambiguous matches and
  failed dependent booleans roll back atomically. Partial-turn, helical, and
  multi-region revolve drafts are refused. A plain single-region full-turn
  sketch revolve may retain one face draft followed by either one symmetric
  45° all-edge chamfer or one all-edge fillet; profile and setting edits replay
  source, draft, then treatment atomically. Adding a second treatment, a prism
  draft, or a shell to a face-drafted shape remains refused before writing.
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
  receives fresh face IDs and drops face colors because old faces cannot be
  assumed to correspond to the new profile. One supported all-edge fillet or
  symmetric 45° chamfer is replayed against rebuilt topology; unsupported or
  ambiguous treatment histories fail the edit atomically.
- `.skf` stores source-sketch nodes and feature inputs for sketch extrusions,
  revolves, sweeps, and boolean groups. Source profiles, operation parameters,
  and dependency links survive project round trips. Profile edits rebuild the
  corresponding solid while retaining its shape and source identity. Editing a
  sketch-backed extrusion or sweep through its persisted source ID also
  recomputes retained boolean ancestors bottom-up, preserving output IDs and
  placement and writing the new source and dependent geometry atomically. A
  source-driven revolve profile or operation-setting edit (for example, its
  side count) follows the same bottom-up rebuild and atomic-write path.
  A sketch extrusion, sweep, or revolve with one persisted all-edge fillet
  replays that fillet after a source-profile edit against rebuilt topology,
  without carrying edge indices across the edit. One persisted symmetric 45°
  all-edge chamfer now follows the same replay path on those source kinds, with
  treatment history and the current eligible-edge count rebuilt from new
  topology. Plain full-turn revolve chamfers are rebuilt from the retained
  profile as exact CAD geometry and currently require exactly one closed
  profile region; partial-turn, helical, and multi-region revolve chamfers are
  refused. Revolve setting edits also attempt replay and roll back if the new
  topology cannot accept the treatment. Selected-edge treatments, non-45°
  chamfers, multiple treatment steps, draft/treatment combinations outside
  the supported order below, and treatments on other source operation types
  remain unsupported. One retained
  prism draft followed by one all-edge fillet or symmetric 45° chamfer is now
  supported on a sketch extrusion; source-profile and draft-angle edits replay
  the draft first and treatment second, refreshing history and eligible-edge
  counts. Adding a prism draft after a treatment, selected-edge treatments,
  multiple treatments, and combinations on other source kinds remain
  unsupported.
  Invalid source profiles and dependent booleans that no longer remove
  material leave the project unchanged. Other downstream operation types do
  not yet participate in a general recompute graph.
- Coincident, horizontal, vertical, perpendicular, parallel, fixed-distance,
  and fixed-point sketch constraints are supported, including `.skf`
  persistence and TypeScript profile types. A fixed point anchors a sketch
  point to workplane coordinates and can remove global translation freedoms.
  Perpendicular and parallel relations take part in the bounded coupled solve
  and local degree-of-freedom estimate. Point drags keep directly dragged
  points anchored and report unsatisfied constraint IDs. The inspector also
  estimates local degrees of freedom from the supported equations' Jacobian
  rank.
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
groups. Runtime recomputation remains narrow: editing a sketch-backed extrusion
or sweep rebuilds it inside retained boolean groups, bottom-up, and writes the
updated result atomically; source-ID edits to revolve profiles and operation
settings such as side count follow the same path.
Invalid profiles or failed dependent booleans leave the project unchanged.
Draft prism angles on sketch extrusions now participate in this bounded path:
their persisted source angle, source height, and source frame are reapplied
when the source profile changes, and the angle itself can be changed by source
ID. A single retained face draft on a sketch extrusion, single-solid sketch
sweep, or plain single-region full-turn sketch revolve now recomputes when its
selected planar face has exactly one normal match; missing or ambiguous matches
fail atomically. `GET /faces?topology=exact` lists analytic B-rep revolve faces;
the default face listing remains mesh-based. Other downstream operation types do not yet recompute. A
general dependency-ordered graph with consistent failure propagation remains
the highest-value foundation before expanding editable downstream operations.

### 2. Broader and editable drafting

Face drafting is selectable along local X, Y, or Z, but verification covers
only the fixture/face/angle combinations listed above. Other face orientations,
solid classes, and angle ranges are unverified or may be rejected by the
kernel. The editor's general face-draft results remain baked. The engine/API
retains one editable face draft on a sketch extrusion, single-solid sketch
sweep, or plain single-region full-turn sketch revolve, replaying it after a
source edit only when exactly one planar face matches the stored local normal;
it refuses missing or ambiguous matches. One symmetric 45° all-edge chamfer
or one all-edge fillet may follow a face draft only on a plain single-region
full-turn sketch revolve; profile or setting edits replay the revolve, face
draft, then treatment atomically and refresh treatment history and eligible-edge
counts. `.skf` round trips preserve this supported sequence and allow replay
after import. Face drafts still cannot combine with prism drafts or shelling,
and other face-draft / treatment sequences remain refused. A retained prism draft on a sketch
extrusion can be followed by one all-edge fillet or symmetric 45° chamfer;
source-profile and draft-angle edits replay the draft before the treatment.
Adding a prism draft after an edge treatment remains refused, as do
selected-edge or multiple treatments on a drafted extrusion. Shelling remains
refused when persisted draft or treatment
metadata exists. Updating angle or axis keeps the same source face ID; clear the
draft before selecting another face. This bounded support does not define
semantic lineage across arbitrary topology changes. Prism drafts are editable
only as a retained angle on a straight, single-loop sketch extrusion. The
editor does not yet create or edit the persisted face-draft feature; its
arbitrary-shape results remain baked. Other draft operations and general
editable draft history remain unsupported. Broader fixture coverage should
establish the supported geometric envelope.

### 3. Editable STEP assembly hierarchy and robust component association

The engine retains source occurrence IDs and ancestry on exploded solids when
association is unambiguous, and persists that metadata through `.skf`. The
identifiers describe a particular STEP source and may change when the source
file or product structure changes. STEP export preserves supported grouped
project parts as a single-level assembly and encodes nested group paths in part
names; reimport reconstructs nested editable project groups from those paths
when each exact solid maps unambiguously to an occurrence. `POST /explode` also
reconstructs nested groups from source STEP hierarchy when association is
unambiguous. If a solid cannot be mapped uniquely, the importer returns flat
solids rather than a partial hierarchy. The STEP document itself does not
retain native nested assembly levels, and STEP transform editing is not
implemented. Full native hierarchy support still needs robust association
across exporters and broader STEP fixtures.

### 4. Stable face identity across arbitrary topology changes

Stable IDs and color assignments survive shape-parameter edits and supported
CAD treatments when the engine finds a unique match. Matching uses exact face
B-rep or a unique planar support surface; for parameter edits, uniquely
occurring cone, sphere, torus, and cylinder faces can also retain identity
when their sampled normal changes. Fillets and symmetric chamfers can use
OCCT's modified-face history for a unique one-to-one mapping. This is not a
semantic identity contract. Split, merged, generated, repeated, or otherwise
ambiguous faces receive new IDs without inherited assignments. General
identity across arbitrary topology edits remains unsupported.

### 5. Broader sketch constraints and globally determined solutions

The solver supports coincident, horizontal, vertical, perpendicular, parallel,
and fixed-distance relations with a bounded deterministic least-squares solve
and a local Jacobian-rank estimate. Parallel constrains two segment directions
to align, allowing either the same or opposite orientation; it does not align
their offsets. The solver also supports fixed-point relations, which can anchor
global translation. Without a fixed-point anchor, sketch placement retains two
global translation freedoms; with an anchor, the solver can constrain
placement. It does not guarantee global solvability or identify every
nonlinear or second-order dependency.
Degenerate zero-length distance geometry has no determinate
degree-of-freedom report. Additional constraint types and robust global
placement remain open.

## Verification baseline

Focused coverage includes retained face-draft creation, `.skf` round trip,
source-profile replay, missing-match rollback, and dependent-boolean rollback
(`tests/unit/engineParametricRecompute.test.ts`,
`tests/unit/faceDraftChamferRecompute.test.ts`,
`tests/unit/faceDraftFilletRecompute.test.ts`,
`tests/unit/apiV1ShapeRoundTrip.test.ts`), sweep creation and profile rebuilding
(`tests/e2e/sketchCadSweep.e2e.ts`, `tests/e2e/restApi.e2e.ts`,
`tests/unit/apiV1ShapeRoundTrip.test.ts`), source-driven extrusion and revolve
recompute and boolean rollback (`tests/unit/engineParametricRecompute.test.ts`,
`tests/unit/apiV1ShapeRoundTrip.test.ts`), sketch source and feature
persistence (`tests/unit/skfProject.test.ts`), STEP hierarchy and component persistence
(`tests/unit/serverStepExplode.test.ts`,
`tests/unit/stepAssemblyProject.test.ts`), face-ID matching
(`tests/unit/apiV1FaceIdentity.test.ts`), face-draft axis cases
(`tests/e2e/draftFaceEditor.e2e.ts`), and sketch constraints
(`tests/unit/sketchConstraints.test.ts`). These tests establish specific
supported cases; they do not establish general kernel coverage beyond those
cases. Recheck limits and surface coverage before raising them, especially for
large STEP assemblies and static/offline builds.
