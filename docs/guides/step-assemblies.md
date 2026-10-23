---
slug: "/docs/guides/step-assemblies"
title: "Working with STEP assemblies"
audience: "Editor users"
owner: "Editor"
sources:
  - "packages/sketchforge-engine/src/**"
  - "packages/sketchforge-client/mcp/localEngine.mjs"
  - "packages/sketchforge-client/mcp/server.mjs"
  - "tests/fixtures/step/nested-assembly.step"
  - "tests/unit/localMcpEngine.test.ts"
---

# Working with STEP assemblies

A STEP assembly imported in the editor begins as one positioned mesh. The editor retains the source STEP file as a project asset, so it remains available when the project is saved or exported as `.skf`. When the source is within the bounded metadata extraction limits, the shape summary includes `stepAssembly`: a product tree with names, optional source occurrence IDs, and direct children. This tree describes the source assembly; it does not itself create selectable parts. See the [editor project export walkthrough](./editor-quickstart.md).

The REST `POST /api/v1/imports` endpoint accepts STL, OBJ, and SVG uploads; it does not accept STEP and there is no REST upload path for a STEP source asset. REST `POST /api/v1/explode?projectId=...&shapeId=...` only operates on a STEP-backed shape whose source asset is already present in the server-side project. The endpoint does not upload or import that asset. See the [REST API reference](/docs/REST_API.md) for the API's server-side project boundary.

For a supported editor-to-local workflow, import the STEP assembly in the editor, export the project as `.skf`, then use local MCP `sketchforge_import_project` to load that package and `sketchforge_explode_step_assembly` with the returned project ID and shape ID. Both tools run against local project files; see the [MCP tools reference](../mcp/TOOLS_REFERENCE.md#sketchforgeimportproject) and [MCP bridge setup](../../packages/sketchforge-client/README.md#the-mcp-bridge).

The `.skf` import and local MCP steps are exercised together by the [local MCP integration test](https://github.com/constructorfleet/SketchForge-3D/blob/main/tests/unit/localMcpEngine.test.ts), which builds a package from the checked-in [nested assembly STEP fixture](https://github.com/constructorfleet/SketchForge-3D/blob/main/tests/fixtures/step/nested-assembly.step), imports it, explodes it, and checks the nested groups and occurrence metadata. The local MCP tools are implemented in [`localEngine.mjs`](https://github.com/constructorfleet/SketchForge-3D/blob/main/packages/sketchforge-client/mcp/localEngine.mjs), and the server STEP explosion is handled by [`serverStepExplode.ts`](https://github.com/constructorfleet/SketchForge-3D/blob/main/packages/sketchforge-engine/src/serverStepExplode.ts). Run the test with `npm test -- tests/unit/localMcpEngine.test.ts -t 'STEP-backed SKF'`. This test covers the package and MCP steps; it does not automate importing the STEP file or exporting `.skf` through the editor UI.

When every exact solid can be associated with a unique product occurrence, explosion replaces the imported mesh with nested project groups matching the source product tree. Each leaf keeps its exact solid geometry, available component color, and `stepComponent` metadata:

```json
{
  "id": "step-occurrence:#42/solid-1",
  "occurrenceId": "step-occurrence:#42",
  "path": [
    { "id": "step-node:0", "name": "MainAssembly" },
    { "id": "step-occurrence:#19", "name": "Sensors" },
    { "id": "step-occurrence:#42", "name": "SensorLeft" }
  ]
}
```

`id` identifies a solid within its source occurrence, `occurrenceId` identifies the product occurrence, and `path` records the root-to-component ancestry. These are descriptive source identifiers: changing the STEP file or its product structure can change them. The nested groups and leaf metadata persist through normal project save and `.skf` round-trip. Select a group to move its complete subassembly; ungroup one level at a time to work with its children or individual solids.

Hierarchy-to-solid association is bounded and conservative. It compares world-space bounds from the XCAF GLB occurrence meshes with exact imported solid bounds, and uses a match only when both sides are unique. If any solid cannot be associated unambiguously, the operation falls back to the existing flat, top-level solids rather than creating a partial tree; those solids keep the name and color available from XCAF, and `stepComponent` may be absent. Nested groups retain the component positions in project space. They do not preserve the STEP file's original transform operations or guarantee hierarchy-preserving STEP export.

Extraction remains limited to STEP sources up to 8 MiB and 200 solids; hierarchy metadata has a 2,000-node and 32-level bound. REST request and response details are in the [generated operation references](/docs/rest-api/).
