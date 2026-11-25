# SketchForge

A local-first 3D design editor whose engine also serves a REST API and an MCP server.

## Language

**Request definition**:
The single statement of one request rule, such as a body schema, a query rule, a limit or the error code list, held in `packages/sketchforge-engine/src/apiRequestDefinitions.ts`. Engine checks, the REST operation contract and the MCP tool catalog all derive from it.
_Avoid_: request schema copy, contract rule
