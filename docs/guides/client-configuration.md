---
slug: "/docs/guides/client-configuration"
title: "Client configuration"
audience: "Contributors"
owner: "Packages"
sources:
  - "packages/sketchforge-client/src/**"
  - "packages/sketchforge-client/mcp/**"
  - "packages/sketchforge-py/src/**"
---

# Client configuration

This guide covers public runtime settings read by the TypeScript and Python macro clients and the `@constructorfleet/sketchforge3d` MCP bridge. For the complete inventory—including server and container settings, defaults, sensitivity, implementation readers, and documentation owners—see the [configuration reference](../OPERATOR_CONFIGURATION.md).

## TypeScript and Python API clients

Both published macro clients read `SKETCHFORGE_API_TOKEN`, `SKETCHFORGE_URL`, and `SKETCHFORGE_PROJECT_ID` from their process environment. `SKETCHFORGE_API_TOKEN` must match the server token and grants access to every project on that server, so store it as a secret and do not put it in macro source or command arguments. `SKETCHFORGE_URL` defaults to `http://127.0.0.1:3000`. `SKETCHFORGE_PROJECT_ID` supplies the project for a macro declared with `project: "target"`; an explicit project option takes precedence.

The same variables work with the JavaScript [`clientFromEnvironment`](../../packages/sketchforge-client/README.md#connecting) helper and Python [`client_from_environment`](../../packages/sketchforge-py/README.md#connecting). Their CLI behavior is described in the [CLI reference](../CLI_REFERENCE.md).

## Local MCP project storage

Set `SKETCHFORGE_PROJECTS_DIR` in the MCP process to use the local engine against project files on disk. The bridge creates this directory when needed and reads and writes the same `.json` metadata and `.skf` project files as the server. When set, local MCP tools operate directly on these files without an HTTP server or API token. For the server-backed web application and REST API, the same variable selects server-side project storage; see [server-backed projects](./deployment.md#server-backed-projects).

## MCP macro execution

Macro discovery and execution are disabled until `SKETCHFORGE_MACRO_DIR` points to a directory containing reviewed `.mjs`, `.js`, or `.py` files. MCP tools list files from that directory and accept a listed filename, not arbitrary code.

`SKETCHFORGE_MACRO_TIMEOUT_MS` sets the default process timeout in milliseconds (120000 by default). A tool call's `timeoutMs` can override it. `SKETCHFORGE_MACRO_PYTHON` selects the Python executable used to inspect and run Python macros; it defaults to `python3`. `SKETCHFORGE_MACRO_RUNNER_JS` optionally selects an installed JavaScript macro runner; when unset, the MCP package uses its bundled `sketchforge-macro` runner.

See the package's [MCP bridge guide](../../packages/sketchforge-client/README.md#the-mcp-bridge) for setup and examples.
