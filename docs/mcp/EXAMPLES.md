---
slug: "/docs/mcp/EXAMPLES"
title: "MCP examples"
audience: "MCP users"
owner: "MCP"
sources:
  - "packages/sketchforge-client/mcp/**"
---

# MCP examples

## Build and export a local project

This executable workflow uses the local project store. It creates a temporary project, adds an 80 × 56 × 3 mm mounting plate, reads the resulting scene, exports an `.skf` file, and removes the temporary directory when it exits. It does not need a browser, running editor, or API token.

For the `.skf` file's archive layout, validation, and compatibility behavior, see the [project format guide](../SKF_PROJECT_FORMAT.md) and [generated format reference](../SKF_FORMAT_REFERENCE.md). REST-based automation is covered separately in the [REST API guide](../REST_API.md).

From the repository root, run the checked command below. It builds the engine and then runs the isolated workflow:

<!-- runnable-source: docs/mcp/examples/run-local-project.sh; tested-by: tests/docs/mcp-examples.test.mjs; ci: npm run docs:verify -->
```sh
!!!include(./examples/run-local-project.sh)!!!
```

The [example source](./examples/local-project.mjs) starts the repository MCP server, reads the current `tools/list` registry, validates each tool argument against its advertised input schema, and then invokes those tools over JSON-RPC. The [MCP tool reference](./TOOLS_REFERENCE.md) lists the complete current registry and schemas. The executable contract is checked by [`tests/docs/mcp-examples.test.mjs`](../../tests/docs/mcp-examples.test.mjs).

This example operates on a temporary local project directory and deletes it in a `finally` block. To target a live editor or a persistent local project, follow the setup and targeting guidance in the [SketchForge MCP skill](../skills/sketchforge-mcp-skill/SKILL.md).
