# What the kernel already offers, and what to build on it

Status: proposal. Nothing here is implemented. Read against `origin/main` at
`f0ffcaa` (`feat(python): expand client coverage and exports (#76)`), with
`occt-wasm` as installed — `node_modules/occt-wasm/dist/index.d.ts`, 503 lines.

A great deal shipped recently: exact OCCT booleans in the editor, fillet and
chamfer, hollow and shell, a thread catalogue, patterns, distribute, align,
exact measurement from the B-rep, 3MF export, material presets with weight and
cost, orthographic view, a world-anchored snap grid, a REST API and MCP bridge
with client libraries, server-side project storage, and the geometry engine
moved out into `packages/sketchforge-engine` behind an enforced boundary. That
changed what is cheap. This document scopes what to build next, grounded in what
the kernel actually declares rather than what a CAD feature list usually
contains.

**Recommendation, in short: do the three read-only ones first.** Exact mass
properties, the interference/wall-thickness pair, and kernel projection. All
three answer questions about geometry rather than producing new geometry, which
means none of them touches `.skf`, none adds a `ShapeKind`, none adds a
`FEATURE_TYPES` entry, and none can corrupt a project. Two of the three replace
a shipped approximation that is quietly wrong. The modelling verbs — sweep,
draft, mirror-as-an-operation — are all worth building and all cost a format
event; they belong after, in the order §6 gives. Sketch constraints and a
parametric feature tree should not be started, and §7 says why.

---

## 1. The kernel surface, verified

Every method below is declared on the `OcctKernel` class in
`node_modules/occt-wasm/dist/index.d.ts`. Citations are `index.d.ts:line`.

| Method | Line | Status in this repo |
| --- | --- | --- |
| `sweep(wire, spine, transitionMode?)` | 168 | unused |
| `sweepPipeShell(profile, spine, freenet?, smooth?)` | 169 | unused |
| `sweepOriented(profile, spine, mode?, up?, auxSpine?)` | 176 | unused |
| `sweepWithLaw(profile, spine, law)` | 454 | unused |
| `pipe(profile, spine)` / `simplePipe` | 157 / 158 | unused |
| `draft(shape, face, angleRad, direction)` | 156 | unused |
| `draftPrism(shape, dx, dy, dz, angleDeg)` | 177 | unused |
| `mirror(shape, point, normal)` | 218 | unused |
| `mirrorBatch` / `mirrorWithHistory` | 253 / 445 | unused |
| `section(a, b)` | 102 | unused |
| `common(a, b)` | 95 | **test-only** |
| `intersect(a, b)` (alias of `common`) | 98 | unused |
| `intersectWithHistory` / `intersectionCells` | 447 / 118 | unused |
| `split(shape, tools)` | 112 | unused |
| `offset(solid, distance, tolerance)` | 155 | unused |
| `thicken(shape, thickness, tolerance)` | 423 | unused |
| `projectEdges(shape, viewOrigin, viewDirection, xAxis?)` | 404 | unused |
| `toSVG(shape, view?, options?)` | 409 | unused |
| `toMultiviewSVG(shape, options?)` | 415 | unused |
| `sharedEdges(faceA, faceB)` | 279 | unused |
| `buildExtrusionLaw` / `trimLaw` | 452 / 453 | unused |
| `queryBatch(shapes)` | 239 | **test-only** |
| `distanceBetween(a, b)` | 273 | **used** |
| `getSubShapes(shape, type)` | 271 | **used, heavily** |
| `adjacentFaces(shape, face)` | 280 | **used** |
| `edgeToFaceMap(shape, hashUpperBound)` | 283 | **used** |
| `shell(solid, facesToRemove, thickness, tolerance)` | 147 | **used** |

How "unused" was checked. Three passes over `apps/`, `packages/`, `tests/`,
`tools/`, `scripts/`, `docs/` with `node_modules`, `apps/web/public/assets/`
and `apps/web/src/generated/` excluded as vendored: a bare-name grep for the
names that cannot collide with English (`sweepPipeShell`, `draftPrism`,
`intersectionCells`, `toMultiviewSVG`, …); a receiver-qualified grep
`(cad|kernel|occt|Kernel)[A-Za-z0-9_]*\.(method)\b` for the names that do
collide (`split`, `common`, `section`, `offset`, `pipe`, `draft`); and a
per-method `\.(method)(` tally restricted to the 24 files that mention
`occt-wasm` or `OcctKernel` at all. The three passes agree.

The false positives that pass rules out are worth naming, because two of them
look exactly like real uses:

- `brep.mirror(...)` at `packages/sketchforge-engine/src/stepExport.ts:210-212`
  is **brepjs**, applying the per-shape mirror flags during STEP export, not the
  kernel's `mirror`.
- `.intersect(...)` at `apps/web/src/components/SketchForgeEditor.tsx:4323` and
  `:8198`, and `packages/sketchforge-client/mcp/localEngine.mjs:153`, is
  **Manifold** mesh boolean (`runtime.Manifold.ofMesh(...).intersect`), not
  OCCT's `common`.
- `sweep`, `shell`, `offset`, `common`, `draft`, `section` in `docs/REST_API.md`,
  `docs/CHANGELOG.md`, the i18n `messages.json` files and `globals.css` are
  English prose, REST route names, revolve parameters and CSS.

**There is no narrowed kernel interface to widen.** The two files that look like
kernel shims are Emscripten factory declarations and nothing else:
`packages/sketchforge-engine/src/support/occt-wasm.d.ts` is 4 lines,
`apps/web/src/types/occt-wasm-module.d.ts` is 10, and both declare only
`declare module "occt-wasm/dist/occt-wasm.js"` with a `default` factory. Every
first-party consumer writes `import type { OcctKernel, ShapeHandle } from
"occt-wasm"` and gets the real type. So all 27 methods above are already in
scope, already typed, and reachable from any engine module today. This is the
single biggest reason the proposals below are cheap: there is no plumbing stage.

---

## 2. Where the brief is wrong

The most useful thing this document can do is correct the premises. Eight need
it. Four of those change a proposal, and three of the four were found late
enough to rewrite one that was already written — which is the best argument I
can offer for reading the code before costing the work.

Shortest form, for anyone who reads only this: `getSubShapes` is used, not
unused. Whole-body fillet already ships. 3MF already writes colour. Weight and
cost come from the mesh, so exact mass properties is a bug fix. A capability is
not in fact expected on all surfaces. The per-solid listing welds triangles
rather than enumerating solids. The STEP server-read problem is already fixed.
And a two-phase clash check already exists in the editor.

### 2.1 `getSubShapes` is not unused — it is the most-used kernel call in the repo

The brief lists `getSubShapes(shape, "solid")` among the methods "nothing in the
app uses". It is used in at least sixteen production places:
`serverCadOperations.ts:113, 119, 131, 266, 290, 334`; `serverCadShell.ts:131,
217, 285`; `serverCadMeasure.ts:133, 134, 183`; `exactBooleanSolids.ts:55, 99`;
`cadSolids.ts:64`; `serverShapeBooleans.ts:115`; `stepImportKernel.ts:73`; and
`apps/web/src/workers/cadModifier.worker.ts:200, 207, 227, 300, 301`.

This matters more than a pedantic correction, because the specific call the
brief wanted — decomposing a shape into its constituent solids, with a mapping
from each sub-entity back to the solid that owns it — **is already written, and
already runs in the browser**. `cadModifier.worker.ts:442-461`:

```ts
baseSolids = activeCad.isSolid(baseShape) ? [baseShape] : activeCad.getSubShapes(baseShape, "solid");
if (baseSolids.length === 0) throw new LocalizedError("errors.cadModifier.noClosedSolidComponents");
const ownerEdgeHandles = baseSolids.map((solid) => activeCad.getSubShapes(solid, "edge"));
```

followed by a hash-and-`isSame` reconciliation that tags every edge with the
index of the solid it belongs to. The worker does this only so a fillet knows
which body an edge came from. The explode-an-assembly machinery is therefore not
new work; it is an existing routine with no user-facing operation in front of
it. §5.2 takes that as its starting point.

### 2.2 Whole-body fillet and chamfer already ship

The brief lists "fillet or chamfer a whole body or a face, rather than edge by
edge" as a candidate. The whole-body half is done, on every surface:

- Engine: `serverCadOperations.ts:303` — `const chosen = requested && requested.length > 0 ? requested.map((index) => allEdges[index]) : filletable;`, with the comment at `:297` that "a request for every edge means every edge that can be". `filletable` is the edges with at least two adjacent faces.
- REST: `docs/REST_API.md:233` — "`edges` is a list of indexes, or omitted for all of them".
- Editor: an "All sharp edges" button at `apps/web/src/components/workplane/EdgeModifierPanel.tsx:228`.
- MCP and bridge: `edgeIds: "all"` or `allEdges: true`, handled at `SketchForgeEditor.tsx:7620`.

What is genuinely missing is the **per-face** half, and that is missing for a
structural reason rather than an oversight: `CadModifierEdge`
(`packages/sketchforge-engine/src/domain/cadModifierTypes.ts:6-15`) carries no
face reference at all. Its `owner` field is the operand index, not a face. There
is no "the edges of face *n*" selector anywhere. The kernel has the raw
material — `sharedEdges(faceA, faceB)` at `index.d.ts:279` and the already-used
`edgeToFaceMap` at `:283` — so §5.5 scopes it as a small, real piece of work.
But "whole body" should come off the list.

### 2.3 3MF already carries colour. The gap is per-face, not colour at all

The brief says "3MF already carries it and the material presets half-set it up.
Check what the 3MF exporter does today." Checked: the exporter at
`apps/web/src/lib/threeMfExport.ts` already writes colour, per object, via the
core specification rather than an extension. `:153-160`:

```xml
<basematerials id="1">
  <base name="..." displaycolor="#RRGGBBAA"/>
</basematerials>
<object id="N" type="model" pid="1" pindex="i" name="...">
```

and the header comment at `:11-18` says so deliberately: "Colour rides on the
core specification's `<basematerials>` resource and the object's `pid`/`pindex`,
not on the materials-and-properties extension… Nothing here therefore depends on
an extension namespace."

The `<triangle>` elements at `:171` carry only `v1/v2/v3` — no `pid`, no
`p1/p2/p3`. There is no `colorgroup` anywhere in first-party source. And the
reason is upstream of the exporter: `WorkplaneShape` has exactly one `color:
string` (`domain/sketchforge.ts:241`) and one optional `material?: string`
(`:247`). There is no per-face colour concept **to** export.

So per-face colour is not an export feature. It is a shape-model feature with an
export consequence, and the model change is the whole cost. §6.4.

### 2.4 Weight and cost are computed from the tessellation, not the B-rep

This is the correction that creates a recommendation. The brief frames exact
mass properties as a new capability — "real centre of mass and balance rather
than a bounding-box guess". It is better than a bounding-box guess today and
still wrong: weight comes from the **mesh**.

`apps/web/src/lib/materialPresets.ts:121-136` is `meshVolumeMm3`, a
signed-tetrahedron sum over indexed triangles. Its only production caller is
`SketchForgeEditor.tsx:5829-5831` — `meshVolumeMm3(meshForShape(selectedShape))`
— which flows to `ShapeInspector.tsx:621` and becomes the displayed weight and
price. Density is real and sourced (`materialPresets.ts:47-56`, eight materials,
g/cm³, with citations at `:30-45`), and the arithmetic is right. The volume is
the approximation.

The project already knows what that costs. `docs/REST_API.md:365` opens the
measurement section with it: "a tessellated cylinder has no radius at all, only
facets… The same class of quiet error cost this project a sphere whose volume
was 0.0427% off, found in #57." That sentence was written about measurement. It
is equally true of the weight readout, which was not fixed at the same time.

A centre-of-mass function also already exists — `meshVolumeCentroid` at
`materialPresets.ts:138-163` — and has **no production caller**; its only callers
are `tests/unit/materialPresets.test.ts:89,96` and
`tests/unit/threeMfExport.test.ts:237-238`. So "nothing computes centre of mass"
is true as a feature and false as a library.

Meanwhile `queryBatch` (`index.d.ts:239`) returns `{ bbox, volume, area,
centerOfMass, shapeType, isValid }` in one call, and is already exercised in
`tests/e2e/primitiveGeometryAgreement.e2e.ts:157` and
`tests/e2e/exactSolidRotation.e2e.ts:61,66`. The test suite trusts it to verify
geometry. The product does not use it.

That reframes the work: §5.1 is not a new feature, it is a correctness fix to a
shipped number, which happens to deliver centre of mass as a side effect.

### 2.5 A capability is *not* in fact expected on all surfaces

The brief asks for "the first PR … with the surface it needs — editor, REST
route, MCP tool, client libraries — because in this project a capability is
expected on all three." The codebase's own precedent is narrower, and
deliberately so.

Neither of the two most recent kernel capabilities has any editor UI:

- Hollow/shell shipped in `41cdcf8` (#51) with no editor action. `docs/CHANGELOG.md:101` says it outright: "hollowing is a server-side operation and there is no editor action for it yet."
- Measurement shipped in `4e11705` (#65) across 25 files with no viewport measuring tool; the only ruler in the editor is the unrelated 2D sketch one.

So **REST + MCP + both clients, editor later** is a shipped, blessed pattern, and
it is the right pattern for everything in §5 — all of which produce numbers,
drawings or new bodies that an existing editor surface can already display. Each
proposal below states its surfaces explicitly, and most of them say "no editor
UI in the first PR". That is not scope-dodging; it is the precedent.

### 2.6 "The per-solid listing already works" — it works on triangles, not solids

The brief says the per-solid listing already works, which is true of the feature
and not of the mechanism, and the difference is the whole of §5.2.

`POST /parts` and `sketchforge_separate_parts` do not enumerate solids. They walk
mesh connectivity. `separateShapeParts`
(`packages/sketchforge-engine/src/serverShapeGroups.ts:486`) has two branches: a
record-only group hands back its stored children (`:489-491`), and anything with
a mesh goes to `meshFaceComponents(mesh)` (`:495`, defined at `:419`) — a
**vertex-welding connected-components walk over mesh faces** with a vertex
tolerance. Each component becomes a new mesh-backed shape via
`meshShapeFromWorldPositions` (`:470`), named "`<source>` Part N". The editor
carries a second browser copy (`SketchForgeEditor.tsx:3000`, `:3097`, `:3119`).

Three consequences, all of which make an exact explode worth building rather
than redundant:

- Two solids that touch or interpenetrate **merge into one "part"**, because
  their triangles are connected. Solids are what a STEP assembly has; touching
  triangles are what it looks like after tessellation, and an assembly is
  precisely the case where parts touch.
- The parts come back as **mesh** shapes, so the exact B-rep is lost, and with it
  the exact booleans, measurements and fillets that the rest of the recent work
  was about.
- And the `getSubShapes(…, "solid")` calls I cited in §2.1 are, on inspection,
  nearly all doing something narrower than enumeration: `cadSolids.ts:64`,
  `exactBooleanSolids.ts:55`, `serverCadOperations.ts:113`,
  `serverCadShell.ts:217` and `serverShapeBooleans.ts:115` unwrap a
  boolean-result compound to find *the single* solid inside it. Only the
  `cadModifier.worker.ts:442-461` block genuinely enumerates bodies and maps
  sub-entities back to them. §2.1's correction stands — the method is used, and
  the enumeration idiom exists — but the enumeration exists in exactly one
  place, in the browser, for a different purpose.

### 2.7 The STEP server-read problem is already fixed

The brief asks me to mention, as context, that a project holding a STEP source
asset is unreadable by the server because the read path regenerates the mesh
through the browser's kernel loader, and says it is being fixed now. **It is
already fixed on `origin/main`**, by `53e086e` ("fix: read saved STEP imports
with server kernel (#70)").

`readProjectDocument` (`packages/sketchforge-engine/src/serverProjectDocument.ts:85-91`)
passes an explicit `sourceImporter` override that routes
`asset.sourceFormat === "step"` to `importedShapeFromStepOnKernel` — the server
kernel path — and falls back to `importSkfSourceAsset` only for other formats.
`importSkfProject` honours the injection at `skfProject.ts:1372`:
`const sourceImporter = options.sourceImporter ?? importSkfSourceAsset;`. The
regression test is `tests/e2e/serverReadsStepProjects.e2e.ts:60`, "reads it on
the server, where the browser's kernel loader does not exist".

The stale description is probably the test's own header comment (`:15-23`), which
still narrates the pre-fix state.

Worth lifting out as a pattern, because §5.2 needs it: **an injected importer at
the read boundary** is the established seam for "this asset needs a kernel and
which kernel depends on where we are". A new asset-consuming operation should
take the same parameter rather than branching on `typeof window`.

### 2.8 Two smaller ones

**Fine-pitch threads are mostly a data change, not an engine change.** The
catalogue is coarse-only, as the brief says —
`packages/sketchforge-engine/src/threadCatalog.ts:8-9`, "Metric pitches are
ISO 261 coarse. Unified pitches are the coarse (UNC) series" — eleven metric
sizes and eight unified, series union `"metric" | "unified"` at `:11`. But pitch
is already a free parameter downstream: `revolveRequests.ts:198` honours an
explicit request pitch over the catalogue value, and the inspector exposes it
live over −20..20 step 0.1 (`apps/web/src/lib/shapeProperties.ts:200`). So fine
series is a table extension plus a `series` value. **Multi-start genuinely does
not exist** and is a real model change: `SketchRevolveSettings`
(`domain/sketchforge.ts:163-184`) has `pitch` documented as "Axial rise per full
turn" and `turns`, with no `starts`; `REVOLVE_SETTING_NAMES`
(`revolveRequests.ts:357`) confirms the closed list; and the profile spans
exactly one pitch (`metricThreadOutline`, `revolveRequests.ts:150`, returns
`[[inner,0],[crest,pitch/2],[inner,pitch]]`). Lead and pitch are the same number
today.

**The image plate is a texture, not a heightmap.** `imagePlate`
(`domain/sketchforge.ts:312-317`) is attached to a `kind: "box"` of height 1.6mm
(`SketchForgeEditor.tsx:2429-2452`) and rendered as a three.js texture
(`WorkplaneViewport.tsx:8145`). There is no displacement code anywhere —
`heightmap|heightMap|displacement` matches only vendored WASM glue and CSS. The
plumbing that *does* exist is the asset half, and it is the useful half: the data
URL is split into the project asset table on write
(`skfProject.ts:546-556`) and rehydrated on read (`:1277-1283`). Decoding is
browser-canvas today (`SketchForgeEditor.tsx:2364-2399`, via
`document.createElement("canvas")`), but a server path is available and I nearly
got this wrong: `sharp` is a dependency of both the root (`package.json:95`) and
the client package (`packages/sketchforge-client/package.json:24`), and the MCP
already calls it. So a server-side decode is a `sharp` call, not a missing
capability.

---

## 3. The four facts that decide every proposal below

### 3.1 The shape model is a flat parameter bag with a baked B-rep

`WorkplaneShape` (`packages/sketchforge-engine/src/domain/sketchforge.ts:240-336`)
is one type with roughly seventy optional fields: `taperTopWidth`, `teeth`,
`loftTopRotation`, `helixAngle`, `imagePlate`, `sketchRevolve`, and — the
load-bearing ones — `cadBrep?: string` with `cadBrepFrame`, plus
`groupedShapes?: WorkplaneShape[]` recursing.

There is no feature list. `edgeTreatments?: EdgeTreatmentFeature[]` is the
closest thing, and `EdgeTreatmentFeature` (`:185-190`) is `{ kind, amount,
edgeCount, chamferAngle? }` — it records *how many* edges were rounded, not
which. The result is baked into `cadBrep` and the previous shape is kept whole in
`edgeTreatmentHistory[].before` so undo can restore it.

This is a destructive modeller with snapshot undo, and that is a coherent design
rather than an unfinished one. Every new operation therefore has to choose
between three placements, and the choice is most of the cost:

1. **A new `ShapeKind`** — a parametric body regenerated from its own fields. Cheapest to persist, because `.skf` regenerates native primitives from definitions. Requires an entry in `SHAPE_KINDS` (`skfProject.ts:31-34`), a builder in `cadSolids.ts`, a mesh path for the viewport, and inspector fields.
2. **New optional fields on an existing kind** — what taper and thread did. Cheapest overall, only available when the operation is a modifier of one body.
3. **Baked into `cadBrep`** — what booleans and edge treatments do. No format change at all, but the operation becomes unrepeatable and the parameters are lost.

### 3.2 Sub-entities are addressed by positional index, and that decision is already made and documented

A face or edge is named by its integer index into `cad.getSubShapes(solid,
"face" | "edge")`. `GET /faces` and `GET /edges` hand those indexes out; `POST
/shell` consumes them as `openFaces`; `POST /measurements` consumes them as
`{ shapeId, entity, index }`; `POST /treatments` consumes them as `edges`. The
indexes agree across all of them because they come from the same enumeration —
`docs/REST_API.md:372` states that as a guarantee.

The indexes are **not stable across a change to the shape**, and the project has
already chosen honesty over machinery rather than leaving it implicit.
`docs/REST_API.md:436`: "A shape **changes shape** when it is hollowed or
filleted, so re-measure a result before naming indexes on it." Naming an index
that no longer exists is a 422 whose message says how many there were.

This is the single most important enabler in the document. Four of the
proposals in §5 need to name a face — draft, section by a face, emboss on a
face, fillet the edges of a face — and none of them has to invent an addressing
scheme, argue about persistent topological naming, or change the wire format.
They follow a convention that already exists, is already documented, and whose
failure mode is already specified.

It is also, exactly, the reason §7 says not to start a feature tree. A feature
tree is the one thing that *cannot* live with positional indexes.

### 3.3 There are two kernel-facing APIs, and new code should use the lower one

I did not expect this. Alongside the raw `OcctKernel`, the repo drives OCCT
through **brepjs**: `packages/sketchforge-engine/src/support/lib/brepKernel.ts`
(46 lines) loads the kernel and registers it as a brepjs backend —
`brep.registerKernel("occt-wasm", brep.OcctWasmAdapter.fromKernel(kernel))`.
Downstream of that, code calls `brep.box`, `brep.extrude`, `brep.mirror` rather
than kernel methods. Its consumers are `stepExport.ts`, `stepImport.ts`,
`stepImportKernel.ts` and `serverCadShell.ts`.

Two consequences:

- A process can hold **two independent 22 MB kernel instances** — one from
  `serverCadKernel()`, one from `loadBrepWithOcct()`. Each caches its own
  promise. Nothing shares them. Worth knowing before adding a third caller, and
  worth measuring on the desktop build, where memory is not free.
- New work should go through `serverCadKernel.ts`, not brepjs. Its header is
  explicit about why the shape of that module matters
  (`serverCadKernel.ts:11-20`): the handle arena is global, so `withCadKernel` is
  the only way in, it runs one operation at a time, and it empties the arena
  afterwards. "The WASM build is single-threaded, so serialising costs nothing
  that was ever available."

That last clause is true of one operation and false of a batch, which is the
main risk in §5.2 and §5.3.

### 3.4 The surface tax is real, and nothing is generated

A capability that reaches REST, MCP and both client libraries touches, at
minimum:

| # | File | Note |
| --- | --- | --- |
| 1 | `packages/sketchforge-engine/src/<capability>.ts` | the work |
| 2 | `packages/sketchforge-engine/src/engine.ts` (880 lines) | **two** edits: the `Engine` type and the `createEngine` object |
| 3 | `packages/sketchforge-engine/src/index.ts` (140) | barrel, needed by local MCP mode |
| 4 | `apps/web/src/lib/engine/<capability>.ts` | one line: `export * from "@constructorfleet/sketchforge-engine/<capability>";` — all 53 shims are exactly one line (`wc -l` over the directory is `53 total`); the package's wildcard `exports` (`package.json:17-29`) means no manifest edit |
| 5 | `apps/web/src/app/api/v1/<noun>/route.ts` | plus `export const runtime = "nodejs"; export const revalidate = false;` |
| 6 | `apps/web/src/lib/apiV1Methods.ts` | **only if GET-only** — see below |
| 7 | `apps/web/src/lib/apiEngine.ts` (165) | a `case` per new failure reason |
| 8 | `packages/sketchforge-client/mcp/server.mjs` (716) | tool definition in the `tools` array (`:37-429`) **and** a `case` in `callRemoteTool` (`:514-617`) |
| 9 | `packages/sketchforge-client/mcp/localEngine.mjs` (322) | a `case` in `callLocalEngineTool`, or the tool silently answers "needs an open SketchForge editor" |
| 10 | `packages/sketchforge-client/src/resources/<noun>.ts` + `types.ts` (597) + `client.ts` (two places) + `index.ts` | TS client |
| 11 | `packages/sketchforge-py/src/sketchforge3d/client.py` (937) + `types.py` (665) + `__init__.py` (three edits) | Python client |
| 12 | `docs/REST_API.md` (672) | endpoint table **and** a prose section, with a "When it refuses" subsection |
| 13 | `tests/unit/<module>.test.ts`, `tests/unit/apiV1<Noun>.test.ts`, `resources.test.ts`, `test_client.py`, `tests/e2e/restApi.e2e.ts` | |

Three traps in that list.

**The GET-only prerender trap.** A route exporting only `GET` gets prerendered
and then serves `404 api_disabled` in production forever.
`apps/web/src/lib/apiV1Methods.ts:31-36` is the escape hatch
(`apiReadOnlyOptions()`), and the comment at `:1-28` explains it. Three of the
five proposals in §5 are read-only, so this applies to all three.
`tests/e2e/productionApi.e2e.ts` is what catches it — and e2e is not a gate
(§8), so a reviewer has to catch it instead.

**Nothing is generated.** The TS `types.ts`, the Python `types.py`, the MCP JSON
Schemas in `server.mjs` and the engine's own types are four hand-kept copies of
one wire contract. There is no OpenAPI document and no codegen step.
`docs/REST_API.md:42-64` is the nearest thing to a registry and is also
hand-maintained. Budget for the copying; it is most of the diff in a small
capability.

**Local MCP mode fails open, not loud.** A tool with no `case` in
`localEngine.mjs` falls through to `throw new Error(\`${name} needs an open
SketchForge editor…\`)`. No test asserts that every tool has a local case —
`tests/unit/localMcpEngine.test.ts:127` iterates the tool list but asserts
something else. So "I added the MCP tool" and "the MCP tool works offline" are
different claims, and only the second one matters for the server-side
capabilities below.

One useful split, from the two exemplars disagreeing: MCP tools reach the
geometry two different ways. Measurement and shell use `restRequest`
(`server.mjs:555-571`) and so need **no** entry in
`apps/web/src/lib/sketchforgeMcpProtocol.ts:74-95` and no handler in
`SketchForgeEditor.tsx`. Align, distribute, pattern and edge-treatment use
`bridgeCommand` (`:534-553`) and need both. **Everything in §5 is a stored-project
operation and should take the `restRequest` path**, which removes the
11,285-line editor file from the first PR entirely.

---

## 4. How the candidates group

The brief's list is twelve items. They are not twelve pieces of work; they are
four clusters and two orphans, and the clustering is what makes the sequencing
obvious.

**Interrogation** — answer a question about existing geometry. `queryBatch`,
`distanceBetween`, `common`, `getSubShapes`. Read-only, no format change, no new
`ShapeKind`, and all four of exact mass properties, clash detection, wall
thickness and balance are the same three kernel calls wearing different hats.
Explode-assembly belongs here too, because interference between the parts of an
assembly is the question that makes an assembly worth exploding.

**Projection** — turn 3D into 2D. `projectEdges`, `toSVG`, `toMultiviewSVG`,
`section`. Section, project-to-sketch, 2D drawings and a replacement for the
current SVG export all share one projection step, and DXF is a serialiser bolted
to the end of it.

**Modelling verbs** — produce new geometry. `sweep`/`pipe`, `draft`, `mirror`.
Each needs a placement decision from §3.1 and each is a `.skf` event. Sweep
additionally needs a thing the model does not have: a spine.

**Surface attribution** — per-face colour, emboss on a face, fillet the edges of
a face. All three are blocked on the same missing concept: a face-scoped
property on a shape. One of them pays for the other two.

**The orphans** — fine-pitch and multi-start threads (§2.8, a table and a model
field, unrelated to anything else) and the heightmap relief (its own import
pipeline).

And **the feature tree**, which is not in any cluster because it is not a
feature; it is a different application. §7.

---

## 5. The proposals

Each gives the first PR, the surfaces, a size, and what would make it not worth
doing.

### 5.1 Exact mass properties — volume, area, centre of mass

**What.** One kernel call per shape replaces the tessellated volume behind the
weight and cost readout, and exposes centre of mass, surface area and exact
volume over the API.

**Why first.** §2.4: this is not a new feature but a correctness fix to a
shipped number, and the project has already written down why the mesh answer is
not good enough. The weight of a sphere, a torus, a tapered cone or a thread is
wrong by the chord error of whatever quality setting was in force. Area is worse
than volume, because a tessellated curved surface understates its own area
systematically rather than symmetrically — which is the number a resin or
support-material estimate would want.

**First PR.**

- `packages/sketchforge-engine/src/serverCadProperties.ts` — build the solid the
  way `serverCadMeasure.ts` already does (it is the closest sibling: same solid
  construction, same `withCadKernel` discipline, same failure vocabulary), then
  one `cad.queryBatch([solid])` and return `{ volume, area, centerOfMass, bbox,
  isValid }`. Split the pure part out the way measurement did —
  `serverCadMeasure.ts` for the kernel and `cadMeasurements.ts` for the
  arithmetic and the unavailability codes — so the unit conversions and the
  density arithmetic are testable without OCCT. That split is why
  `tests/unit/cadMeasurements.test.ts` can run in the gate, and it is the better
  of the two exemplar patterns.
- `GET /api/v1/properties?projectId=&shapeId=` — read-only, so
  `apiReadOnlyOptions()`. `shapeId` optional: omitted, return the whole project
  plus a combined centre of mass, which is the balance question.
- Fold density in: the response should carry `weightGrams` and `cost` when the
  shape has a material, computed from the exact volume with the existing
  `materialWeightGrams` / `materialCost` (`materialPresets.ts:172-177`). The
  arithmetic is already right and already tested; only its input changes.
- Point `ShapeInspector.tsx:621` at the server number, with the mesh number as
  the fallback when the kernel is unavailable (the static export, §8). This is
  the one editor-side line in the proposal and it is a swap, not a feature.
- `sketchforge_shape_properties` in `server.mjs` **and** `localEngine.mjs`.
- Both clients, `docs/REST_API.md`, unit tests for the pure half, an e2e for the
  kernel half next to `primitiveGeometryAgreement.e2e.ts` — which already calls
  `queryBatch` and is the natural place to assert that the exact and mesh volumes
  agree to within tessellation tolerance for the kinds where they should.

**Size.** Small. ~250 lines of source plus the surface tax. No format change, no
new `ShapeKind`, no new editor surface.

**Risk.** Low, and almost all of it is in one place: the displayed weight will
**change** for curved shapes. It will get more correct, and a user who wrote down
yesterday's number will see it move. That belongs in the changelog entry, not in
a flag.

**What would make it not worth doing.** If the weight readout is understood as an
estimate and nobody has been misled by it, this is polish. I do not believe that
— a cost in currency reads as a fact, not an estimate — but it is the honest
counter-argument. Note also that the editor swap needs the server: in the static
export there is no kernel, so the mesh path has to stay as a fallback and this
becomes two code paths where there is one today.

### 5.2 Explode an imported assembly

**What.** Turn one imported STEP body into one shape per solid, with the names
and colours the STEP file carries.

**Why here.** It is the prerequisite that makes §5.3 worth anything. Interference
between the parts of an assembly is the question; one opaque body cannot be
asked it.

**What import does today, which is the crux.** Both paths tessellate the whole
compound and produce **one** mesh-backed shape:

- Browser: `stepImport.ts:12`, `importedShapeFromStep` → brepjs `importSTEP` →
  `mesh` → `importedShapeFromTriangleSoup` (`:75`). One `WorkplaneShape`.
- Server: `stepImportKernel.ts:62`, `importedShapeFromStepOnKernel` →
  `cad.importStep` → `cad.tessellate(imported, …)` on the **whole** compound
  (`:83`) → one `WorkplaneShape` (`:103`).

The solids are enumerated — `stepImportKernel.ts:73`,
`cad.getSubShapes(imported, "solid")` — but only to **count** them. The count
feeds `StepImportSummary.solids`, documented at `:51-52` as "How many separate
solids the file held, which is what makes it an assembly", and a gate:

```ts
const EXACT_GEOMETRY_LIMITS = { solids: 200, sourceBytes: 8 * 1024 * 1024 } as const;   // :45
const worthKeepingExact = solids.length <= EXACT_GEOMETRY_LIMITS.solids
  && stepText.length <= EXACT_GEOMETRY_LIMITS.sourceBytes;                              // :109-110
```

**So the owner's 2,689-solid file is thirteen times over the gate, and its
`brepStep` is deliberately not retained** — `exactGeometry: false`, with the
reasoning at `:113-116` that turning and moving the solid "is the step that can
exhaust the kernel on a large assembly, so it comes last and its failure costs
only the exact geometry". That is a sound decision and it removes the obvious
cheap route: for exactly the files worth exploding, there is no stored B-rep to
explode.

**What is still available, and it is enough.** The original file.
`importedMesh.assetId` is a "stable reference to the original imported file in
the project's shared asset table" (`domain/sketchforge.ts:320-323`), `.skf`
stores it under `assets/source/`, and source-backed objects are regenerated from
it (`docs/SKF_PROJECT_FORMAT.md:21, :53`). The bytes survive a round trip whether
or not the exact geometry did. And after §2.7, the server can read them.

Also available and entirely unused: the kernel's XCAF document API, which is
where per-part names and colours live. `xcaf-document.d.ts` —
`xcafImportSTEP(stepData)` at `:49`, `getRoots()` at `:81`,
`getChildren(parent)` at `:79`, `getLabelInfo(label)` at `:77`, with
`setName`/`setColor` at `:72`/`:70` for the way back out. A grep for
`xcaf|getRoots|getChildren|getLabelInfo` across first-party source returns zero
hits, so a STEP assembly's part names and colours are read and discarded today.

**First PR.** Do not change what import produces — that is a migration and a
format argument. Add the explode as an operation on an already-imported shape,
re-reading the retained source asset through the §2.7 `sourceImporter` seam:

- `packages/sketchforge-engine/src/explodeAssembly.ts` — load the shape's
  `assetId` bytes, `cad.importStep`, `cad.getSubShapes(solid, "solid")`, and emit
  one `WorkplaneShape` per solid, each with its **own** `brepStep` and the
  transform baked into its frame — which is the per-solid exact geometry the
  import gate declined to keep for the compound, and is affordable per body even
  when it was not affordable for 2,689 at once. Reuse the hash-and-`isSame`
  reconciliation from `cadModifier.worker.ts:442-461` rather than writing a
  second one.
- `POST /api/v1/explode?projectId=&shapeId=`, with an explicit `limit` and a
  conservative default. Over the limit is a refusal that says the count, in the
  house style of `docs/REST_API.md`'s "When it refuses" sections — not a
  truncation.
- `sketchforge_explode_assembly`, both MCP paths, both clients, docs, tests.
- **Names and colours as a second PR**, through XCAF. Splitting here is
  deliberate: `getSubShapes` gives bodies and is a day's work; XCAF gives a
  *hierarchy*, and mapping an arbitrary-depth label tree onto `groupedShapes` —
  which is nested `WorkplaneShape[]` with a cycle check — is a design question of
  its own.

**Why this beats `POST /parts` rather than duplicating it.** §2.6: `/parts` welds
triangles, so in an assembly — the one case where parts touch — it merges bodies
that OCCT would keep separate, and it returns mesh shapes. An exact explode
returns solids with their B-reps, which is what makes the result measurable,
filletable and exactly boolean-able. The two should coexist: `/parts` for "this
one body fell into pieces", explode for "this file was always several".

**Size.** Medium for the first PR; the second is medium and more uncertain.

**Risk.** Not correctness — capacity, in three places at once. §3.3:
`withCadKernel` serialises, so exploding a large assembly holds the only kernel
in the process while every other CAD request queues. The import gate at
`stepImportKernel.ts:45` is direct evidence that somebody already hit the
kernel's limits on this exact file class. And the result is thousands of shapes
in a project whose undo history stores a whole object graph per retained state
(§8.1) — an autosave problem, not a geometry one. **All three argue for a
conservative default, an explicit opt-in, and measurement before raising it.**
The owner's 2,689-solid file is the test case and should be in `tests/e2e/`
before the limit moves, not after.

**What would make it not worth doing.** If imported assemblies are mostly
single-part files in practice, this is machinery for a rare case; one real
2,689-solid example is evidence of the need but not of its frequency. And if the
answer people actually want is "show me the part list" rather than "give me the
parts", that is a read-only listing over `getSubShapes` plus XCAF names — much
smaller, no new shapes, no autosave consequence, and worth asking about first.

### 5.3 Interference, clearance and wall thickness

**What.** Three questions, one piece of machinery: do these two bodies collide
and by how much; what is the smallest gap in this assembly; and is this wall
thick enough to print.

**Why these are one proposal.** All three are `distanceBetween` over a pair of
entities, plus `common` for the overlap volume when the distance is zero, plus
`queryBatch`'s bounding boxes to avoid asking about pairs that cannot touch. The
brief already spotted that clash and wall thickness are the same machinery; the
clearance report is the same machinery a third time, and the mass-properties work
in §5.1 supplies the prefilter.

**This one already exists, approximately, and that changes the proposal.** I
expected to be specifying it from scratch. `sketchforge_validate_scene` does a
textbook two-phase clash check today, in the editor, at
`apps/web/src/components/SketchForgeEditor.tsx:8169-8212`:

1. **Broad phase**, `:8177-8188` — pairwise AABB via `meshAabb`, per-axis gaps,
   `lowerBound = Math.hypot(...gaps)`, `overlappingBounds` when every gap is zero.
2. **Narrow phase**, `:8190-8209` — for overlapping-AABB pairs only,
   `leftSolid.intersect(rightSolid)` via **Manifold**, then `overlap.volume()`,
   reported as `{ fromId, toId, volume, intersects: volume > 1e-6 }`. Per-pair
   failures are reported rather than thrown (`:8210-8212`).

It even documents its own approximation in the response, which is the house style
at its best: `clearanceMethod: "AABB lower bound; use sketchforge_measure_between
on stored exact CAD entities for exact surface distance."` and
`intersectionMethod: "Manifold intersection volume for overlapping AABB pairs;
failures are reported per pair."`

So the capability is not missing. What is missing is three specific things, and
naming them makes this a far smaller and better-grounded piece of work than "add
clash detection":

- **It is mesh and Manifold, not OCCT.** The clearance is a bounding-box lower
  bound, not a surface distance, and the overlap volume is a mesh intersection.
  So the one answer a user most wants — *how far apart are these, really* — is
  the one it explicitly declines to give and redirects to `measure_between` for.
- **It lives in an 11,285-line React component.** No REST route, no engine
  module, no server implementation, and therefore no test can reach it. The MCP
  action is `sketchforge_validate_scene`
  (`apps/web/src/lib/sketchforgeMcpProtocol.ts:95`) and it has **no
  `localEngine.mjs` case**, so in local project mode it answers "needs an open
  SketchForge editor" (§3.4).
- **It reports shapes, not features.** `{ fromId, toId, volume }` says two bodies
  clash, not which faces.

And the exact half is already wired: `distanceBetween` at
`serverCadMeasure.ts:211` (reasoning at `:7` and `:199`), reachable over `POST
/measurements` with `{ shapeId, entity, index }` at each end, and **all nine
pairings** of shape/edge/face work — `MeasurementEntityKind` is `"edge" |
"face"` (`:44`) with each end's `entity` one of `"edge" | "face" | "shape"`
(`:145-162`, route whitelist `route.ts:25`). `docs/REST_API.md:425` is precise
about the payoff: "Two round posts 5 mm apart at their nearest walls read 5 — not
the gap between their bounding boxes, and not the 80 mm between their centres."
That is a clearance check, shipped, for one pair, named by hand.

**So the first PR is: move the existing check to the server and make the narrow
phase exact.**

- `packages/sketchforge-engine/src/interference.ts` — `queryBatch` every solid
  once for its bbox (§5.1 supplies this); candidate pairs by bbox overlap
  inflated by the requested clearance; per candidate, `cad.distanceBetween` for
  the true surface gap; where that is zero, `cad.common` and `getVolume` for the
  penetration volume. Report `{ a, b, gap, overlapVolume }`, worst first. The
  broad phase is a straight port of `:8177-8188` and becomes testable by the move
  alone.
- `POST /api/v1/interference?projectId=` with `{ ids?, clearance? }`, defaulting
  to every visible non-hole solid — `hole: true` shapes are cutters, not bodies,
  and the existing check already filters them (`:8172`), as does
  `separateShapeParts` with a named refusal (`apiEngine.ts:66`).
  `clearance: 0` is "do they collide"; `clearance: 0.4` is "is there a nozzle's
  width between them".
- Give `sketchforge_validate_scene` a `localEngine.mjs` case pointing at the new
  route, so the clash half works offline, and add
  `sketchforge_check_interference` for the exact report. Both clients, docs,
  tests. The unit test covers the prefilter and pair enumeration with no kernel;
  the e2e asserts two known boxes and one known interpenetration volume.
- Keep the editor path as the interactive one, and keep its honest method
  strings. The point is not to delete it but to stop it being the only
  implementation.

**Second PR — wall thickness, and it needs a caveat in the API itself.** For each
face, sample points and `distanceBetween` to the opposing faces, reporting the
minimum. **This is a sampled approximation, not a medial-axis thickness**, and it
will miss a thin region between samples. The project's own convention covers
this: measurement returns `null` with a reason code
(`radiusUnavailable: "radiusVariesOverSurface"` and the rest,
`docs/REST_API.md:390-400`) rather than a plausible wrong number. Wall thickness
should carry the same honesty — report the sample density, and name the method —
rather than presenting a sampled minimum as *the* wall thickness.

**Size.** Small for interference, medium for wall thickness.

**Risk.** Complexity. Naive interference is O(n²) `distanceBetween` calls on a
single-threaded serialised kernel: the 2,689-solid assembly from §5.2 is about
3.6 million pairs, which is not "slow", it is "never". The bbox prefilter is not
an optimisation, it is the feature, and the cap is not a safety rail, it is part
of the contract. Say the cap in the docs and refuse above it.

**What would make it not worth doing.** If the AABB lower bound in
`validate_scene` is good enough in practice — and for "did I leave two parts
overlapping" it very nearly is — then the exact narrow phase buys precision
nobody was missing, and the real value of this proposal collapses to the two
plumbing fixes: a server route and a local-mode case. Those are worth doing
anyway and are most of a day. Conversely, if `POST /measurements` on two named
shapes is already how people answer the clearance question, the marginal value is
the iteration and the sort, and the cap may cut in below the assembly sizes where
iteration was the point. Worth asking before building the wall-thickness half.

### 5.4 Kernel projection: real 2D output, and a picture for the agent

**What.** Replace the triangle-soup projection behind SVG export with the
kernel's hidden-line removal, which gives true curves, any view, hidden lines as
a separate layer, and a server-side path where there is none today. Then
`section` on top of it for contouring, and DXF as a serialiser.

**Why this is the surprise.** Two things in the repo do by hand what the kernel
declares.

The SVG export flattens a **triangle soup**: `svgMeshProjection.ts`'s
`projectedMeshContours(vertices, faces)` maps each vertex to `[x, -z]`, dropping
Y entirely, keeps CCW nonzero contours, and the driver
(`SketchForgeEditor.tsx:2457-2480`) unions them with Manifold's `CrossSection`
and `simplify(0.00001)`. So it is top-view only, faceted wherever the real edge
was curved, and client-only — `ProjectExportFormat` includes `svg`
(`apps/web/src/lib/exportNames.ts:1`) but the server's
`PROJECT_EXPORT_FORMATS` does not (`sceneExport.ts:8`, and
`docs/REST_API.md:569`), because it needs Manifold in a browser.

Worse, and this is the thing I did not expect: `sketchforge_capture_image` in
local MCP mode renders the scene with a **hand-written painter's algorithm**.
`packages/sketchforge-client/mcp/localEngine.mjs:168-215` projects every
triangle, sorts them all by mean depth, emits one `<polygon>` per triangle with a
Lambert shade, and rasterises the result with `sharp`. A per-triangle depth sort
is not a correct occlusion solution — it fails on interpenetrating and on large
triangles — and it is roughly fifty lines of hand-rolled 3D.

Meanwhile `index.d.ts:415` declares `toMultiviewSVG`, and its own doc comment
says what it is for:

> Render a multiview grid (default Front / Top / Right / Iso) of a shape to a
> single SVG string, with per-view gnomons and an overall size annotation.
> **Aimed at giving an automated agent a readable picture of the geometry.**

The kernel ships a feature designed for precisely the consumer this repo built,
and the repo reimplemented a worse version of it twice.

**First PR — server-side SVG, correctly.**

- `packages/sketchforge-engine/src/cadProjection.ts` — build the solid as
  `serverCadMeasure.ts` does, then `cad.toSVG(solid, view, options)` for one
  view and `cad.toMultiviewSVG(solid, options)` for the grid. Both return a
  string; there is no mesh step and no Manifold.
- Add `svg` to `PROJECT_EXPORT_FORMATS` (`sceneExport.ts:8`) so `POST /exports`
  serves it, and keep the existing client-side path until the server one is
  proven on the shapes people actually export.
- Swap `captureScene` in `localEngine.mjs` for `toMultiviewSVG` plus the existing
  `sharp` rasterise. This is a net deletion of about fifty lines of hand-rolled
  projection and it makes the picture correct.
- `sketchforge_project_view`, both clients, docs, tests. A unit test can assert
  the SVG is well-formed and has the expected view count without a kernel; the
  e2e asserts a cylinder's silhouette is a circle rather than a polygon, which is
  the whole point.

**Second PR — `projectEdges` and project-to-sketch.** `projectEdges`
(`index.d.ts:404`) returns `ProjectionData` with six handles —
`visibleOutline`, `visibleSmooth`, `visibleSharp` and the three hidden
counterparts (`types.d.ts:235-251`). That is the raw material for a real drawing,
and for turning a 3D outline into a `SketchProfile` the existing extrude and
SVG-export paths already understand. A laser-cut template from a 3D part is this
plus the existing SVG writer.

**Third PR — `section`, which is the contouring question.**
`cad.section(a, b)` returns "a compound of edges/vertices at the intersection"
(`index.d.ts:99-102`). Slice with a plane built from the existing workplane
settings, or with a face named by index (§3.2), and feed the resulting edges
through the same projection as the second PR. Terrain-style contours are this in
a loop.

**Fourth PR — DXF.** Confirmed absent in both directions: a case-insensitive
`dxf` over the whole worktree, `.git` and `node_modules` excluded, matches only
an incidental hash in `package-lock.json`. DXF is a text serialiser over the
polyline and arc entities that PRs two and three already produce. It belongs
last because it is the cheapest piece and the one most likely to be told "we
only ever needed SVG".

**Size.** First PR small. Second and third medium. Fourth small.

**Risk.** Low, and unusually so: every PR is additive, read-only, and replaces an
implementation that is already worse. The one real unknown is whether
`toSVG`/`toMultiviewSVG` handle the project's own shapes well — threads, lofts
and imported meshes are the ones to try first, and a sewn-from-triangles imported
mesh may produce a silhouette full of facet edges, which HLR on a tessellation
always does. Measure that before swapping the export default.

**What would make it not worth doing.** If `toSVG`'s output is ugly or the HLR is
slow, the first PR shrinks to the MCP capture swap — which is still worth having
on its own, because the current one is incorrect rather than merely plain.

### 5.5 Face-scoped properties, and the three features that need them

**What.** One missing concept — a property attached to a face of a shape —
unblocks per-face colour, emboss and engrave on a face, and filleting the edges
of a face.

**Why one proposal.** All three are blocked on the same thing and none of them is
blocked on the kernel:

- Per-face colour needs `WorkplaneShape` to carry more than one `color`
  (§2.3). Everything downstream exists: 3MF already emits `basematerials` with
  `pid`/`pindex` per object (`threeMfExport.ts:153-160`) and the extension to
  per-triangle `p1/p2/p3` is a known 3MF idiom; `GET /faces` already numbers the
  faces; XCAF already has `setColor` (`xcaf-document.d.ts:70`) for STEP.
- Emboss and engrave need a face to put the text on. The text geometry exists
  (three.js `TextGeometry`, `SketchForgeEditor.tsx:1978-2013`), the boolean
  exists, and `hole: true` already makes a text shape cut. What is missing is
  "on this face, in its plane" — which is a face index plus the plane the
  existing `GET /faces` already returns (it gives centroid, normal and
  direction).
- Filleting the edges of a face needs the face→edges map, which is
  `sharedEdges` (`index.d.ts:279`) or the already-used `edgeToFaceMap` (`:283`).

**First PR.** Pick per-face colour, because it is the one whose model change the
other two reuse, and because `.skf` can carry it without a new feature type.
Add an optional `faceColors?: Record<number, string>` to `WorkplaneShape` keyed
by face index, with the §3.2 contract stated in the field's own doc comment: the
keys are face indexes, they are only meaningful against the shape as it stands,
and an operation that changes the shape drops them. Then `PATCH /shapes`
accepting it, the 3MF exporter emitting per-triangle `pid` for the faces that
have one, and the viewport rendering it.

**Size.** Medium, and dominated by the viewport. The three.js side of per-face
colour means either vertex colours or material groups, and that lands in
`WorkplaneViewport.tsx` — 8,468 lines, which the engine boundary cannot help
with and no test can reach (§8).

**Risk.** The honest one is that `faceColors` keyed by positional index is a
promise the model cannot keep across a fillet. The §3.2 convention makes that
*stateable* but not pleasant: a user who colours a face and then rounds an edge
loses the colour. Measurement gets away with positional indexes because a
measurement is a momentary question; a colour is stored state, and this is the
first stored state keyed on an unstable index. **That is the argument for doing
this one last of the five**, and the argument for a `faceColors` that is dropped
loudly — a warning in the response — rather than silently.

**What would make it not worth doing.** If per-face colour is wanted mainly for
multi-material printing, check first whether the target slicer reads 3MF
per-triangle properties at all; several ignore them and take material assignment
from their own UI. That would make this a display feature, which changes its
priority a lot.

### 5.6 The modelling verbs: sweep, draft, mirror

These produce geometry, so each needs a §3.1 placement decision and each is a
`.skf` event. They are ordered by (value ÷ cost), which inverts the brief's
order.

**Mirror as an operation — the cheapest, and it fixes a live defect.** The brief
is right that mirroring is per-shape flags: `mirrorX/mirrorY/mirrorZ` at
`domain/sketchforge.ts:259-261`, and the mirror command flips them in place
(`serverShapeGroups.ts:244-246`) producing no new body. What the brief does not
mention is what those flags cost. `exactBooleanParts.ts:37` — `shapeIsMirrored`
makes `shapeHasExactBooleanSolid` return false immediately (`:54`), with the
reasoning at `:43-48`:

> A mirror is excluded deliberately rather than for want of trying: the exact
> builders bake a shape's rotation in as they build it, and a mirror has to be
> applied *before* that rotation… Mirrored operands therefore stay on the mesh
> path.

And the module header (`:20-21`) adds that "a selection with one operand this
cannot describe is declined whole". So **one mirrored operand demotes an entire
boolean to the mesh path** — the exact path that #48 and #118/#111 were about.
`serverShapeBooleans.ts:105-110` says the same thing from the other side: a
mirror "reflects, which no rigid placement can express, so those shapes go the
long way round and lose their analytic surfaces in the process."

`cad.mirror(shape, point, normal)` (`index.d.ts:218`) produces a reflected
*body*. A mirror-as-operation that bakes into `cadBrep` — §3.1 option 3, no
format change, since `.skf` already stores `mirror` as a feature type
(`skfProject.ts:39`) and already writes the flags as a parameter record
(`:749-757`) — would let mirrored geometry back onto the exact boolean path.
That is a correctness win on a shipped feature, reachable with no new
`ShapeKind` and no format version bump. **First PR: `POST /api/v1/mirror` that
produces a new shape via `cad.mirror`, leaving the flags alone for existing
projects.** Small, and the first candidate after §5.1–5.4.

**Draft angles — blocked on a documented gap, not on the kernel.** The brief is
right that draft is not the taper the shapes carry: `taperTopWidth`,
`taperBottomWidth` and friends (`domain/sketchforge.ts:264-270`) are dimensions
at the top and bottom, from which an angle is implied, whereas
`draft(shape, face, angleRad, direction)` (`index.d.ts:156`) tilts a **named
face** of an arbitrary solid. `draftPrism(shape, dx, dy, dz, angleDeg)` (`:177`)
is the extrude-with-draft variant and is the easier of the two, because it needs
no face at all.

The blocker is association. `docs/SKF_PROJECT_FORMAT.md:73` already states it:
the workplane system "does not expose persistent associative face-workplane
references, so `.skf` cannot preserve an association that the editor itself does
not model." A draft on face 4 is exactly such an association. The §3.2
convention rescues the *operation* — name the face by index, apply, bake — but
not a re-editable draft.

**So the first PR is `draftPrism` on an extrude, not `draft` on a face.** It
needs no face reference, it is a parameter on an existing operation, and it
delivers the actual user need (a moulded or printed part that releases) without
touching the association question. Face-draft follows later, baked, with the
same "re-list after mutation" contract as everything else.

**Sweep — the biggest missing verb, and the one that needs a new concept.** The
brief is right that this is the largest gap: `sweep`, `sweepPipeShell`,
`sweepOriented`, `sweepWithLaw`, `pipe` and `simplePipe` are all declared
(`index.d.ts:168, 169, 176, 454, 157, 158`) and all unused, and pipes, handles,
cable channels and trim are all this one verb.

What makes it the most expensive is not the kernel call, it is that **the model
has no spine**. A sweep needs a path, and `WorkplaneShape` has no curve concept
except `sketchProfile` — points and segments with Bezier handles, in a plane
(`domain/sketchforge.ts:151-155`). So a first sweep has to either accept a planar
spine from an existing sketch, which is a real constraint but a shippable one, or
introduce a 3D path type, which is a new `ShapeKind`, a new `SHAPE_KINDS` entry,
a new `FEATURE_TYPES` entry, a `.skf` validator, an inspector, a viewport
representation and a 3D path editing UI.

**First PR: a planar spine from an existing sketch, profile from a second
sketch or a catalogue of round and rectangular sections, via `sweepOriented`
with `SweepMode.Fixed`.** That is `pipe` in everything but name, it covers
cable channels and handles, and it defers the 3D path. `SweepMode` and
`TransitionMode` are both real enums (`types.d.ts:154-176`) and the orientation
choice matters: `Frenet` twists the profile through a curve's torsion and
`Fixed` does not, which is the difference between a pipe and a corkscrew.

Size: large. Risk: sweeps fail on self-intersection and tight radii, in ways that
are the user's fault but arrive as a kernel error, so the refusal vocabulary
matters more here than anywhere else in this document. **What would make it not
worth doing:** if the spines people actually want are mostly planar arcs and
rounded rectangles, `revolve` plus the existing booleans may already cover enough
of the need that a 3D sweep is not the next thing.

---

## 6. The three I would do first

**1. §5.1, exact mass properties.** Smallest of the five, fixes a shipped number
that currently reads as a fact, and delivers centre of mass as a by-product. It
also supplies the bounding boxes that make §5.3 feasible, so it is a dependency
rather than just a neighbour. One `queryBatch` call; no format change; no new
`ShapeKind`; the editor change is a swap of one expression.

**2. §5.4 first PR, server-side projection.** The largest gap between what the
kernel offers and what the repo does by hand. It is a net deletion in the MCP
path, it makes `POST /exports` able to serve SVG for the first time, and
`toMultiviewSVG` was built for the exact consumer this project already has. It is
read-only and additive, so the downside is bounded: if the output is poor, keep
the existing export and take only the MCP swap, which is still a correctness fix.

**3. §5.3 first PR, interference.** This one shrank while I was writing it —
`validate_scene` already does the two-phase check, so it is not a new capability
— but it did not get less worth doing, because what it is missing is the three
things this project otherwise insists on: an engine module instead of an
11,285-line component, a REST route, and offline MCP parity. Making the narrow
phase exact comes almost free once it has moved. Cap it, document the cap, refuse
above it. If a quick look says the AABB lower bound is good enough for the real
question, do only the move and promote the §5.6 mirror operation into this slot.

Fourth, if there is room: **the mirror operation in §5.6**, because it is small
and because it un-demotes mirrored operands from the mesh boolean path.

I would explicitly **not** start with explode-assembly (§5.2) even though it is
the most striking demo, because its failure modes are a serialised kernel and an
undo history of whole-state snapshots (§8.1) rather than geometry, and both get
better if §5.1 and the autosave remainder land first.

---

## 7. Sketch constraints and a parametric feature tree: don't start

The brief asks for this specified honestly, "including why it might not be worth
starting". I think it is not worth starting, and the reasons are structural
rather than a matter of effort.

**What exists today.** Nothing. A case-insensitive grep for `constraint` across
`apps/web/src` and `packages/*/src` returns two hits, both the English word in a
comment about query strings. `SketchProfile` is points, segments with optional
Bezier handles, and reference images (`domain/sketchforge.ts:151-155`). Positions
are grid-snapped numbers (`SketchWorkspace.tsx:613-616`) and the dimensions drawn
beside a segment are **computed labels**, not drivers:
`segmentDimension(segment, pointById)` at `:216` measures the segment and
`formatDimension` at `:195` renders it. `docs/SKF_PROJECT_FORMAT.md:72` records
the gap as a deliberate limitation: "Geometric sketch constraints and dimensions
are not yet part of SketchForge's sketch data model."

**What a feature tree would need, that nothing else in this document needs.**
Persistent topological naming. Every other proposal here lives comfortably with
positional face and edge indexes because every other proposal is either a
momentary question (§5.1, §5.3, §5.4) or a bake (§5.6) — and §5.5, the one that
stores state against an index, is the one I flagged as uncomfortable for exactly
this reason. A feature tree is the opposite: its entire value is that "fillet
edge *e*" survives a change to the sketch that generated *e*. With positional
indexes it does not, and `.skf` says so in its own limitations
(`docs/SKF_PROJECT_FORMAT.md:71`): SketchForge "bakes the displayed result of
booleans and edge treatments… it does not add a new live parametric feature
editor that the application does not yet have."

The kernel does offer the raw material, and it would be dishonest not to say so:
the `*WithHistory` family — `filletWithHistory`, `chamferWithHistory`,
`shellWithHistory`, `mirrorWithHistory`, `intersectWithHistory`,
`offsetWithHistory`, `thickenWithHistory`, `rotateWithHistory`,
`scaleWithHistory` (`index.d.ts:440-452`) — each returns `EvolutionData` with
`generated`, `modified` and `deleted` face hashes. That is precisely what a
topological namer consumes. All nine are unused. So the kernel is not the
blocker; it is further along than the application is.

**The three things that make it the wrong next investment.**

1. **It is not additive.** Everything in §5 adds a route and a module. A feature
   tree changes what a shape *is*: `WorkplaneShape`'s seventy-field parameter bag
   with a baked `cadBrep` and whole-state snapshot undo becomes a node in a
   recomputed graph. `.skf` has a validated feature vocabulary already
   (`FEATURE_TYPES` at `skfProject.ts:39`, with `dependsOnFeatureIds` and a cycle
   check at `:1056-1070`) — but it is **derived on export** from the node graph,
   not authored: `skfProject.ts:749-757` synthesises a `mirror` feature out of the
   three boolean flags. The format is ahead of the application, which is
   encouraging, and the gap is still the entire application.
2. **The sketch editor is 1,364 lines of untestable `.tsx`.** A constraint solver
   is the single most test-hungry component in any CAD application, and
   `SketchWorkspace.tsx` is where it would have to live alongside its UI. The
   suite cannot import `.tsx` (§8). So the first honest step is not the solver,
   it is extracting a testable sketch model out of a component — which is
   `ENGINE_EXTRACTION.md` §6.1 again, for a different file, and which should be
   argued on its own merits rather than smuggled in under a feature.
3. **It competes with everything in §5 for the same scarce thing.** Five of the
   proposals above are small-to-medium, independently useful, and reach all the
   surfaces. A feature tree is none of those, and it is the kind of work that is
   either finished or worthless — a half-migrated model is strictly worse than
   either end state.

**What I would do instead, if the pull toward it is strong.** Two small things
that are useful alone and would be prerequisites anyway:

- **Driving dimensions on a single segment**, with no solver: let a sketch segment
  carry a target length and move its endpoint to match. That is one constraint
  type, no solver, no graph, and it answers the most common complaint about a
  snap-grid sketcher. It is also the honest test of whether the demand is for
  constraints or for *typing a number*.
- **Extract the sketch model out of `SketchWorkspace.tsx`** into
  `packages/sketchforge-engine/src/sketchModel.ts` so it can be tested at all.
  Worth doing whether or not a solver ever follows.

If both land and the appetite remains, the feature-tree conversation starts from
a testable sketch model and a real demand signal. It should not start from here.

---

## 8. Constraints, verified

| Constraint | Verified where | Status |
| --- | --- | --- |
| Engine boundary forbids app, React and Next imports | `tests/unit/engineImportBoundary.test.ts:7` | Holds, and is **broader and narrower than described**. Verbatim: `const forbidden = [/^@\//, /^react(?:\/|$)/, /^next(?:\/|$)/, /^@\/components/];`. Any `@/` alias is banned, so `@/i18n` is covered by the first rule rather than a rule of its own. Applies to `import` **and** `export … from` (`:20`). |
| …and covers the package, not the shims | `engineImportBoundary.test.ts:6` | `packageRoot` is `packages/sketchforge-engine/src` only. `apps/web/src/lib/engine` is **not** checked by this test. |
| `three` is banned under the engine | `engineImportBoundary.test.ts:38-43` | **Narrower than described.** Banned in exactly three files — `cadSolids.ts`, `loftProfile.ts`, `gearProfile.ts` — and `three` is a declared dependency of the package (`packages/sketchforge-engine/package.json:44`). A new engine module may import `three` unless it is added to that list. Any new CAD builder should be. |
| The suite cannot import `.tsx` | — | Holds. This is why §5 keeps new logic in engine modules and §7.2 is a blocker rather than an inconvenience. The two files that would otherwise host it are 11,285 and 8,468 lines. |
| A bounding box cannot see a mirrored or misplaced solid | `ENGINE_EXTRACTION.md:589-592`, commit `a966ba8` | Holds, and §5.1 is partly *for* this: `queryBatch` returns `centerOfMass` alongside `volume`, which is the pair the e2e tests already use (`primitiveGeometryAgreement.e2e.ts:157`). Verify new geometry by volume and centroid. |
| `npm run ci` is typecheck plus unit tests | root `package.json` `"ci"` | Holds, with two additions worth knowing: it is `engine:build && engine:typecheck && typecheck && typecheck:tests && client:typecheck && test`. The engine package is built first, so a package change that breaks the build fails everything. |
| e2e is not a required gate | `.github/workflows/ci.yml:26-33` | Holds, and the comment says why: "Compiling on demand makes this minutes rather than seconds, so it is deliberately not one of the required checks: it is signal, not a gate." It does run as a job on every PR. The three CI jobs are `checks`, `api-e2e`, `static-export`. |
| The static export has no server | `apps/web/next.config.ts`, `scripts/build-static.mjs` | Holds. `static-export` is a CI job. Everything in §5 is server-side, so each needs a browser story or a refusal — see below. |
| Dynamic path segments break the export | `docs/REST_API.md:66` | Holds, and it is why ids travel in the query string: "a dynamic path segment makes the static-export build fail outright, because an exported build has no server to resolve one against." **New routes must follow the `?projectId=&shapeId=` convention.** |
| A GET-only route gets prerendered and 404s | `apps/web/src/lib/apiV1Methods.ts:1-36` | **Watch this.** Three of the five proposals are read-only. `apiReadOnlyOptions()` is the escape hatch and `tests/e2e/productionApi.e2e.ts` is what catches a miss — which is not a gate. |
| `.skf` is the contract | `docs/SKF_PROJECT_FORMAT.md` | Holds. Nothing in §5.1, §5.3 or §5.4 touches it. §5.5 adds an optional field. §5.6's mirror operation bakes into `cadBrep` and needs no new feature type. Sweep and face-draft need a `FEATURE_TYPES` entry, and that is a compatibility event: unknown types are rejected on import (`skfProject.ts:1064`, `errors.skf.unknownFeatureType`), so an older reader refuses the file rather than degrading. |

**The static-export story, concretely.** §5.1's editor change must keep
`meshVolumeMm3` as a fallback — the exported build has no kernel, so the weight
readout has to degrade to today's number rather than disappear. §5.3 and §5.4 are
new API routes and simply are not present in a static export, which is the same
answer `POST /shell` and `GET /measurements` already give. That is the honest
refusal the brief asks for, and it is already the established shape of it.

Three existing patterns to copy rather than reinvent, in increasing order of
preference. The build-time flag `NEXT_PUBLIC_STATIC_EXPORT`
(`next.config.ts:19-21`, read at `page.tsx:161` and `SketchForgeEditor.tsx:266`)
hides UI. The REST-level refusal is a `404` with code `api_disabled` and a
sentence saying what to set (`apps/web/src/lib/apiV1.ts:84`, rationale at
`:17-25`). Best is the **runtime capability probe**: `probeServerProjects`
(`apps/web/src/lib/serverProjectStore.ts:80`) returns a listing carrying an
explicit `enabled: boolean` (`:65-68`), is called with `.catch(() => null)`
(`page.tsx:789`), and lets the UI name the actual state rather than guessing from
a build flag. §5.1's fallback should use that shape.

And one ready-made piece nothing uses: `serverCadAvailable()` exists at
`packages/sketchforge-engine/src/serverCadKernel.ts:52` — "Whether this process
can run CAD operations at all" — and has **no first-party caller**. It is the
natural predicate behind a CAD capability probe, and §5.1's editor fallback is
the first thing that would want it.

### 8.1 Two live items, folded in rather than duplicated

**The #97 autosave remainder.** `e9cb8e8` ("fix: reduce autosave work and batch
keyboard movement history") has landed, so only the remainder is in scope. What
it did, so the remainder is not double-counted: it stopped re-deriving live
history on every save (`liveEditorHistoryState`, `editorHistory.ts:324`, whose
comment at `:317-322` names #97 and says re-canonicalising entries "was the
longest unyielded block of a save"); interned display edges, mesh arrays, B-Rep
strings and image data URLs once per immutable resource across states
(`docs/SKF_PROJECT_FORMAT.md:40`); batched a held arrow key into one history
entry (`apps/web/src/lib/keyboardMovement.ts`); and added the benchmark at
`tests/perf/skf-project.perf.ts:73`, 200 shapes × 60 history steps. Earlier
rounds — `570b810`, `677aa98`, `12ffe15` — and the latest-wins coalescing queue
(`apps/web/src/lib/saveQueue.ts:24`) are also already banked.

**The serializer still has one loop.** `exportSkfProject` (`skfProject.ts:797`)
walks every requested history entry and calls `serializeState(stateId,
entry.shapes, …)` for each (`:812-821`), deduplicating by fingerprint but fully
serialising every *distinct* state. This remains O(distinct requested states ×
scene size) in node graphs, which resource interning cannot reach. Depth is
bounded by `MAX_EDITOR_HISTORY_ENTRIES = 5000` (`editorHistory.ts:4`), and
`"unlimited"` resolves to 4,999 retained actions (`:282-284`).

Two things sharpen the brief's framing of the fix:

- **A shallower persisted history needs no format change.** `history.entries` is
  an ordered list of `{ stateId, selectedObjectIds }` with an `index`
  (`skfProject.ts:820, :846`), and the reader requires only that `history.index`
  be in range and that `entries[index].stateId` match the scene state
  (`:1181-1188`). A truncated history is a valid v2 document, and
  `docs/SKF_PROJECT_FORMAT.md:52` already frames depth as an export *choice*
  (Unlimited / 100 / 50 / 30). **Incremental** state storage is the one that
  needs a bump, because states are whole graphs today (`:29, :40`).
- **Autosave now sends a shallow history request.** The browser autosave caller
  applies `editorHistoryForAutosave` before calling `exportSkfProject`, retaining
  up to 30 actions around the active index. The `.skf` v2 format and reader need
  no change; live editor history remains intact, and explicit `.skf` export
  continues to use its selected depth through `editorHistoryForExport`
  (`SketchForgeEditor.tsx:9125`). An explicitly unlimited export can still
  serialize every retained state; incremental state storage would address that
  separate case.

**Two things in this document touch it.** §5.2's explode turns one shape into
potentially thousands, in a format that stores a graph per retained state — so
the autosave remainder bounds how large an explode can be before saving dominates
the cost, which is a second reason, alongside the serialised kernel and the
200-solid import gate, for a conservative default. And a sequencing note: if
incremental state storage is chosen, it changes `states`, which is the section
every proposal in §5 writes into — landing it before the format-touching
proposals (§5.5, sweep, face-draft) avoids rebasing them onto it. A
caller-side shallower history has no such interaction and can land any time.

**STEP import: already fixed, see §2.7.** The brief asked me to mention it as
context and not specify it; it turns out to need no specification at all, because
`53e086e` landed it. The one thing worth carrying forward is that §5.2 depends on
it — explode re-reads a project's STEP source asset on the server — and that the
`sourceImporter` injection it introduced
(`serverProjectDocument.ts:85-91`) is the seam §5.2 should use.

---

## 9. What I verified, and what I assumed

**Verified by reading the code.** Every row of §1, from the kernel's own
declarations plus the three-pass usage search described there. The corrections in
§2 — all eight, each with the call site that settles it, including the three that
took a recommendation apart and rebuilt it: the 200-solid exact-geometry gate at
`stepImportKernel.ts:45`, the mesh-connectivity basis of `POST /parts` at
`serverShapeGroups.ts:419-495`, and the existing two-phase clash check at
`SketchForgeEditor.tsx:8169-8212`. The shape model in §3.1 and
the index-addressing convention in §3.2, read from both the type and the REST
documentation that commits to it. The surface checklist in §3.4, traced through
two shipped capabilities (measurement `4e11705`, shell `41cdcf8`) and
cross-checked against a third (`1ce7865`, align/distribute/pattern) because the
first two have no editor UI at all. Every row of §8.

**Assumed, or read but not run.**

- **That `toSVG` and `toMultiviewSVG` produce good output on this project's
  shapes.** I read the declarations and the doc comments; I did not render
  anything. §5.4's first PR should begin by rendering a thread, a loft and an
  imported mesh and looking at them. If they are poor, §5.4 shrinks to the MCP
  swap and recommendation 2 should be replaced by the mirror operation.
- **That `queryBatch`'s `centerOfMass` is a true volumetric centroid** rather
  than a surface or vertex average. The e2e tests trust its `volume` and `bbox`;
  nothing in this repo has asserted `centerOfMass`. §5.1's first test should be a
  cone, whose centroid is a quarter of the way up and so distinguishes the three
  possible answers.
- **The interference cost model.** The 3.6-million-pair figure is arithmetic on
  the owner's 2,689-solid count, not a measurement. The bbox prefilter's
  effectiveness depends entirely on how spatially clustered a real assembly is,
  and I have no number for that. Measure the prefilter's hit rate on the real
  file before choosing a cap. The existing `validate_scene` broad phase
  (`SketchForgeEditor.tsx:8177-8188`) is where those numbers already exist in
  practice — ask it before rewriting it.
- **That per-solid `brepStep` is affordable where the whole compound's was not**
  (§5.2). This is the load-bearing assumption of that proposal and it is
  reasoning, not measurement: the import gate declines the exact geometry for the
  compound because turning and moving 2,689 solids at once "can exhaust the
  kernel" (`stepImportKernel.ts:113-116`), and I am inferring that the same work
  one body at a time, under an explicit limit, is a different cost profile. If it
  is not, §5.2's first PR produces mesh shapes like `/parts` already does and
  loses most of its reason to exist. **Test this first**, on the 2,689-solid file,
  before writing anything else in that proposal.
- **The "~75% of a save" figure for the undo history** (§8.1). I found the
  mechanism — the full-graph-per-distinct-state loop at `skfProject.ts:812-821` —
  but no measurement backing that proportion. `tests/perf/skf-project.perf.ts:73`
  is the benchmark that could produce one.
- **That no slicer-side work is needed for per-face colour.** §5.5 flags this as
  the thing to check first, and I did not check it.
- **The desktop memory cost of two kernel instances** (§3.3). I read both
  loaders; I did not measure a running process.
- **That `draftPrism` is reachable without a face.** The signature
  (`index.d.ts:177`) takes a shape and a direction with no face argument, which
  is why §5.6 proposes it first — but I have not confirmed which faces OCCT
  chooses to draft, and on a non-prismatic input that may not be the ones a user
  expects.
