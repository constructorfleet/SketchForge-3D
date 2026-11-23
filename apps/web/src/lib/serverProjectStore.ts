/**
 * Server-side project storage (upstream issue #109).
 *
 * The dashboard normally keeps its project list in `localStorage` and each
 * project's packed `.skf` in IndexedDB, which is exactly the data a cleared
 * browser profile takes with it. When `SKETCHFORGE_PROJECTS_DIR` is set, the
 * server directory *replaces* both: the dashboard reads its list from the
 * server and autosaves there, and the browser stores hold nothing.
 *
 * This module is the seam. Everything here is either pure (so the route and
 * the dashboard agree on names, limits, and staleness) or a `fetch` against
 * `/api/projects`.
 */

// The route imports this module, so it must stay free of anything that pulls
// React in: "@/i18n/LocalizedError" only, never "@/i18n".
import { LocalizedError, errorFromResponse, type ErrorKey, type ErrorResponseFields } from "@/i18n/LocalizedError";
import { apiProjectId } from "@constructorfleet/sketchforge-engine/apiErrors";

export const SERVER_PROJECTS_ENV = "SKETCHFORGE_PROJECTS_DIR";
export const SERVER_PROJECTS_ENDPOINT = "/api/projects";

/** A project id as the server will spell it on disk, or null when it cannot be one. */
export function safeServerProjectId(projectId: string) {
  return apiProjectId(projectId) ?? null;
}

export function serverProjectMetadataFileName(projectId: string) {
  return `${projectId}.json`;
}

export function serverProjectPackageFileName(projectId: string) {
  return `${projectId}.skf`;
}

/** The dashboard's own revision counter, as stored in the metadata sidecar. */
export function serverProjectRevision(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return 0;
  const revision = (metadata as { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

/**
 * Whether a write should be refused as stale.
 *
 * Two tabs on the same project both autosave, and the one that was left open
 * longest would otherwise win by writing last. The dashboard's revision is
 * monotonic per edit, so an older revision means older state -- unless the
 * incoming write carries no revision at all, which is a first save.
 */
export function serverProjectWriteIsStale(storedMetadata: unknown, incomingMetadata: unknown) {
  const incoming = serverProjectRevision(incomingMetadata);
  if (incoming === 0) return false;
  return serverProjectRevision(storedMetadata) > incoming;
}

/** Carries the sidecar revision a package was served at. */
export const SERVER_PROJECT_REVISION_HEADER = "X-SketchForge-Revision";

/** Returns true when a package write's base revision is older than the stored one. */
export function serverPackageBaseIsStale(storedMetadata: unknown, baseRevision: number | undefined) {
  if (baseRevision === undefined || !Number.isFinite(baseRevision)) return false;
  return serverProjectRevision(storedMetadata) > baseRevision;
}

export type ServerProjectRecord = {
  projectId: string;
  updatedAt: number;
  packageBytes: number;
  metadata: Record<string, unknown>;
};

export type ServerProjectListing = {
  enabled: boolean;
  projects: ServerProjectRecord[];
};

export function sortedServerProjects(projects: ServerProjectRecord[]) {
  return [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function serverProjectError(response: Response, fallbackKey: ErrorKey) {
  const payload = await response.json().catch(() => ({})) as Partial<ErrorResponseFields>;
  return errorFromResponse(payload) ?? new LocalizedError(fallbackKey);
}

/**
 * How long the start-up probe waits for the server. The page holds back
 * files the desktop shell opened until the probe answers, so a server that
 * never answers must not hold them forever; a probe that gives up is treated
 * like an unreachable server, and the browser keeps the projects.
 */
export const SERVER_PROJECTS_PROBE_TIMEOUT_MS = 15_000;

/** Ask the server whether it is holding projects. A server that is not configured answers `enabled: false`. */
export async function probeServerProjects(
  { timeoutMs = SERVER_PROJECTS_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<ServerProjectListing & { error?: Record<string, unknown> }> {
  const response = await fetch(SERVER_PROJECTS_ENDPOINT, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => ({})) as Partial<ServerProjectListing> & Record<string, unknown>;
  const enabled = Boolean(payload.enabled);
  return {
    enabled,
    projects: Array.isArray(payload.projects) ? payload.projects : [],
    ...(response.ok ? {} : { error: payload }),
  };
}

/** Says why a project package request did not return a package. */
export class ServerPackageRequestError extends Error {
  readonly reason: "network" | "status" | "notPackage";
  readonly detail: string;

  constructor(reason: ServerPackageRequestError["reason"], detail: string) {
    super(`Project package request failed (${reason}: ${detail})`);
    this.name = "ServerPackageRequestError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Says another client saved a newer package than the one this write is based on. */
export class ServerProjectConflictError extends Error {
  readonly storedRevision: number;

  constructor(storedRevision: number) {
    super(`Project was changed elsewhere (stored revision ${storedRevision})`);
    this.name = "ServerProjectConflictError";
    this.storedRevision = storedRevision;
  }
}

export async function fetchServerProjectPackage(projectId: string): Promise<{ bytes: Uint8Array | null; revision: number | undefined }> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_PROJECTS_ENDPOINT}?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
  } catch (error) {
    throw new ServerPackageRequestError("network", error instanceof Error ? error.message : String(error));
  }
  const revision = servedRevision(response);
  // No bytes, but the sidecar may exist; its revision is the base for replacing the package.
  if (response.status === 404) return { bytes: null, revision };
  if (!response.ok) throw new ServerPackageRequestError("status", String(response.status));
  // A proxy or sign-in page can answer 200 with HTML; parsing that would call the project unreadable.
  const contentType = response.headers.get("content-type") ?? "";
  if (!PACKAGE_CONTENT_TYPE.test(contentType)) throw new ServerPackageRequestError("notPackage", contentType || "none");
  return { bytes: new Uint8Array(await response.arrayBuffer()), revision };
}

function servedRevision(response: Response) {
  const revision = Number(response.headers.get(SERVER_PROJECT_REVISION_HEADER) ?? Number.NaN);
  return Number.isFinite(revision) ? revision : undefined;
}

const PACKAGE_CONTENT_TYPE = /^application\/(?:zip|octet-stream|[\w.-]+\+zip)\s*(?:;|$)/i;

/** Write the project list's half of a project: its metadata sidecar, leaving the packed `.skf` alone. */
export async function saveServerProjectMetadata(projectId: string, metadata: unknown) {
  return postServerProject(projectId, (formData) => {
    formData.append("metadata", JSON.stringify(metadata));
  });
}

/** Write autosave's half of a project: the packed `.skf`, leaving the metadata sidecar alone. */
export async function saveServerProjectPackage(projectId: string, packageBytes: Uint8Array, revision: number, baseRevision?: number) {
  return postServerProject(projectId, (formData) => {
    formData.append("project", new Blob([new Uint8Array(packageBytes)], { type: "application/vnd.sketchforge.project+zip" }));
    formData.append("revision", String(revision));
    if (baseRevision !== undefined) formData.append("baseRevision", String(baseRevision));
  });
}

async function postServerProject(projectId: string, fill: (formData: FormData) => void) {
  const formData = new FormData();
  fill(formData);
  const response = await fetch(`${SERVER_PROJECTS_ENDPOINT}?projectId=${encodeURIComponent(projectId)}`, { method: "POST", body: formData });
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => ({})) as { conflict?: unknown; storedRevision?: unknown };
    if (response.status === 409 && payload.conflict === "newerRevision") {
      throw new ServerProjectConflictError(typeof payload.storedRevision === "number" ? payload.storedRevision : 0);
    }
    throw await serverProjectError(response, "errors.projects.saveFailed");
  }
  const payload = await response.json().catch(() => ({})) as { project?: ServerProjectRecord };
  return payload.project ?? null;
}

export async function deleteServerProject(projectId: string) {
  const response = await fetch(`${SERVER_PROJECTS_ENDPOINT}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw await serverProjectError(response, "errors.projects.deleteFailed");
}

/**
 * Which list is the authority on whether a project exists.
 *
 * The dashboard checks a project before opening it, to avoid opening one that
 * another tab deleted. In browser mode that check reads `localStorage`, which
 * is the store. In server mode `localStorage` is deliberately empty -- the
 * server holds the list -- so asking it says every project is gone, and the
 * check bounces the click back to a dashboard it has just emptied.
 */
export function openableProjectIds(
  mode: "browser" | "server",
  lists: { stored: ReadonlyArray<{ id: string }>; live: ReadonlyArray<{ id: string }> },
) {
  return new Set((mode === "server" ? lists.live : lists.stored).map((project) => project.id));
}
