---
slug: "/docs/guides/package-examples"
title: "Package examples"
audience: "Contributors"
owner: "Packages"
sources:
  - "packages/sketchforge-client/src/**"
  - "packages/sketchforge-client/examples/**"
  - "packages/sketchforge-py/src/**"
  - "packages/sketchforge-py/examples/**"
---

# Package examples

These examples are included from the package files that the integration suites execute. The TypeScript macros run through the published client macro runner; the Python examples run through `sketchforge3d`. Both suites create projects on a temporary local server and remove the projects after each run.

Use the [REST API guide](../REST_API.md) for server setup and endpoint semantics. For the full public client signatures, see the [TypeScript](../reference/typescript-client.md) and [Python](../reference/python-client.md) references.

## TypeScript: bolt plate

Source: `packages/sketchforge-client/examples/bolt-plate.macro.mjs`.

<!-- runnable-source: packages/sketchforge-client/examples/bolt-plate.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->
```js
!!!include(../../packages/sketchforge-client/examples/bolt-plate.macro.mjs)!!!
```

## TypeScript: bolt circle

Source: `packages/sketchforge-client/examples/bolt-circle.macro.mjs`.

<!-- runnable-source: packages/sketchforge-client/examples/bolt-circle.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->
```js
!!!include(../../packages/sketchforge-client/examples/bolt-circle.macro.mjs)!!!
```

## TypeScript: filleted box

Source: `packages/sketchforge-client/examples/filleted-box.macro.mjs`.

<!-- runnable-source: packages/sketchforge-client/examples/filleted-box.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->
```js
!!!include(../../packages/sketchforge-client/examples/filleted-box.macro.mjs)!!!
```

## TypeScript: tap-drill plate

Source: `packages/sketchforge-client/examples/tap-drill-plate.macro.mjs`. Cuts a tap-drill hole through a plate with `project.cut` and exports the part as STL with `project.export`, entirely through the API. The integration test checks the removed volume, the centre of mass, and that the written STL encloses the same solid.

<!-- runnable-source: packages/sketchforge-client/examples/tap-drill-plate.macro.mjs; tested-by: packages/sketchforge-client/tests/examples.integration.ts; ci: npm run test:integration -->
```js
!!!include(../../packages/sketchforge-client/examples/tap-drill-plate.macro.mjs)!!!
```

## Python: bolt plate

Source: `packages/sketchforge-py/examples/bolt_plate.py`.

<!-- runnable-source: packages/sketchforge-py/examples/bolt_plate.py; tested-by: packages/sketchforge-py/tests/integration/test_examples.py; ci: npm run client:test:py:integration -->
```python
!!!include(../../packages/sketchforge-py/examples/bolt_plate.py)!!!
```

## Python: bolt circle

Source: `packages/sketchforge-py/examples/bolt_circle.py`.

<!-- runnable-source: packages/sketchforge-py/examples/bolt_circle.py; tested-by: packages/sketchforge-py/tests/integration/test_examples.py; ci: npm run client:test:py:integration -->
```python
!!!include(../../packages/sketchforge-py/examples/bolt_circle.py)!!!
```

## Python: filleted box

Source: `packages/sketchforge-py/examples/filleted_box.py`.

<!-- runnable-source: packages/sketchforge-py/examples/filleted_box.py; tested-by: packages/sketchforge-py/tests/integration/test_examples.py; ci: npm run client:test:py:integration -->
```python
!!!include(../../packages/sketchforge-py/examples/filleted_box.py)!!!
```

## Run the examples

The repository CI runs these same example files against an isolated local server:

<!-- runnable-exempt: This command invokes the integration suite; the source examples and their tests are included above, not duplicated as shell code. -->
```sh
npm run test:integration
npm run client:test:py:integration
```

For local runs, start the web app with a temporary project directory and a test-only token, then set `SKETCHFORGE_URL`, `SKETCHFORGE_PROJECTS_DIR`, and `SKETCHFORGE_API_TOKEN` for both commands. Never point these examples at production: their project mode intentionally creates, replaces, and deletes test projects.

Package installation, macro parameters, and public API usage are documented in the [TypeScript package README](https://github.com/constructorfleet/SketchForge-3D/blob/main/packages/sketchforge-client/README.md) and [Python package README](https://github.com/constructorfleet/SketchForge-3D/blob/main/packages/sketchforge-py/README.md). Those package READMEs remain the registry-facing source for explanatory prose; the generated references here link back to them rather than copying their guides.
