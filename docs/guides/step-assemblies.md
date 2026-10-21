# Working with STEP assemblies

A STEP assembly import begins as one positioned mesh. When the source is within the bounded metadata extraction limits, the shape summary includes `stepAssembly`: a product tree with names, optional source occurrence IDs, and direct children. This tree describes the source assembly; it does not itself create selectable parts.

To turn an assembly into individual project components, call `POST /api/v1/explode?projectId=...&shapeId=...` on a retained STEP import. The operation replaces that imported shape with one project shape per exact solid. Each result is an independently selectable and movable shape, retains its source geometry and available component color, and includes `stepComponent` metadata:

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

`id` identifies a solid within its source occurrence, `occurrenceId` identifies the product occurrence, and `path` records the root-to-component ancestry. These are descriptive source identifiers: changing the STEP file or its product structure can change them. The exploded shapes and their metadata are persisted by normal project save and `.skf` round-trip.

Hierarchy-to-solid association is bounded and conservative. When extracted leaf occurrences correspond one-for-one with imported solids, the importer follows the XCAF solid traversal order. Otherwise, it only associates a component when its product name uniquely matches a hierarchy leaf. If the relationship is ambiguous or missing, the solid is still exploded and keeps the name/color available from XCAF, but `stepComponent` may be absent. This implementation does not reconstruct arbitrary assembly transforms as editable nested groups; each result is a top-level project shape placed in the source assembly's project-space position.

Extraction remains limited to STEP sources up to 8 MiB and 200 solids; hierarchy metadata has a 2,000-node and 32-level bound. See the [REST API reference](/docs/REST_API.md#describing-a-shape) for the response fields and endpoint details.
