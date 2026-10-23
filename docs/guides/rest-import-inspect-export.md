---
slug: /docs/guides/rest-import-inspect-export
title: Import, inspect, and export a model through the REST API
audience: API users
owner: REST API
sources:
  - docs/examples/rest-import-inspect-export.mjs
  - packages/sketchforge-client/tests/rest-import-inspect-export.integration.ts
---

# Import, inspect, and export a model through the REST API

This workflow sends a small ASCII STL tetrahedron to a local SketchForge server, reads its exact mass properties, and exports the imported shape as STL. It creates a temporary project and deletes it when the workflow finishes.

The [import operation](/docs/rest-api/importGeometry) accepts STL, OBJ, and SVG files. STEP is not an import format for this endpoint. The workflow then uses the [properties operation](/docs/rest-api/getShapeProperties) and the [export operation](/docs/rest-api/exportProject), which supports additional formats.

## Run the example

Set `SKETCHFORGE_API_TOKEN` to the local server's test token. `SKETCHFORGE_URL` is optional and defaults to `http://127.0.0.1:3000`.

<!-- runnable-source: docs/examples/rest-import-inspect-export.mjs; tested-by: packages/sketchforge-client/tests/rest-import-inspect-export.integration.ts; ci: npm run test:integration -->
```js
!!!include(../examples/rest-import-inspect-export.mjs)!!!
```

The integration suite runs this same source against the local API and checks that import produced triangles, inspection returned positive volume, and the STL export contains a non-empty artifact.

<!-- runnable-exempt: This command executes the documented integration workflow; its source and assertions are included above. -->
```sh
npm run test:integration -- packages/sketchforge-client/tests/rest-import-inspect-export.integration.ts
```

Never run the example against production: it creates and deletes a project.
