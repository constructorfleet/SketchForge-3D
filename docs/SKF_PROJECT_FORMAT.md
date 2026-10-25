---
slug: "/docs/SKF_PROJECT_FORMAT"
title: "SketchForge project files (.skf)"
audience: "API users"
owner: "Project formats"
sources:
  - "packages/sketchforge-engine/src/**"
---

# SketchForge project files (`.skf`)

`.skf` is SketchForge's native, editable project format. It is an additional backup, transfer, and sharing mechanism; IndexedDB autosave remains the normal local persistence system, and STL, OBJ, STEP, and SVG remain geometry exports.

For exact serialized field types and reader limits, use the [generated `.skf` format reference](./SKF_FORMAT_REFERENCE.md). To create an `.skf` through server-side automation, see the [REST export endpoint](./REST_API.md#endpoints) and its `POST /exports` operation.

## Architecture decision

SketchForge uses a packaged container (format option B). A `.skf` file is a ZIP archive containing `project.json` and deduplicated files below `assets/`.

This was selected over pure JSON because imported STL/STEP data and exact B-Rep can be large, Base64 would add size and parsing overhead, and an archive lets SketchForge validate and hash each asset independently. The editable model is still JSON and can be inspected by opening `project.json` from the package.

## Version 2 layout

```text
project.skf
├── project.json
└── assets/
    ├── source/          Original imported STL, SVG, or STEP files
    ├── derived-mesh/    Exact caches for baked operations or legacy imports
    ├── brep/            Exact STEP/B-Rep payloads
    ├── image/           Deduplicated sketch/reference images
    └── display-edges/   Shared CAD display-edge arrays (JSON)
```

`project.json` contains these top-level sections:

- `schema`, `formatVersion`, `minimumReaderVersion`, and `createdWithVersion` (the SketchForge release that wrote the package, kept equal to the engine package version by release-please; readers record it for support and do not use it to decide compatibility)
- `metadata`: project name, source project ID, units, and timestamps
- `assets`: path, type, byte length, SHA-256, source format, and media type
- `states`: explicit root node IDs and editable object graphs for the active scene and undo/redo states
- `history`: ordered state references, selection per state, and current undo/redo index
- `sketches`: sketch/extrusion/revolve/sweep indexes
- `features`: supported group, subtraction, intersection, mirror, sketch-extrusion, sketch-revolve, sketch-sweep, fillet, and chamfer operations used by the active project
- `groups`: explicit parent/member references and operation type
- `workplanes`: base and selected offset workplanes
- `exactCad`: objects with exact B-Rep or imported STEP sources
- `editor`: workspace dimensions, units, snap grid, camera projection and saved camera view, and selected workplane elevation

Object nodes keep stable SketchForge object IDs. A sketch extrusion, revolve, or sweep has a separate, non-rendered source-sketch node and a stable `sketchSourceId`; its feature lists that sketch as an input. The sketch index links the source node to its output and records the profile, operation, and applicable operation settings used to rebuild it. The output node also retains the profile and settings so current editor and history restore paths can rebuild without an extra rendered object. A prism-drafted sketch extrusion also retains its draft angle and pre-draft height/frame for the engine's bounded source-ID recompute path; this does not create a separate draft node. Editing the profile keeps source and output identities while replacing the generated geometry. Older packages derive a source identity from the output object when saved again. Groups refer to child node IDs instead of array positions. Fillet/chamfer history refers to explicit “before” nodes. Feature dependencies are explicit and checked for cycles; general downstream dependency-ordered recomputation is not yet implemented.

Nodes reference display edges through `cadDisplayEdgesAssetId`; the edge version remains in the shape definition. Each distinct edge array is stored once, including references from groups and reversible edge-treatment history. Mesh coordinate arrays, B-Rep strings, and image data URLs are encoded and hashed once per immutable resource. Weak caches and a bounded text cache reuse this work on subsequent saves. Import restores shared mesh and edge objects across undo states. Long node traversals yield to the event loop between batches.

## What is preserved

- All current native shape kinds and their editable parameters
- Position, rotation, dimensions, mirrors, colour, solid/hole role, visibility, and lock state
- Nested groups, boolean operands, subtraction results, and intersection metadata
- Sketch points, lines, Bezier/smooth handles, disjoint profiles, reference images, extrusion depth, and revolve settings
- Imported STL, SVG, and STEP sources, stored once and reused by instances
- Stable application-owned CAD face IDs, face-color assignments keyed by ID, exact imported STEP data, compact STEP triangle ranges mapped to faces for viewport color preview, current exact CAD B-Rep, display edges, chamfer/fillet settings, and reversible edge-treatment history. A selected-edge fillet or chamfer on a straight single-region sketch extrusion, made through `POST /treatments` or in the editor, stores `edgeTreatments[].sourceEdges`, a list of `{ "segmentId", "cap" }` pairs (`cap` is `"top"` or `"bottom"`) that name each selected edge by the sketch segment and cap it was swept from, so a sketch edit can replay it. The same list appears on the matching history entry's feature. Transient edge indexes are never stored. A reader refuses a project whose `sourceEdges`, on a treatment or on its history entry, is empty, names an empty segment, uses any other cap, lists the same segment and cap twice, or carries extra fields; projects written before this field have none and read unchanged.
- Undo and redo states according to the export choice: Unlimited, 100, 50, or 30 recent actions. Unlimited means every state still retained by the editor, including available redo states.
- Workspace units, grid/snap settings, dimensions, active offset workplane, and camera projection
- The last settled camera position, target, and zoom. Older projects without a saved camera view open at the standard home view.

Native primitives are regenerated from definitions and do not receive mesh assets. Source-backed STL, SVG, and STEP objects are regenerated from their original asset. Derived mesh assets are written only when the current editor has genuinely baked geometry (for example a boolean or edge treatment), or when an older local project no longer has its original imported source.

## Opening safely

SketchForge inspects ZIP metadata before expansion and validates the entire project before changing local state. It rejects unsafe paths, encrypted or unsupported compression, excessive expansion, malformed shapes/sketches, duplicate IDs, missing assets, hash mismatches, invalid transforms, unknown shape or operation types, cyclic groups/features, and unsupported versions.

Opening a valid `.skf` creates a new local project. It does not overwrite the project that is currently open. The imported project is then saved through the existing dashboard, thumbnail, IndexedDB, history, and editor lifecycle.

Current safety limits are 512 MB compressed, 1 GB expanded, 256 MB per asset, 64 MB for `project.json`, 4,096 archive entries, 100,000 object nodes per state, and 5,001 distinct states. The live editor retains at most 5,000 history entries and 64 MB of serialized history, so Unlimited means all history currently available inside those safety limits.

## Compatibility and migrations

New saves use format version 2 and minimum reader version 2. Older applications reject these files rather than dropping shared display edges. The current reader accepts version 1 packages with inline display edges, interns those resources on import, and writes version 2 on the next save. The importer also contains an explicit migration for the documented version 0 pure-JSON prototype and preserves its object IDs and valid history.

Future schema changes should add a version-to-version migration, run validation after every migration, and never mutate the user's original file.

## Current limitations

- Projects created before source-asset tracking cannot recover the exact original STL/SVG file. Their existing normalized editable mesh is preserved as a deduplicated legacy cache and is identified by the absence of a source asset.
- SketchForge currently bakes the displayed result of booleans, face drafts, and edge treatments. `.skf` preserves the operands, group hierarchy, feature metadata, reversible history, exact B-Rep where available, and a derived-result cache. The retained prism-draft inputs support the engine's bounded source-ID edits, but there is no general parametric feature editor or feature graph.
- The current workplane system stores a base plane plus numeric offset. It does not expose persistent associative face-workplane references, so `.skf` cannot preserve an association that the editor itself does not model.
- `sketchProfile.constraints` is an optional list added without changing the package version. The editor supports coincident point pairs, horizontal or vertical segments, parallel or perpendicular pairs of segments, fixed point-to-point distances in millimeters, and fixed points. Constraint references use the profile's existing point and segment IDs, and old profiles with no constraints remain valid. A parallel relation constrains direction only; it does not constrain the distance between the segments.
- Sweep spine points and their `handleIn` / `handleOut` cubic controls may optionally include finite `sweepDepth` values in millimeters. Each value offsets that point or control along the section workplane's third axis; absent point values mean zero, and absent handle values inherit the endpoint depth. Handle depth is only valid on a point tagged `sweepRole: "spine"`; older profiles remain planar.
- During point movement, supported sketch constraints are solved together with a deterministic, bounded damped least-squares iteration; directly dragged points remain fixed, and the editor reports unsatisfied constraint IDs. The constraint inspector also shows an estimated local degree-of-freedom count from the constraint Jacobian rank. This count does not guarantee global solvability; degenerate zero-length distance geometry has no DOF report, and the supported relations leave global translation free. Sketch extrusion, revolve, and sweep rebuild from their editable source sketches, but remain individual baked output shapes rather than a general parametric feature tree. REST clients can replace a sweep's `sketchProfile` through `PATCH /shapes`, which rebuilds the solid while preserving its source and output identities.
- Camera position is intentionally omitted because the current project persistence system does not own it. It can be added as optional editor state in a compatible future version.
- OBJ source files can be imported and are retained as source assets in `.skf` projects. OBJ is also an export format.
