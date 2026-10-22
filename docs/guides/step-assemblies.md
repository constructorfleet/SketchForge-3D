---
slug: "/docs/guides/step-assemblies"
title: "Working with STEP assemblies"
audience: "Editor users"
owner: "Editor"
sources:
  - "packages/sketchforge-engine/src/**"
---

# Working with STEP assemblies

A STEP assembly import begins as one positioned mesh. When the source is within the bounded metadata extraction limits, the shape summary includes `stepAssembly`: a product tree with names, optional source occurrence IDs, and direct children. This tree describes the source assembly; it does not itself create selectable parts.

To turn an assembly into editable project components, call `POST /api/v1/explode?projectId=...&shapeId=...` on a retained STEP import. When every exact solid can be associated with a unique product occurrence, the operation replaces the imported mesh with nested project groups matching the source product tree. Each leaf keeps its exact solid geometry, available component color, and `stepComponent` metadata:

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

Extraction remains limited to STEP sources up to 8 MiB and 200 solids; hierarchy metadata has a 2,000-node and 32-level bound. See the [REST API reference](/docs/REST_API.md#describing-a-shape) for the response fields and endpoint details.
