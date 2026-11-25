/**
 * The server project write policy (#677).
 *
 * One module decides whether a write to a stored project is refused, and what
 * the metadata sidecar holds after it is accepted. Both server write paths
 * call it while they hold the project lock (`withProjectLock`):
 *
 * - the dashboard's `/api/projects` route, through `applyProjectWrite`;
 * - REST v1 and MCP, through `directoryProjectStore` (`projectWriteRefusal`
 *   when the lock is taken) and `writeProjectDocument` (`planProjectWrite`).
 *
 * The two paths keep different rules. Each difference is a request option:
 *
 * | Option             | Dashboard                         | REST v1 and MCP                  |
 * | ------------------ | --------------------------------- | -------------------------------- |
 * | `refuseDeleted`    | true: deletes win (#672)          | false: delete records not read   |
 * | `refuseOlderClock` | true: older tab loses             | false                            |
 * | base revisions     | `baseRevision`, `baseMetadataRevision` | none                        |
 * | `ifMatch`          | none                              | the `If-Match` header            |
 * | `revisionRule`     | `package`: revision is the package's | `advance`: past stored and clock |
 *
 * `planProjectWrite` is pure. `applyProjectWrite` is its adapter over a
 * project directory.
 */

import {
  projectPackagePath,
  readProjectMetadata,
  readProjectTombstone,
  regularFileStat,
  writeProjectMetadata,
  writeProjectPackage,
  type ProjectMetadata,
  type ProjectTombstone,
} from "./serverProjectFiles.js";
import {
  serverMetadataRevision,
  serverPackageBaseIsStale,
  serverProjectRevision,
  serverProjectWriteIsStale,
} from "./support/lib/serverProjectStore.js";

/** What the directory holds for a project when the write arrives. */
export type StoredProject = {
  metadata: ProjectMetadata | null;
  /** Consulted only when the request sets `refuseDeleted`. */
  tombstone?: ProjectTombstone | null;
  /** Consulted only when the request sets `refuseDeleted`. */
  packageExists?: boolean;
};

export type ProjectWriteRequest = {
  /** Sidecar fields the writer sends. Absent: the sidecar is left to the revision rule. */
  metadata?: ProjectMetadata | null;
  /** Present when the write replaces the package. `revision` is the one it was packed at. */
  package?: { revision?: number } | null;
  refuseDeleted?: boolean;
  /** Refuse a package or combined write whose claimed revision is older than the stored one. */
  refuseOlderClock?: boolean;
  /** The sidecar revision the writer's package was based on. */
  baseRevision?: number;
  /** The sidecar `metadataRevision` the writer's list read. */
  baseMetadataRevision?: number;
  /** An `If-Match` value: a revision, or `*`. */
  ifMatch?: string;
  /** Defaults to `package`. */
  revisionRule?: { kind: "package" } | { kind: "advance"; now: number };
};

export type ProjectWriteRefusal =
  | { reason: "deleted"; deletedRevision?: number }
  | { reason: "newerRevision"; storedRevision: number }
  | { reason: "staleRevision" }
  | { reason: "newerMetadata"; storedMetadataRevision: number }
  | { reason: "revisionMismatch"; currentRevision: number };

export type ProjectWriteNext = {
  writesPackage: boolean;
  /** The sidecar to write after the package, or null to leave it. */
  metadata: ProjectMetadata | null;
  /** The sidecar the dashboard reports. A package-only write reports the stored one, unraised. */
  reported: ProjectMetadata | null;
  /** The sidecar revision after the write. */
  revision: number;
  /** True when no sidecar was stored. */
  created: boolean;
};

export type ProjectWritePlan = { accepted: false; refusal: ProjectWriteRefusal } | { accepted: true; next: ProjectWriteNext };

/** Returns the first refusal that applies, or null. Refusal order is part of the contract. */
export function projectWriteRefusal(stored: StoredProject, request: ProjectWriteRequest): ProjectWriteRefusal | null {
  const { metadata, package: written } = request;
  if (request.refuseDeleted) {
    if (stored.tombstone) return { reason: "deleted", deletedRevision: stored.tombstone.revision };
    // Files removed without a delete record: a based metadata write must not bring back a list entry alone.
    const basedMetadataOnly = metadata && !written && Number.isFinite(request.baseMetadataRevision);
    if (basedMetadataOnly && !stored.metadata && !stored.packageExists) return { reason: "deleted" };
  }
  const storedRevision = serverProjectRevision(stored.metadata);
  if (request.ifMatch !== undefined && request.ifMatch !== "*" && stored.metadata && request.ifMatch !== String(storedRevision)) {
    return { reason: "revisionMismatch", currentRevision: storedRevision };
  }
  // A later clock is not a later copy: another client may have saved since this one loaded.
  if (written && serverPackageBaseIsStale(stored.metadata, request.baseRevision)) return { reason: "newerRevision", storedRevision };
  if (written && request.refuseOlderClock && serverProjectWriteIsStale(stored.metadata, claimedRevision(request))) return { reason: "staleRevision" };
  // A list read before another client's rename or settings change would revert it.
  const storedMetadataRevision = serverMetadataRevision(stored.metadata);
  if (metadata && Number.isFinite(request.baseMetadataRevision) && storedMetadataRevision > request.baseMetadataRevision!) {
    return { reason: "newerMetadata", storedMetadataRevision };
  }
  return null;
}

/** Refuses the write, or returns the state it leaves. */
export function planProjectWrite(stored: StoredProject, request: ProjectWriteRequest): ProjectWritePlan {
  const refusal = projectWriteRefusal(stored, request);
  if (refusal) return { accepted: false, refusal };
  const rule = request.revisionRule ?? { kind: "package" };
  const next = rule.kind === "advance" ? advancedWrite(stored, request, rule.now) : packageRevisionWrite(stored, request);
  return { accepted: true, next };
}

/** Reads the project, plans the write, and applies it. Call under the project lock. */
export async function applyProjectWrite(root: string, projectId: string, request: ProjectWriteRequest, packageBytes: Uint8Array | null) {
  const plan = planProjectWrite(await readStoredProject(root, projectId, request), request);
  if (plan.accepted) await commitProjectWrite(root, projectId, plan.next, packageBytes);
  return plan;
}

/** Writes the package before the sidecar, so a reader that labels bytes by the sidecar never overstates them. */
export async function commitProjectWrite(root: string, projectId: string, next: ProjectWriteNext, packageBytes: Uint8Array | null) {
  if (next.writesPackage && packageBytes) await writeProjectPackage(root, projectId, packageBytes);
  if (next.metadata) await writeProjectMetadata(root, projectId, next.metadata);
}

async function readStoredProject(root: string, projectId: string, request: ProjectWriteRequest): Promise<StoredProject> {
  if (!request.refuseDeleted) return { metadata: await readProjectMetadata(root, projectId) };
  const tombstone = await readProjectTombstone(root, projectId);
  if (tombstone) return { metadata: null, tombstone };
  const metadata = await readProjectMetadata(root, projectId);
  const packageExists = metadata ? true : Boolean(await regularFileStat(projectPackagePath(root, projectId)));
  return { metadata, tombstone: null, packageExists };
}

/** The revision a write claims: a combined write's metadata, else the package's own. */
function claimedRevision(request: ProjectWriteRequest) {
  if (request.metadata) return request.metadata;
  return request.package?.revision !== undefined ? { revision: request.package.revision } : null;
}

// The revision belongs to the package. A list write sent while a save was in flight
// carries an older one, and one sent before its save lands a newer one; neither may move it.
function packageRevisionWrite(stored: StoredProject, request: ProjectWriteRequest): ProjectWriteNext {
  const storedRevision = serverProjectRevision(stored.metadata);
  const writesPackage = Boolean(request.package);
  let metadata: ProjectMetadata | null = null;
  if (request.metadata) {
    metadata = {
      ...request.metadata,
      ...(!writesPackage && storedRevision > 0 ? { revision: storedRevision } : {}),
      metadataRevision: serverMetadataRevision(stored.metadata) + 1,
    };
  } else {
    // The sidecar revision is the package's, as REST v1 keeps it, so the next writer's base can be checked.
    const claimed = claimedRevision(request);
    if (writesPackage && stored.metadata && claimed && serverProjectRevision(claimed) > storedRevision) {
      metadata = { ...stored.metadata, revision: serverProjectRevision(claimed) };
    }
  }
  return {
    writesPackage,
    metadata,
    reported: request.metadata ? metadata : stored.metadata,
    revision: serverProjectRevision(metadata ?? stored.metadata),
    created: !stored.metadata,
  };
}

// Past both the stored revision and the clock, the way the editor advances it, so a
// dashboard holding this project reloads it rather than keeping a stale cache.
function advancedWrite(stored: StoredProject, request: ProjectWriteRequest, now: number): ProjectWriteNext {
  const revision = Math.max(now, serverProjectRevision(stored.metadata) + 1);
  const metadata: ProjectMetadata = {
    ...(request.metadata ?? stored.metadata ?? {}),
    revision,
    updatedAt: revision,
    // The shape count and time are list fields, so a dashboard list read before this is stale (#650).
    metadataRevision: serverMetadataRevision(stored.metadata) + 1,
  };
  return { writesPackage: Boolean(request.package), metadata, reported: metadata, revision, created: !stored.metadata };
}
