---
slug: "/docs/ENGINE_EXTRACTION"
title: "Scoping an extracted geometry engine"
audience: "Contributors"
owner: "Engine"
sources:
  - "packages/sketchforge-engine/src/**"
---

# Scoping an extracted geometry engine

Status: core extraction and local MCP mode implemented in the current branch. Sections 1–5 and most of 7–8 are the original architecture audit and historical rationale; check the implementation status below for what is now live.

**Implemented:** `packages/sketchforge-engine` owns the geometry and project modules; `apps/web/src/lib/engine` keeps compatibility re-exports; the app imports the package; release version checks include its manifest; and the MCP can operate directly on project directories using `SKETCHFORGE_PROJECTS_DIR`, without a browser, server, or API token. Local MCP supports project operations and SKF/STEP export. UI-only tools and other export formats remain editor-backed. The package is local to this repository and has not been published.

The geometry engine lives inside the Next app, in `apps/web/src/lib`, and is
reachable from outside only through HTTP route handlers. This document scopes
pulling it out into something the Next app, the MCP bridge and the client
libraries all import, judges the two payoffs that motivate it, and proposes a
staged sequence.

**Recommendation, in short: do the extraction, but invert the usual order. Ship
the de-duplication first and the package last.**

Every line of value in payoff 2 — killing the duplicated-geometry class of bug —
is available from shared `.ts` modules *inside this repository*, with no new
package, no `release-please` entry, no npm publish and no licence question. #48
is the proof: it took the largest single piece of that payoff with nine files
and no packaging change at all. That work is also what makes the rest cheap,
because it is what gives the engine a boundary in the first place. Payoff 1 —
offline macros — genuinely needs a package, but it is the smaller prize, it is
narrower than it first appears (§9), and it depends on the earlier stages
anyway. Publishing the package to npm is a separate decision from building it,
and §8 argues for deferring that indefinitely.

The strongest argument is not either stated payoff. It is that this duplication
is demonstrably still producing bugs, and that the fixes keep arriving one at a
time after the bug has shipped. In the five commits that landed while this was
written: #45 fixed a rotation composition that had survived 947 tests (§1.4),
and #48 fixed two upstream boolean defects by moving the editor onto the
server's exact builders (§1.2). I believe I found a third, still live and still
uncovered, in the gap those two left (§1.5).

Both of those fixes moved in the direction this document argues for, and #48
reused a server module from the browser rather than copying it — which is the
whole proposal, applied once. The case below is for finishing the job in the
one place that cannot be fixed reactively: the primitive builders, which are
copied verbatim into two `.tsx` files where no test can reach them (§1.1).

A note on freshness: `origin/main` moved five commits while this was being
written — `72ed724` → `d42cc47` (#45–#49) — and two of those changed the picture
materially. **#45** fixed the rotation composition bug (§1.4) and **#48** moved
the editor's booleans onto the exact kernel (§1.2), which is substantially the
stage this document had proposed as PR 5. Everything below is read against
`d42cc47`. Where recent work has already done something proposed here, the
document says so rather than claiming it as outstanding.

---

## 1. What is actually duplicated

Verified by reading both implementations. Citations are `file:line` against
`origin/main` at `d42cc47`.

### 1.1 Primitive geometry: built three times, from three dispatches

| Implementation | Dispatch | Kinds | Backend |
|---|---|---|---|
| Editor viewport | `apps/web/src/components/WorkplaneViewport.tsx:7999` | 20 | three.js geometry helpers |
| Editor booleans | `apps/web/src/components/SketchForgeEditor.tsx:2188` | 19 | three.js geometry helpers |
| Server | `apps/web/src/lib/serverCadSolids.ts:323` | 14 | exact OCCT |

Three dispatches over the same `shape.kind` union must stay in lockstep. Nothing
enforces that they do.

Worse, the first two are *the same code, copied*. `WorkplaneViewport.tsx` has a
block of eight pure primitive builders at lines 8431–8630, and
`SketchForgeEditor.tsx` carries a near-verbatim second copy at lines 1966–2181
under `createBoolean*` names:

| Viewport | Editor copy | Difference |
|---|---|---|
| `createRoofGeometry` 8439–8458 | `createBooleanRoofGeometry` 1966–1984 | trailing `.toNonIndexed()` only |
| `createWedgeGeometry` 8459–8477 | `createBooleanWedgeGeometry` 1986–2004 | trailing `.toNonIndexed()` only |
| `createPyramidGeometry` 8479–8506 | `createBooleanPyramidGeometry` 2006–2033 | trailing `.toNonIndexed()` only |
| `createRoundRoofGeometry` 8558–8571 | `createBooleanRoundRoofGeometry` 2035–2048 | trailing `.toNonIndexed()` only |
| `createHalfSphereGeometry` 8573–8630 | `createBooleanHalfSphereGeometry` 2050–2094 | **behaviour differs** — see below |
| `createTorusGeometry` 8508–8516 | `createBooleanTorusGeometry` 2096–2104 | trailing `.toNonIndexed()` only |
| `createHollowCylinderGeometry` 8518–8556 | `createBooleanHollowCylinderGeometry` 2106–2144 | identical |
| `addTextShape` 8391–8429 | `createBooleanTextGeometry` 2146–2181 | parallel |

I diffed `createWedgeGeometry` against `createBooleanWedgeGeometry` line by
line: the vertex arrays, the 18-entry index arrays and the attribute setup are
byte-identical. The only difference is the last statement.

The half-sphere pair is the one that has already drifted. The viewport emits
analytic ellipsoid normals plus a dedicated bottom-cap normal of `(0, -1, 0)`;
the editor's copy calls `computeVertexNormals()`. Same shape, different shading
and different normals feeding the CSG evaluator.

Both are expressible as two options — `indexed` and a normal strategy — on one
implementation. That is the whole of the first PR (§6.1).

### 1.2 Booleans: four backends, now with the exact one in front

As of **#48** (`fix: cut editor booleans on the exact kernel`) the editor's cut
goes to OCCT in the CAD modifier worker, with each operand built from its own
parameters by `exactSolidForShape` — the same builders the server uses. That
commit also settles the question §1.2 originally had to take on trust: it states
outright that upstream **#118** ("combining a negative space cylinder with a
block results in a broken mesh") and **#111** ("Tapered Box combined with other
object results in square not tapered hole") "are the same bug: the editor's cuts
were mesh cuts, so every operand reached the CSG as triangles. A negative
cylinder arrived as a 96-sided prism and left 96 planes where there should be
one cylindrical face; a tapered cutter's slope was lost wherever a path stood a
plain box in for it."

So the headline mesh-CSG defect is fixed, and fixed the way this document would
have asked for — by *reusing* the server's exact builders rather than copying
them. `exactBooleanSolids.ts:23` imports `exactSolidForShape` from
`serverCadSolids`, and `serverCadSolids.ts` was relabelled in the same commit:

> Despite the name this is not Node-only: nothing here touches the filesystem or
> loads a kernel, it only drives the `OcctKernel` it is handed. The CAD modifier
> worker builds boolean operands with it in the browser, for the same reason the
> server does -- an exact cut needs an exact operand.

That paragraph is this document's thesis, already written by someone else, about
one module. The rest of this document is the case for applying it to the other
forty.

**What remains.** The mesh backends are still there, as fallbacks, and
`exactBooleanParts.ts:20-21` is explicit that a selection with one
undescribable operand is "declined whole, and the editor falls back to its mesh
booleans". So all four backends coexist:

| Backend | Where | Role now |
|---|---|---|
| OCCT, worker | `exactBooleanSolids.ts` ← `cadModifier.worker.ts:7` | the cut, when every operand can be built exactly |
| three-bvh-csg, main thread | `SketchForgeEditor.tsx:7` | fallback; also `importedBooleanMeshShape`'s attempt ladder for imported meshes |
| manifold-3d, main thread | `SketchForgeEditor.tsx` | fallback, and sketch revolve/extrude |
| OCCT, server | `serverShapeBooleans.ts` | the REST API's cut |

Two things follow for this proposal. First, the fallback is not dead code — a
mirrored operand is excluded by construction (`exactBooleanParts.ts:42-46`
explains why: the exact builders bake rotation in, and a mirror must be applied
before it), as are imported meshes and the kinds outside `EXACT_SOLID_KINDS`. So
the mesh path keeps working and keeps needing its padding. Second, the *server*
and the *worker* now run the same exact cut through two separate orchestrations
— `serverShapeBooleans.buildGroupFromSelection` and
`exactBooleanSolids.exactCutFromParts` — which is a smaller duplication than the
one that was just removed, but it is the same shape of thing, and §1.5 is a bug
living in exactly that gap.

`cutterPadding.ts` is still the clearest statement of why the mesh path is the
unreliable one (`:4-10`):

> A cutter face that lands exactly on a solid's face is coplanar, which the CSG
> evaluator resolves unpredictably -- it leaves slivers, or drops the face
> entirely. Growing the cutter slightly moves those faces off each other.

#48 did not delete that file. It added `cutterShapeForBoolean(shape, kernel)`
(`:69`), which returns the padded shape for `"mesh"` and the shape untouched
for `"exact"`, with the comment "This is the one place that decides, so neither
path can drift from the other." That is the right move while two paths exist,
and it is the pattern the rest of this work should copy: not deleting the old
path, but making one place responsible for choosing between them.

### 1.3 Three different paddings for one problem

| Constant | Value | Where | Used for |
|---|---|---|---|
| `CUTTER_PADDING` | 0.05 | `cutterPadding.ts:11` | the committed cut |
| `CUTTER_RESIDUAL_INSET` | 0.02 | `cutterPadding.ts:14` | inside-test tolerance after padding |
| `CUT_PREVIEW_PADDING` | 0.01 | `WorkplaneViewport.tsx:109` | the live cut-preview highlight |
| (none) | 0 | `cutterShapeForBoolean(shape, "exact")` | the committed exact cut, since #48 |

#48 centralised the mesh-vs-exact choice in `cutterShapeForBoolean` but did not
touch the preview, which still grows the hole by `CUT_PREVIEW_PADDING` in
`WorkplaneViewport.tsx` before its `HOLLOW_INTERSECTION` evaluate. So the
highlight a user sees before clicking is padded by 0.01, and the cut they now
get is padded by 0 — a different mismatch from the 0.01-vs-0.05 one that existed
before, and still unacknowledged in the code. The preview is also still a mesh
CSG, so on exactly the geometry #118 and #111 describe it will disagree with the
exact result in kind, not just in size.

This is small and cheap to fix, and it is a good early candidate independent of
everything else here.

### 1.4 Rotation: the composition bug, fixed last week, that nothing could see

`exactSolidForShape` used to compose rotation by hand with a negated yaw, in the
opposite order to the editor's `THREE.Euler(rotationX, rotation, rotationZ,
"XYZ")` (`geometryRotation.ts:38-47`). So a shape that had been rotated and was
then filleted, chamfered or exported to STEP came back facing somewhere else.

This landed as **#45** (`fix: turn exact solids the way the editor turns them`)
while I was writing this document — `origin/main` moved from `72ed724` to
`d42cc47` mid-review. The current code at `serverCadSolids.ts:389-410` is
correct, and the comment it now carries is the clearest statement of the problem
this document exists to address:

> This used to negate the yaw and apply the three in the opposite order, and
> nothing noticed, because the shapes anyone had filleted while turned were
> symmetric: a box or a cylinder is unchanged by the 180-degree error a negated
> yaw produces, and a single pitch or roll was already right.

The commit message records that **four of seven** representative rotations
disagreed, and — the number that matters here — that flipping the yaw sign
either way left **all 914 unit tests and all 33 end-to-end tests passing**. The
suite had no coverage of the question at all. Its new test,
`tests/e2e/exactSolidRotation.e2e.ts`, measures the solid's centre of mass
against the editor's own matrix, because "a bounding box cannot see this, since
mirroring a solid does not change its extents" — the same blind spot that had
earlier hidden a box built from one corner on one side and from its centre on
the other (`docs/CHANGELOG.md`).

So the duplication is not producing bugs hypothetically. It produced one that
shipped, survived 947 tests, and was fixed four commits ago. That is the
evidence. The question this document answers is what stops the next one.

### 1.5 A second rotation bug, still live, still uncovered

While checking the above I found one the fix did not touch. `#45` corrected *how*
`exactSolidForShape` composes rotation; it did not address *whether it should be
composing it at that point in the call path at all*.

Follow `POST /api/v1/booleans` with a rotated parametric operand on
`d42cc47`:

1. `serverShapeBooleans.ts:74` — `localSolidForShape(cad, shape)`
2. `serverCadOperations.ts:154` — `return exactSolidForShape(cad, shape)`, which
   **bakes the shape's rotation in** (`serverCadSolids.ts:406-408`)
3. `serverShapeBooleans.ts:79` — `shapePlacementMatrix(shape)`, which
   **rotates it again** (`serverShapeGroups.ts:69-73`)

A rotated parametric operand therefore appears to be rotated twice. Now that
`#45` has aligned the two compositions, it is rotated twice by the *same*
rotation — which is a cleaner and more obviously wrong bug than it was a week
ago, not a fixed one.

The docstrings already disagree about it. `localSolidForShape` is documented at
`serverCadOperations.ts:140-146` as returning the solid "in its own local
frame", and `serverShapeBooleans.ts:59-67` says everything that is not a stored
mesh "is built exactly from its parameters and then moved into place" — but for
a parametric shape `localSolidForShape` hands back a solid that is already
turned. Meanwhile `exactSolidForShape`'s own docstring
(`serverCadSolids.ts:380-386`) says baking rotation in is deliberate, and it is
— for the fillet path, where the result is stored as an unrotated mesh. The two
callers need different things from one function and both call it.

I have not run this: it needs the OCCT kernel and a project on disk, and I was
scoped to read rather than execute. State it as a strong reading of the code
pending a reproduction. What I did verify is that **nothing would catch it**:
`grep -rn "buildGroupFromSelection" tests/` returns nothing. The server's
boolean entry point has no test at all, and `tests/unit/apiV1Booleans.test.ts`
does not exercise rotation. The new `exactSolidRotation.e2e.ts` tests
`exactSolidForShape` directly, so it passes either way.

Note also `treatmentBakesRotation` (`serverCadOperations.ts:132-135`), which
exists precisely to track which of the two frames a result is in. That function
is the shape of the problem: a flag threaded through the call graph to say which
of two conventions the value in hand obeys. An engine with one frame convention
and one placement step would not need it.

---

## 2. Inventory

### 2.1 What moves

The transitive closure of `@/`-imports from the ten server-side and
format entry points is **41 files, 9,995 lines**. Computed mechanically, then
classified by hand:

| Module | Lines | Moves? | Why |
|---|---|---|---|
| `lib/skfProject.ts` | 1524 | **yes, as-is** | The format contract. Already isomorphic; the only `document.` references are a local variable, not the DOM. |
| `lib/serverShapeGroups.ts` | 468 | **yes** | Placement, grouping, world-mesh maths. Uses `three` at runtime but no DOM. |
| `lib/shapeRequests.ts` | 443 | **yes** | Pure. Already documented as the shared parameter table. |
| `lib/serverCadSolids.ts` | 419 | **yes** | The exact builders. **Already shared with the browser** since #48, and its own docstring now says the `server` prefix is a misnomer. Rename on the way out. |
| `lib/exactBooleanSolids.ts` | 163 | **yes** | New in #48. Already written kernel-agnostic, "called from the CAD modifier worker in the browser and from Node in the tests". This is what an engine module looks like. |
| `lib/exactBooleanParts.ts` | 171 | **yes** | New in #48. Selection → worker operands. |
| `lib/serverCadOperations.ts` | 375 | **yes** | Fillet, chamfer, mesh→solid. Still labelled Node-only; worth re-checking whether that is still true, as `serverCadSolids`' label was not. |
| `lib/stepExport.ts` | 377 | **yes** | Shares profile maths with the solids. |
| `lib/editorHistory.ts` | 391 | **yes** | Pure; `skfProject` depends on it. |
| `lib/revolveRequests.ts` | 318 | **yes** | Pure + manifold. |
| `lib/serverShapeBooleans.ts` | 178 | **yes** | The exact cut. |
| `lib/workplaneShapes.ts` | 323 | **yes** | `canonicalizeShape` — the normalizer both sides must agree on. |
| `lib/sketchRevolve.ts` | 412 | **yes** | |
| `lib/workplaneSettings.ts` | 219 | **yes** | Pure normalizers `skfProject` needs. |
| `lib/shapeCatalog.ts` | 219 | **yes** | |
| `lib/projectAssets.ts` | 191 | **yes** | `globalThis.crypto.subtle` only (`:107`) — present in Node 18+. |
| `lib/serverProjectFiles.ts` | 152 | **yes** | `node:fs` project directory. Node-only by design. |
| `lib/serverProjectDocument.ts` | 143 | **yes** | Read/mutate/write a stored project. |
| `lib/stepProfiles.ts` | 122 | **yes** | Pure. |
| `lib/threadCatalog.ts` | 128 | **yes** | Pure. |
| `lib/serverCadKernel.ts` | 101 | **yes, behind an injection seam** | §4. |
| `lib/serverManifoldRuntime.ts` | 32 | **yes, behind an injection seam** | §4. |
| `lib/regularPolygonFootprint.ts` | 37 | **yes** | Pure; already shared by all three dispatches. |
| `lib/meshTransform.ts`, `meshCoordinates.ts`, `localIds.ts`, `booleanPrimitives.ts`, `sphereTessellation.ts`, `cadModifierGroups.ts` | ≤59 each | **yes** | Small and pure. |
| `lib/loftGeometry.ts` | 459 | **split** | Mixes `normalizeLoft*` (server needs) with a `THREE.BufferGeometry` loft mesh builder. Only the normalizers belong in a kernel-side module. |
| `lib/gearGeometry.ts` | 240 | **split** | Same shape of problem: normalizers plus a mesh builder. |
| `lib/objImport.ts`, `stlImport.ts`, `svgImport.ts` | 263 / 142 / 635 | **yes** | `skfProject` imports all three. `svgImport` is the awkward one — 635 lines, uses `three` and manifold. |
| `lib/cutterPadding.ts` | 71 | **yes, keep** | No longer "delete": #48 made it the one place that chooses mesh-vs-exact padding, and the mesh fallback is still reachable. §1.2. |
| `lib/cadBakeMetadata.ts` | 282 | **probably** | `three`-heavy, no DOM. Needs a closer look than I gave it. |
| `lib/placementWorkplane.ts` | 237 | **yes** | `three` maths. |
| `WorkplaneViewport.tsx:8431-8630` | ~200 | **yes, extracted** | The eight pure builders. §6.1. |
| `SketchForgeEditor.tsx:1966-2181` | ~215 | **deleted** | The duplicate. |
| `types/sketchforge.ts` | 321 | **yes** | The shape union. |

### 2.2 What stays

| Module | Lines | Why it stays |
|---|---|---|
| `components/WorkplaneViewport.tsx` | 8670 | Renderer, camera, overlays, pointer handling. Lines 5634–7505 are DOM- and `DOMRect`-coupled throughout. |
| `components/SketchForgeEditor.tsx` | 11263 | React state, history wiring, the whole UI. |
| `lib/serverProjectStore.ts` | 141 | Despite the name this is the **browser's** `fetch` client for `/api/projects`. Misleading; worth renaming independently of this work. |
| `lib/useRotationMode.ts` | 91 | A React hook. |
| `lib/appTheme.ts` | 47 | `window.matchMedia`, `document.documentElement`. |
| `lib/sketchforgeMcpStore.ts`, `sketchforgeMcpProtocol.ts` | 200 / 138 | The live-editor bridge. Belongs to the app, not the engine. §9. |
| `lib/shapeProperties.ts` | 507 | Inspector field definitions — UI, and imports `Translator`. |
| `lib/measurementUnits.ts`, `shapeDisplayNames.ts` | 136 / 26 | Presentation. |
| `workers/cadModifier.worker.ts` | 517 | `self.postMessage`. Already documented at `serverCadOperations.ts:11-15` as deliberately not reused, to avoid conflicting with upstream. Agree — leave it. |
| `app/api/**/route.ts` | 1894 total | HTTP parsing and status codes. Thin already (§5). |

### 2.3 What has to be untangled first

**The `@/i18n` landmine is real but narrower than feared.** `@/i18n/index.ts:29`
re-exports `useTranslations`, which pulls React. Four engine-adjacent modules
import from it — `loftGeometry.ts:6`, `shapeProperties.ts:8`,
`measurementUnits.ts:1`, `shapeDisplayNames.ts:1` — but all four are
`import type`, erased at compile time, which is why the server bundle works
today. `@/i18n/LocalizedError.ts` is the React-free entry point and says so at
`:14`; `tests/unit/localizedImportErrors.test.ts` asserts that import errors are
`LocalizedError` instances with both an English message and a translation.

Consequence: an extracted module may depend on `LocalizedError` and on
`@/i18n/locales` types, and must never import `@/i18n`. Of the four, only
`loftGeometry.ts` is in the move set, and only for its normalizers — the split in
§2.1 drops the import anyway. Per the project's standing position on i18n,
nothing here invents translations: `LocalizedError` keys move unchanged.

**Things that are genuinely entangled:**

- `loftGeometry.ts` and `gearGeometry.ts` each mix kernel-side normalizers with a
  three.js mesh builder. `serverCadSolids.ts:15-21` imports the former and drags
  the latter into the server bundle today.
- The eight builders at `WorkplaneViewport.tsx:8431-8630` are clean — I grepped
  the range for `window|document|React|use[A-Z]|Texture|canvas` and got zero
  hits. Their only non-local dependencies are `regularPolygonFootprintScale`
  (imported at `:44`) and a local `clamp` at `:547`.
- `createImagePlateMaterials` is the only DOM touch in the band of geometry
  helpers that precedes the builders — it calls `imageTextureLoader.load`. It stays.
- The `sharedShapeGeometry` cache family is module-global mutable
  state. It stays; the extracted builders become its backing implementation.

---

## 3. Testability, counted as a benefit

`tests/vitest.config.ts:15` includes only `tests/unit/**/*.test.ts`;
`tsconfig.tests.json:13-16` includes only `tests/**/*.ts` and `.d.ts` files.
There is no JSX plugin in any of the four vitest configs, `@vitejs/plugin-react`
is not installed, `environment` is `"node"` in all four, and neither `jsdom` nor
`happy-dom` is installed. `find tests packages -name "*.tsx"` returns nothing.

So: **tests cannot import `.tsx`**, and the two tests that reach into components
either import a plain `.ts` sibling (`transformOverlayTypes.ts`) or read the
`.tsx` as *text* (`tests/unit/mcpEnglishNotices.test.ts:8`).

This is a convention plus a configuration, not a law of physics — adding the
plugin, a DOM environment and the globs would lift it. But it is the convention,
and it means roughly 19,860 lines of `.tsx`, including every mesh primitive
builder and all three mesh-boolean backends, are **currently untestable by this
harness**. The rotation bug in §1.4 survived 914 unit tests precisely because the
thing it disagreed with was unreachable from a test.

Every builder moved out of `.tsx` into `.ts` becomes testable the moment it
lands. That is not a side benefit of this work; for the first PR it is the entire
deliverable.

**And the pattern is now established in-repo.** #48's
`tests/unit/exactEditorBooleans.test.ts` (351 lines) runs OCCT under Node, in
the ordinary unit suite, and measures "the volume and the centre of mass of the
result, against the arithmetic for the same cut" — with an explicit note on why
not bounding extents:

> A hole cut at the wrong size, in the wrong place, or with its taper dropped
> leaves the result's bounding box completely unchanged -- it is still the block.

It even measures the old mesh path alongside, as "the before numbers". That is
the template for every agreement test this document proposes, and it exists
because the geometry it tests had just been moved into a `.ts` module. The
causal link between extraction and testability is no longer hypothetical here.

---

## 4. One package, two kernel loaders

The kernel loads differently on each side, and the asymmetry is not incidental —
it is forced by Emscripten.

- **Browser.** `lib/brepKernel.ts:10-11` holds `OCCT_INDEX_URL = "/occt/index.js"`
  and `OCCT_WASM_URL = "/occt/occt-wasm.wasm"`, imported with
  `/* webpackIgnore: true */` at `:25`. The comment at `:5-9` says why: the glue
  "self loads ./occt-wasm.js relative to its own URL and does not survive
  bundling". The files are staged by `scripts/copy-occt-wasm.mjs` (`node_modules/occt-wasm/dist`
  → `apps/web/public/occt`), run by `predev` and `prebuild` and by
  `apps/desktop/build-web.mjs:28`. The two workers hardcode the same base —
  `lib/cadModifierRuntime.ts:8` is `CAD_MODIFIER_RUNTIME_BASE = "/occt"`.
- **Node.** `lib/serverCadKernel.ts:29-35` imports `occt-wasm` and
  `occt-wasm/dist/occt-wasm.js` directly, with a comment at `:31-33` explaining
  that it deliberately does *not* use the staged copy.
- **Why it must stay that way.** `next.config.ts:31` lists
  `serverExternalPackages: ["occt-wasm", "manifold-3d"]`, and the comment at
  `:25-30` records the failure mode: the bundled copy fails at runtime with
  "createRequire is not a function". The brief notes this has bitten twice.
- Manifold is a third variant: the editor loads it from *bundled generated
  source plus base64 WASM* through a blob URL
  (`SketchForgeEditor.tsx`), not from the package.

**The plan: the engine package never loads a kernel.** It declares what it needs
and the host supplies it.

```ts
export type EngineKernels = {
  occt: () => Promise<OcctKernel>;
  manifold?: () => Promise<ManifoldToplevel>;
};
export function createEngine(kernels: EngineKernels, store: ProjectStore): Engine;
```

- `occt-wasm` and `manifold-3d` are **peer dependencies with `peerDependenciesMeta.optional`**,
  and `import type` only. No runtime import of either appears anywhere in the
  package, so there is nothing for a bundler to mangle and
  `serverExternalPackages` keeps working unchanged for the host.
- The Node loaders stay where they are, in the app, as the ~130 lines they
  already are. The package's `createEngine` takes them.
- The browser's loaders and the two workers are untouched. Nothing about the
  `/occt/` URL contract changes.
- A macro runner constructs its own 15-line Node loader, or imports a
  `sketchforge-engine/node` subpath export that does it. That subpath is the one
  place a runtime `import("occt-wasm")` lives, and it is never reachable from a
  browser condition.

This also sidesteps the static-export problem by construction (§7).

**This design is no longer speculative.** #48 needed exactly it, and arrived at
it independently: `serverCadSolids.ts` now runs in a browser worker and under
Node without change, because it "only drives the `OcctKernel` it is handed", and
`exactBooleanSolids.ts` describes itself as "kernel-agnostic on purpose. It is
called from the CAD modifier worker in the browser and from Node in the tests,
which is what lets the geometry be checked against closed-form volumes rather
than against a screenshot." Take-the-kernel-as-an-argument is already the
house style for the modules that have had to cross this boundary; the proposal
is to make it the rule rather than the exception.

---

## 5. The public API

Judged against the two real consumers. The surface is deliberately small; the
engine's job is geometry and format, not transport.

```ts
// --- the project, as a document on disk -------------------------------------
type ProjectStore = {
  read(projectId: string): Promise<ProjectDocument | null>;
  write(projectId: string, document: ProjectDocument,
        shapes: WorkplaneShape[]): Promise<{ revision: number }>;
  withLock<T>(projectId: string, work: () => Promise<T>):
        Promise<{ busy: boolean; result?: T }>;
  list(): Promise<ProjectSummary[]>;
};
function directoryProjectStore(root: string): ProjectStore;   // node:fs
function packageProjectStore(bytes: Uint8Array): ProjectStore; // a single .skf

// --- the format -------------------------------------------------------------
function importSkfProject(bytes: Uint8Array): Promise<ImportedProject>;
function exportSkfProject(project: ExportableProject): Promise<Uint8Array>;

// --- shapes, from parameters -------------------------------------------------
function shapeFromRequest(request: ShapeRequest): WorkplaneShape | null;
function shapeWithRequestedChanges(shape, changes): Result<WorkplaneShape>;
function canonicalizeShape(shape: Partial<WorkplaneShape>): WorkplaneShape;
const REQUESTABLE_SHAPE_KINDS: readonly RequestableShapeKind[];

// --- geometry ---------------------------------------------------------------
function meshForShape(shape: WorkplaneShape, options?: MeshOptions): MeshData;
function exactSolidForShape(cad: OcctKernel, shape: WorkplaneShape): ShapeHandle;

// --- operations, on an Engine bound to kernels + a store --------------------
type Engine = {
  cut(projectId: string, solidIds: string[], holeIds: string[]):
      Promise<OperationResult>;
  group(projectId: string, ids: string[]): Promise<OperationResult>;
  ungroup(projectId: string, id: string): Promise<OperationResult>;
  separate(projectId: string, id: string): Promise<OperationResult>;
  edges(projectId: string, id: string): Promise<ServerCadEdge[]>;
  treat(projectId: string, id: string, treatment: ServerCadTreatment):
      Promise<OperationResult>;
  revolve(projectId: string, request: RevolveRequest): Promise<OperationResult>;
  exportStep(projectId: string, ids?: string[]): Promise<string>;
};
```

**Against a macro.** `packages/sketchforge-client/examples/bolt-plate.macro.mjs`
calls `project.addMany([...])` with a box and a row of `kind: "thread"` shapes,
and `filleted-box.macro.mjs` additionally fillets. Both map directly:
`shapeFromRequest` for the box, `Engine.revolve` for the threads,
`Engine.treat` for the fillet, `ProjectStore.write` to persist. Note the existing
macro's own comment — "The API has no grouping endpoint yet, so the macro leaves
them as marked holes for the editor's boolean" — is already stale (`POST /groups`
exists), and with `Engine.cut` the macro could tap the plate itself.

**Against the route handlers.** They are already thin: `v1/booleans/route.ts` is
67 lines of which roughly 45 are validation and status-code selection, and the
geometry is one call to `buildGroupFromSelection` at `:55`. What is *not* thin,
and is duplicated across all seven handlers, is the orchestration — `withProjectLock`
→ `readProjectDocument` → resolve ids → mutate → `writeProjectDocument` → shape
summary. Compare `booleans/route.ts:35-65` with `groups/route.ts:30-52`: the same
eight steps twice. Folding that into `Engine` is what turns a handler into
genuine HTTP adaptation, and it is what gives a macro the same behaviour —
including the project lock, which a macro writing a directory **needs** and does
not currently have.

`apiShapeSummary` (`lib/apiShapes.ts:34`) stays in the app: it is the REST wire
shape, not engine vocabulary.

---

## 6. Staged PR sequence

Each stage is independently reviewable, leaves CI green, and is useful alone.
No stage is a flag day. Stages 1–4 add no package and change no user-visible
behaviour.

**#48 has already done the stage this originally numbered PR 5** — the editor's
booleans now run on the exact kernel, with the mesh path kept as a fallback and
the padding decision centralised. That was the riskiest stage and the only one a
user could notice, and it landed independently of this document, which is the
best available evidence that the sequence below is cut at the right joints. What
follows is the remaining work, renumbered, with the boolean stage recorded as
done rather than dropped.

CI to keep green at every stage: `ci.yml` runs `checks` (`npm run typecheck`,
`npm run typecheck:tests`, `npm test`) and `static-export` (`npm run export`) on
every push and pull request. `api-e2e` also runs but is explicitly not a gate
(`ci.yml:35-40`).

### 6.1 PR 1 — one set of primitive builders, and the first agreement test

**This is the first PR, and it is worth writing even if nothing after it ever happens.**

Add `apps/web/src/lib/geometry/primitiveGeometry.ts`. Move the eight builders
from `WorkplaneViewport.tsx:8431-8630` into it verbatim, plus `putGeometryOnBase`
(`:8431-8437`), parameterised by two options:

```ts
type PrimitiveGeometryOptions = {
  indexed?: boolean;              // editor copies keep the index buffer
  halfSphereNormals?: "analytic" | "computed";
};
```

`indexed` defaults to `false` so the viewport's `.toNonIndexed()` behaviour is
the default and its call sites do not change. `halfSphereNormals` exists only to
preserve the one real divergence found in §1.1 — viewport passes `"analytic"`,
the editor's boolean path passes `"computed"` — so this PR provably changes no
behaviour. A follow-up can decide which is correct; that is a different argument
and does not belong here.

Then:

- Delete `createBooleanRoofGeometry`, `createBooleanWedgeGeometry`,
  `createBooleanPyramidGeometry`, `createBooleanRoundRoofGeometry`,
  `createBooleanHalfSphereGeometry`, `createBooleanTorusGeometry`,
  `createBooleanHollowCylinderGeometry` from `SketchForgeEditor.tsx:1966-2144`
  and point `geometryMeshForShape` (`:2188`) at the new module.
- Delete the originals from `WorkplaneViewport.tsx` and point `createShapeObject`
  (`:7999`) at the new module.
- Leave `createBooleanTextGeometry` / `addTextShape` alone — they need a loaded
  font, which is a different problem.
- Move `clamp` (`WorkplaneViewport.tsx:547`) or inline it; it is three lines.

Add `tests/unit/primitiveGeometry.test.ts` — the first test in the repository
that can see a primitive builder at all. Two things to assert:

1. **Shape invariants per kind.** Base sits at `y = 0`; centred in X and Z;
   bounding box matches `width`/`depth`/`height`; triangle count stable; winding
   consistent.
2. **Agreement with the exact builder.** For each of the 14 kinds that both
   implementations handle (`EXACT_SOLID_KINDS`, `serverCadSolids.ts`), compare the mesh's
   volume and **centroid** against the OCCT solid from `exactSolidForShape`,
   within a tessellation tolerance. Centroid, not bounding box: commit `a966ba8`
   records that a bounding box cannot see a mirrored solid, "which is the same
   blind spot that hid the off-centre box".

The OCCT half needs the kernel, so it belongs in `tests/e2e/` next to
`stepRoundTrip.e2e.ts` (not a required check, but it is signal — `ci.yml:35-40`).
The invariant half is a pure unit test and runs in the gate.

Size: roughly +280 / −430 lines of source, plus tests. Touches two large `.tsx`
files, so it will want rebasing against whatever else is in flight there.

### 6.2 PR 2 — split the mixed modules

Split `loftGeometry.ts` (459) and `gearGeometry.ts` (240) into
`*Profile.ts` (pure normalizers and profile maths, no `three`) and
`*Mesh.ts` (the `THREE.BufferGeometry` builder). Re-point `serverCadSolids.ts:15-21`
at the profile half. Mechanical; drops `three` and the `@/i18n` type import out of
the server-side graph. Adds unit coverage for the normalizers, which are
currently only exercised incidentally.

### 6.3 PR 3 — one frame convention, and the first boolean test

The composition half of the rotation problem is already fixed as of `#45`
(§1.4). What remains is §1.5: `localSolidForShape` serves two callers that need
different frames, and the boolean caller rotates on top of a solid that is
already rotated.

Split the two intents explicitly rather than flagging between them:

- `localSolidForShape(cad, shape)` returns the solid in the shape's **own,
  unrotated** frame — matching its name and its existing docstring at
  `serverCadOperations.ts:140-146`.
- `orientedSolidForShape(cad, shape)` is that plus the shape's rotation, which
  is what the fillet path wants.
- `serverShapeBooleans.placedSolidForShape` (`:68-85`) calls the former, and
  `shapePlacementMatrix` keeps supplying the one and only rotation.
- `treatmentBakesRotation` (`serverCadOperations.ts:132-135`) can then say
  which *function was called* rather than inferring the frame from the shape's
  contents.

Then add the test that does not exist: the first direct test of
`buildGroupFromSelection`, with a rotated parametric operand, asserting the cut
lands where the editor's own placement matrix puts it. Centre of mass, not
bounding box, for the reason `#45`'s test gives.

Deliberately before the extraction, not after. Moving code with a known bug in
it makes the diff that fixes the bug unreviewable, and this bug is the headline
evidence for the whole exercise — fixing it is the cheapest demonstration that
the premise is sound. It is also the stage that most needs a reproduction first:
confirm the double rotation before changing anything (§8).

### 6.4 PR 4 — the engine boundary, in place

Create `apps/web/src/lib/engine/` with `index.ts` exporting the §5 surface, and
move the §2.1 modules under it. No package yet: this is a directory move plus an
`Engine` facade, so `@/` imports still work and the build is unchanged.

Rewrite the seven `v1` route handlers to call `Engine` instead of reassembling
the lock-read-mutate-write dance each time. `booleans/route.ts` and
`groups/route.ts` collapse hardest.

Add an `eslint` boundary rule, or a test in the shape of
`tests/unit/localizedImportErrors.test.ts`, asserting that nothing under
`lib/engine/` imports `@/i18n`, `@/components`, `react`, or `next`. That rule is
what keeps the boundary real after the reviewer has moved on.

### 6.5 PR 5 — one boolean engine — **done, in #48**

Kept in the list because the sequence's shape depends on it and because two
pieces of it are outstanding:

- **Done:** the editor's cut runs on OCCT in the CAD modifier worker, built from
  `exactSolidForShape`; the padding decision is centralised in
  `cutterShapeForBoolean`; a flush pocket lands at the depth asked for; the
  result keeps its B-rep for a later fillet or STEP export; #118 and #111 are
  fixed; `tests/unit/exactEditorBooleans.test.ts` measures it against closed-form
  volumes.
- **Outstanding (small, independent):** the cut *preview* still pads by
  `CUT_PREVIEW_PADDING = 0.01` and is still a mesh `HOLLOW_INTERSECTION`, so it
  now disagrees with the committed cut in both size and kind (§1.3). Worth a
  standalone PR; it needs nothing else here.
- **Outstanding (larger):** the worker's `exactCutFromParts` and the server's
  `buildGroupFromSelection` are now two orchestrations of the same exact cut.
  Converging them is PR 4's job, and §1.5 is a bug that lives in that gap.

### 6.6 Engine package — implemented

The engine modules now live in `packages/sketchforge-engine/src/` and build to
Node ESM with declarations. The web app's old module paths are compatibility
re-exports, so existing app call sites use the package implementation. The
package owns the shared shape types and its project store, and supplies distinct
runtime OCCT loading for Node and the browser. The release configuration stamps
the engine version alongside the app, client and Python manifests. The engine
package is not published; §8's licensing discussion still applies.

### 6.7 Local MCP mode — implemented

When `SKETCHFORGE_PROJECTS_DIR` is set, project MCP calls run directly through
the engine package and read/write the configured `.json` and `.skf` files. They
do not use the HTTP bridge, browser, or API token. The local mode supports
project reads and edits, shape creation/import, arranging, grouping, booleans,
edge and face operations, measurements, hollowing, and SKF/STEP export. Macro
execution, viewport tools, scene validation, and STL/OBJ/3MF/ZIP-kit export are
not part of this local mode yet. See the client README for setup and the exact
supported boundary.

### 6.8 PR 8 — publish (recommend: don't, yet)

A publish step in `release.yml` mirroring the `npm` job at `:177-207`. See §8 for
why I would stop at PR 7.

---

## 7. Constraints, verified

| Constraint | Verified where | Status |
|---|---|---|
| `output: export` is a required CI check | `ci.yml:61-82`, `release.yml:98-99`, `sanity-content-deploy.yml:38` | Holds. `npm run export` runs in three places. |
| Dynamic segments break the export | — | **No dynamic segments exist.** `find apps/web/src/app -type d -name "*[*"` is empty; all 14 routes are static paths. Nothing to preserve. |
| `dynamic = "force-dynamic"` breaks the export | `tests/unit/staticExportBuild.test.ts:24-35` | Holds, and is **already guarded by a test** that scans every `route.ts`. Zero current offenders. Historical failure at `docs/CHANGELOG.md:43`. |
| Browser cannot import Node-only code | `next.config.ts:31`, `serverCadKernel.ts:10` | Handled by §4 — the package contains no runtime kernel import at all. |
| `serverExternalPackages` must keep working | `next.config.ts:25-31` | Handled by §4. Optional peer deps, `import type` only. |
| Worker public-path gate | `scripts/verify-static-worker-assets.mjs:29-45` | **Watch this.** It fails if no chunk contains both `importScripts(` and `static/chunks/`. Moving a worker into a package could make webpack stop emitting that runtime chunk, failing `npm run export` on a build that otherwise succeeded. Mitigated by leaving both workers in the app (§2.2). |
| Electron desktop must work | `apps/desktop/main.cjs:67-90`, `electron-builder.yml:14-27` | **The sharpest packaging constraint.** Desktop runs a real Next **standalone** server (`build-web.mjs:29-33` sets `SKETCHFORGE_DOCKER_BUILD`), spawned as `ELECTRON_RUN_AS_NODE` with `NODE_PATH` pointing at `app.asar/node_modules` (`main.cjs:73,82`). That directory is populated from root `dependencies`. |
| …and there are no npm workspaces | root `package.json` has no `workspaces` key | A workspace-linked package would be **absent from `app.asar`** and the desktop app would fail at runtime, not at build time. See below. |
| Tests cannot import `.tsx` | §3 | Holds, four ways over. |
| Versioning via release-please | `release-please-config.json:8-19`, `.release-please-manifest.json` | One package (`"."`); clients are stamped to the root version via `extra-files`. A fourth needs an entry plus a fifth clause in `release.yml:101-126`. |
| `.skf` is the contract | `docs/SKF_PROJECT_FORMAT.md` | `skfProject.ts` moves unchanged. Round-tripping is covered by `tests/unit/skfProject.test.ts` and `skfNodeRoundTrip.test.ts`; both must stay green through every stage. |
| Licence | `LICENSE`, root `package.json:12` | AGPL-3.0-only. §8. |

**The desktop/workspaces problem is the one that needs a decision.** There are
three ways through it and I do not have a confident recommendation:

1. Add `workspaces` to the root `package.json` and `transpilePackages` to
   `next.config.ts` (absent today), then verify `electron-builder` follows the
   symlink into the asar. This is the clean answer and the one I would try
   first, but `electron-builder` + asar + workspace symlinks is a known-fiddly
   combination and I have not tested it here.
2. Let the engine be bundled into the Next server output. Safe *only* because
   §4 keeps all Emscripten glue out of the package — the `createRequire`
   failure cannot reach it. Probably the pragmatic answer.
3. Keep consuming it by relative path, as `packages/sketchforge-client` is
   consumed today (by path from `tests/`, never by package name). Lowest risk,
   but then it is not really a package.

Note also that `packages/sketchforge-client` has **no `dependencies` field at
all** and compiles against the root's hoisted `typescript`. An engine package
with real peer dependencies is the first package in this repository to have a
dependency graph of its own.

---

## 8. The honest cost

**What I am confident about.**

- PR 1 is small, safe, high-value and worth doing on its own merits. It is about
  280 lines added, 430 deleted, plus tests that cannot exist today.
- PRs 2–4 are mechanical. The risk is rebase pain against the large `.tsx`
  files, not correctness.
- PR 3 fixes a live bug and adds the first test of the server's boolean entry
  point. It has positive value even if the extraction is abandoned immediately
  afterwards.
- The §4 kernel-injection design removes the single constraint I would otherwise
  expect to sink this.

**What I am not confident about.**

- **Desktop packaging.** §7, option 1 vs 2. Untested. If it goes badly it is
  contained to PR 6, and PRs 1–4 still stand.
- **The §1.5 double rotation itself.** I read it; I did not run it. It needs the
  OCCT kernel and a project on disk. Reproduce it before PR 3 touches anything —
  if I have misread the call path, PR 3 shrinks to a naming and docstring
  cleanup and §1.5 should be struck from this document.
- **`svgImport.ts`** — 635 lines using `three` *and* manifold, imported by
  `skfProject.ts:9`. It has to come along because the format depends on it, and
  it is the module I understand least.
- **`cadBakeMetadata.ts`** — 282 `three`-heavy lines. I classified it "probably
  moves" on a skim, not a read.
- **Exact-cut latency in the editor.** I had this as the risk most likely to
  stop the boolean stage. #48 shipped it anyway and handled the question by
  construction rather than by measurement: a timeout falls back to the mesh cut.
  That is a sound answer, but it means the real latency profile is now a
  production question rather than a design one, and nobody has numbers. If exact
  cuts routinely time out, the fallback makes the feature quietly inert instead
  of visibly slow — which is harder to notice. Worth instrumenting.
- **Four boolean backends, not one.** The mesh paths did not go away and cannot:
  mirrored operands, imported meshes and the kinds outside `EXACT_SOLID_KINDS`
  all still take them (§1.2). Any later claim that the engine has "one boolean"
  will be wrong, and `importedBooleanMeshShape`'s attempt ladder is load-bearing
  for imported meshes specifically.

**What would make this not worth doing.**

- The boolean half of payoff 2 is already banked by #48, without a package and
  without this document. That is the single most useful datapoint about this
  proposal: the highest-value piece was reachable incrementally, in place. It
  raises a fair question about whether the remaining stages need a plan at all,
  or whether they are better done the same way — one targeted fix at a time, as
  someone notices. My answer is that §1.1 is the case that does *not* yield to
  that approach: a copied builder is invisible until the two copies disagree, and
  the only way to notice is a test that compares them, which is the thing that
  cannot be written while they live in `.tsx`. PR 1 exists to break that loop.
- If offline macros are not actually wanted, PRs 6–8 have no driver and the work
  should stop at PR 4 — a clean internal boundary with no packaging cost. **This
  is the most likely good outcome**, and the sequence is ordered so that
  stopping there is a success rather than an abandonment.
- **Licence.** AGPL-3.0-only is the right licence for an application and an
  awkward one for a library. A published `sketchforge-engine` can only be
  imported by AGPL-compatible software, and the network clause reaches anyone
  who runs it as a service. The two existing published packages are AGPL-3.0-only
  too (`packages/sketchforge-client/package.json:4`,
  `packages/sketchforge-py/pyproject.toml:10`), so there is precedent — but they
  are thin REST clients, where a reimplementation is an afternoon. A geometry
  engine is the valuable part of the product. "A standalone, publishable package
  that others would import" and AGPL-3.0-only are in tension, and resolving it
  is a licensing decision for the maintainers, not a technical one. **Hence PR 8
  is marked "recommend: don't".** Building the package (PR 6) and publishing it
  (PR 8) are separate decisions; everything the macro runner needs is satisfied
  by PR 6 and 7 with the package unpublished.
- If upstream mergeability matters more than it appears to, note that this moves
  ~10,300 lines across directory boundaries and would conflict with essentially
  any upstream change to `apps/web/src/lib`. `serverCadOperations.ts:11-15`
  already cites exactly this concern as the reason the worker's reconstruction
  was *not* shared. That reasoning applies to this proposal too, and it is the
  strongest argument against it that the codebase itself makes.

---

## 9. Remaining boundaries

The package extraction and local project MCP path are implemented. The MCP
still has two execution modes:

- **Local project mode:** set `SKETCHFORGE_PROJECTS_DIR`; project tools use the
  package directly, with no browser, server, or token. Scene reads allow
  `shapeIds`, `excludeShapeIds`, `includeRawShapes`, and `includeRawShapeIds`.
  SKF and STEP exports use the project name by default and can write to
  `outputPath`.
- **Editor mode:** without that variable, the existing HTTP bridge continues to
  target an open editor. Screenshot capture, selection, editor errors, and
  viewport scene validation remain tied to the editor.

Local mode currently has a narrower export surface than editor mode: it writes
SKF and STEP. STL, OBJ, 3MF and ZIP kits still use the editor adapter. Macro
execution also remains on the existing server path. The extracted package is
repository-local and unpublished; using local mode from a separately installed
client package requires a future engine distribution decision.

The package boundary removes the app dependency from the engine source. Some
support modules were copied into the package during extraction rather than
being independently published as shared packages, and the app's old paths are
compatibility shims. The original audit above remains useful for the geometry
and worker convergence work it identifies, but its pre-extraction module counts
and proposal language are historical.
