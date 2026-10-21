# SketchForge engine

`@constructorfleet/sketchforge-engine` is the TypeScript package for SketchForge's project model and geometry operations. It is intended for Node.js applications that need to read or change SketchForge projects, construct parameterized shapes, or import and export geometry without running the web editor.

## Installation

```sh
npm install @constructorfleet/sketchforge-engine
```

The package is ECMAScript modules (ESM) and requires Node.js 20 or newer. TypeScript declarations ship with the package; no separate `@types` package is needed.

## Quick start

Build a shape from parameters without starting the editor or opening a project:

```js
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine";

const shape = shapeFromRequest({ kind: "box", width: 20, depth: 10, height: 5 });
if (!shape) throw new Error("The requested shape could not be built");
console.log(shape.kind, shape.width, shape.depth, shape.height);
```

The shape request is plain data and can be stored or passed to `createEngine`. `shapeFromRequest` returns `null` for kinds that cannot be created from parameters alone (for example, a mesh with no geometry).

To run project operations, bind an engine to the directory store used by SketchForge:

```js
import { createEngine, directoryProjectStore } from "@constructorfleet/sketchforge-engine";

const projectsDirectory = process.env.SKETCHFORGE_PROJECTS_DIR;
if (!projectsDirectory) throw new Error("Set SKETCHFORGE_PROJECTS_DIR to the project directory");
const engine = createEngine(directoryProjectStore(projectsDirectory));
const result = await engine.project("project-id");
if (!result.ok) throw new Error(`Could not read project: ${result.failure.reason}`);
console.log(`Revision ${result.value.revision}; ${result.value.shapes.length} shapes`);
```

Set `SKETCHFORGE_PROJECTS_DIR` to the directory already used by SketchForge, and replace `project-id` with an existing project ID. The directory must contain projects in the supported on-disk format. Keep access to that directory restricted to trusted local code: this package is a geometry/project library, not an HTTP service or an access-control boundary.

## Public API

The main entry point exports these API areas:

- **Projects and operations:** `directoryProjectStore`, `createEngine`, `Engine`, `EngineResult`, `EngineFailure`, project and operation request/result types. The engine supports project reads, adding/changing/removing shapes, align/distribute/pattern, mesh import, groups and cuts, exact CAD operations, measurements, properties, and interference checks.
- **Shape requests:** `shapeFromRequest`, `shapeWithRequestedChanges`, `REQUESTABLE_SHAPE_KINDS`, plus types describing parameterized shapes.
- **Project files and exchange:** `.skf` import/export and inspection; mesh import; STEP and scene export; SVG/DXF section output; STEP assembly explosion.
- **Geometry and CAD:** primitive builders, exact solids, sectioning, topology analysis, shape bounds, CAD measurements, shelling, edge treatments, wall thickness, and projection layouts.
- **Placement and repetition:** align/distribute helpers, pattern placement helpers, shape bounds, mirror, canonicalization, and workplane hole-mode helpers.

See the [generated TypeScript API reference](https://constructorfleet.github.io/SketchForge-3D/docs/reference/typescript-engine) for every symbol and declaration. The reference links back to this usage guide. Related documentation: [REST API](https://constructorfleet.github.io/SketchForge-3D/docs/REST_API), [project format](https://constructorfleet.github.io/SketchForge-3D/docs/SKF_PROJECT_FORMAT), and [TypeScript client](https://constructorfleet.github.io/SketchForge-3D/docs/packages/typescript-client).

## Editing a sketch-backed feature

Sketch extrusions, revolves, and sweeps expose a stable `sketchSourceId` on the generated shape. Pass that ID to `engine.changeShape(projectId, sketchSourceId, { sketchProfile })` to rebuild the feature. When the output is nested inside a baked boolean group, the engine updates the sketch output and recomputes its boolean ancestors from their retained operands before writing the project. The edit is atomic: invalid profiles or a failed dependent rebuild leave the stored project unchanged.

This recomputation currently covers a sketch-backed sweep nested under boolean groups. Drafts and other downstream operations remain baked, and a general-purpose feature graph is not yet available. `.skf` export preserves the updated sketch profile and recomputed boolean result.

## Limitations

- The package does not provide the SketchForge web UI, HTTP routes, authentication, or a remote project client. Use the [TypeScript client](https://www.npmjs.com/package/@constructorfleet/sketchforge-client) for the REST API.
- There is no package-level `meshForShape` dispatcher yet; use the primitive builders or exact-solid helpers for the specific shape kinds they support.
- The engine reads and writes SketchForge projects through a `ProjectStore`; `directoryProjectStore` is a local filesystem implementation. It expects valid project files and a directory managed with SketchForge's project conventions.
- Parameter-only shape creation does not create drawn sketches or arbitrary mesh geometry. Import mesh data through `engine.importMesh` or use the editor for drawing workflows.
- CAD, STEP, and exact-solid operations rely on native/WASM geometry dependencies and can be more resource-intensive than pure parameter and placement helpers. Kernel-specific modules are loaded when those operations run.
- Use the package root as the supported public API. The export map also permits subpath imports for compiled modules, but undocumented internal modules are not a compatibility promise.

## License

This package is licensed under [AGPL-3.0-only](https://github.com/constructorfleet/SketchForge-3D/blob/main/LICENSE).
