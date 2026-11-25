# SketchForge

A local-first 3D design editor whose engine also serves a REST API and an MCP server.

## Language

**Delete record**:
The server's lasting note that a project was deleted, with the revisions it had then. While it exists, the dashboard cannot save the project again. The REST API does not read it.
_Avoid_: tombstone (in prose)

**Metadata revision**:
The count of writes to a project's listed details (name, thumbnail, settings), kept apart from the revision.
_Avoid_: metadata version

**Project write policy**:
The rules that decide whether a write to a server-stored project is refused, and which revisions it leaves behind. The dashboard and the REST API apply the same policy with different options, so they do not refuse the same writes.
_Avoid_: save rules, conflict check

**Request definition**:
The single statement of one request rule, such as a body schema, a query rule, a limit or the error code list, held in `packages/sketchforge-engine/src/apiRequestDefinitions.ts`. Engine checks, the REST operation contract and the MCP tool catalog all derive from it.
_Avoid_: request schema copy, contract rule

**Revision**:
The number that orders the stored versions of a project's package. A write based on an older revision is stale.
_Avoid_: version, timestamp
