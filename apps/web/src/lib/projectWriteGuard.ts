/**
 * Holds back writes to projects whose stored copy could not be loaded (#622).
 * A stand-in copy would otherwise autosave over the bytes a repair needs.
 */
export type ProjectWriteGuard = {
  block(projectId: string): void;
  /** Allows writes again, after a good read or a confirmed replacement. */
  release(projectId: string): void;
  canWrite(projectId: string): boolean;
};

export function createProjectWriteGuard(): ProjectWriteGuard {
  const blocked = new Set<string>();
  return {
    block: (projectId) => {
      blocked.add(projectId);
    },
    release: (projectId) => {
      blocked.delete(projectId);
    },
    canWrite: (projectId) => !blocked.has(projectId),
  };
}

/** Marks a write the guard refused, which the banner that blocked the project already reports. */
export class ProjectWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectWriteRefusedError";
  }
}

/** Wraps a project write so it is refused, before any packing, while the project is blocked. */
export function guardProjectWrites<A extends unknown[], R>(
  guard: ProjectWriteGuard,
  write: (projectId: string, ...args: A) => Promise<R>,
  refusal: () => Error,
): (projectId: string, ...args: A) => Promise<R> {
  return async (projectId, ...args) => {
    if (!guard.canWrite(projectId)) throw refusal();
    return write(projectId, ...args);
  };
}

/** Returns the cache with an editor snapshot applied, unless the project is blocked or holds a newer entry. */
export function cacheWithEditorChange<T extends { revision: number }>(
  current: Record<string, T>,
  projectId: string,
  entry: T,
  guard: ProjectWriteGuard,
): Record<string, T> {
  if (!guard.canWrite(projectId)) return current;
  const existing = current[projectId];
  if (existing && existing.revision > entry.revision) return current;
  return { ...current, [projectId]: entry };
}

/** `storageNewer`: a newer release upgraded the browser database, so this build can neither read nor replace it. */
export type ProjectLoadFailureKind = "unreadable" | "unavailable" | "storageNewer" | "missing" | "conflict";

/** Marks a load error raised by the stored copy's contents, not by reaching storage. */
export class StoredProjectUnreadableError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "StoredProjectUnreadableError";
    this.reason = reason;
  }
}

export function projectLoadFailureKind(error: unknown): ProjectLoadFailureKind {
  if (error instanceof StoredProjectMissingError) return "missing";
  if (!(error instanceof StoredProjectUnreadableError)) return "unavailable";
  const { reason } = error;
  return reason && typeof reason === "object" && (reason as { name?: unknown }).name === "VersionError" ? "storageNewer" : "unreadable";
}

/** Returns the error to show: the parse error inside an unreadable-copy marker. */
export function projectLoadFailureCause(error: unknown): unknown {
  return error instanceof StoredProjectUnreadableError ? error.reason : error;
}

/** Tells an IndexedDB read error that a retry cannot fix from a passing one. */
export function indexedDbReadIsPermanent(error: unknown): boolean {
  // DOMException is not an Error subclass in every runtime, so match by shape.
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (typeof name !== "string") return false;
  if (PERMANENT_INDEXEDDB_ERRORS.has(name)) return true;
  // Chromium reports a large value whose blob file is gone as a generic UnknownError.
  return name === "UnknownError" && typeof message === "string" && /failed to read large indexeddb value/i.test(message);
}

// A newer schema, or a value that cannot be decoded, reads the same way every time.
const PERMANENT_INDEXEDDB_ERRORS = new Set(["VersionError", "DataError", "NotReadableError", "DataCloneError"]);

/** Marks a server project whose metadata exists but whose package file does not. */
export class StoredProjectMissingError extends Error {
  constructor() {
    super("The stored project package is missing");
    this.name = "StoredProjectMissingError";
  }
}

/** Merges a server listing into the local list, taking only projects that are newer or new. */
export function mergeNewerServerProjects<T extends { id: string; revision?: number }>(
  local: T[],
  server: T[],
  isNewer: (mine: T, theirs: T) => boolean = () => false,
): { projects: T[]; changedIds: string[] } {
  const byId = new Map(local.map((project, index) => [project.id, index]));
  const projects = [...local];
  const changedIds: string[] = [];
  for (const candidate of server) {
    const index = byId.get(candidate.id);
    if (index === undefined) {
      projects.push(candidate);
      changedIds.push(candidate.id);
    } else if ((candidate.revision ?? 0) > (local[index].revision ?? 0) || isNewer(local[index], candidate)) {
      projects[index] = candidate;
      changedIds.push(candidate.id);
    }
  }
  return { projects: changedIds.length ? projects : local, changedIds };
}
