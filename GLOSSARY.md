# SketchForge

A local-first 3D design editor whose engine also serves a REST API and an MCP server.

## Language

**Binding validation**:
The rules a new binding must pass before it is stored: the target's lock, where the binding may sit, the expression, and conflicts with bindings already in the tree. `validateBinding` in `packages/sketchforge-engine/src/bindingValidation.ts` holds them, and every bind path runs it. Stored bindings that break the same rules are reported as issues, not refused; they still load and recompute.
_Avoid_: bind predicate, binding conflict check

**Delete record**:
The server's lasting note that a project was deleted, with the revisions it had then. While it exists, the dashboard cannot save the project again. The REST API does not read it.
_Avoid_: tombstone (in prose)

**Editor publish module**:
The editor's single owner of how its project reaches the dashboard, in `apps/web/src/lib/editorPublish.ts`. It holds the publish that waits 120 ms after an edit. It decides whether the dashboard's props are the editor's own echo, unchanged, or a change that replaces the scene. It sends a waiting publish early when the editor switches project or unmounts, and drops it when the project closes. The editor component only forwards events to it.
_Avoid_: sync effect, publish timer

**Kept copy**:
The newest unsaved copy of a project whose save was refused because it was conflicted or deleted. The dashboard offers it as Download my copy or Save as a new project.
_Avoid_: conflicted copy, backup

**Metadata revision**:
The count of writes to a project's listed details (name, thumbnail, settings), kept apart from the revision.
_Avoid_: metadata version

**Project sync module**:
The dashboard's single owner of project storage and sync, in `apps/web/src/lib/projectSync/`. It decides where projects are stored, moves them to server storage, queues their saves, and tracks each project's sync status. IndexedDB, `localStorage` and the server are adapters behind it.
_Avoid_: storage layer, persistence helpers

**Project write policy**:
The rules that decide whether a write to a server-stored project is refused, and which revisions it leaves behind. The dashboard and the REST API apply the same policy with different options, so they do not refuse the same writes.
_Avoid_: save rules, conflict check

**Request definition**:
The single statement of one request rule, such as a body schema, a query rule, a limit or the error code list, held in `packages/sketchforge-engine/src/apiRequestDefinitions.ts`. Engine checks, the REST operation contract and the MCP tool catalog all derive from it.
_Avoid_: request schema copy, contract rule

**Revision**:
The number that orders the stored versions of a project's package. A write based on an older revision is stale.
_Avoid_: version, timestamp

**Sync status**:
One value per project saying whether this client may write it: synced, or held back as blocked, unreadable, unavailable, conflicted or deleted. Only a synced project is saved.
_Avoid_: write guard, blocked flag
