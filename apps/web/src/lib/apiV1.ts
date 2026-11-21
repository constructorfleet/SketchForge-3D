/**
 * Shared plumbing for the REST API (upstream issue #55).
 *
 * The API is a scripting surface: an LLM or a build script describes shapes as
 * data and the server writes them into a stored project, with no editor open.
 * It therefore answers in plain JSON with HTTP status codes rather than the
 * dashboard's localized error payloads -- a script reads `status`, not prose.
 */

import { NextResponse } from "next/server";
import { authorizeApiRequest, API_TOKEN_ENV } from "@/lib/apiTokens";
import { ensureProjectsDirectory } from "@/lib/engine/serverProjectFiles";
import { SERVER_PROJECTS_ENV, safeServerProjectId } from "@/lib/serverProjectStore";
import { API_ERROR_MESSAGES, type ApiErrorCode } from "@constructorfleet/sketchforge-engine/apiErrors";

export const API_V1_PREFIX = "/api/v1";

// Codes and sentences live in the engine so MCP local mode answers with the same ones.
export { API_ERROR_CODES, type ApiErrorCode } from "@constructorfleet/sketchforge-engine/apiErrors";

export function apiError(message: string, status: number, code: ApiErrorCode, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, code, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The refusals every route repeats.
 *
 * Named rather than written out at each of the forty-odd places they are
 * returned, so that a code and its sentence cannot drift apart between routes.
 */
export const apiErrors = {
  invalidProjectId: () => apiError(API_ERROR_MESSAGES.invalidProjectId, 400, "invalid_project_id"),
  shapeIdRequired: () => apiError(API_ERROR_MESSAGES.shapeIdRequired, 400, "invalid_shape_id"),
  jsonBodyRequired: () => apiError(API_ERROR_MESSAGES.jsonBodyRequired, 400, "invalid_body"),
  projectNotFound: (extra?: Record<string, unknown>) => apiError(API_ERROR_MESSAGES.projectNotFound, 404, "project_not_found", extra),
  projectBusy: (extra?: Record<string, unknown>) => apiError(API_ERROR_MESSAGES.projectBusy, 409, "project_busy", extra),
  revisionMismatch: (revision: number) => apiError(API_ERROR_MESSAGES.revisionMismatch, 409, "revision_mismatch", { revision }),
  shapeNotFound: (extra?: Record<string, unknown>) => apiError(API_ERROR_MESSAGES.shapeNotFound, 404, "shape_not_found", extra),
  shapesNotFound: (ids: readonly string[], extra?: Record<string, unknown>) => apiError(API_ERROR_MESSAGES.shapesNotFound(ids), 404, "shape_not_found", extra),
  shapeLocked: (message: string = API_ERROR_MESSAGES.shapeLocked, extra?: Record<string, unknown>) => apiError(message, 409, "shape_locked", extra),
  limitExceeded: (message: string, limit?: number, given?: number, extra?: Record<string, unknown>) => apiError(message, 413, "limit_exceeded", {
    ...extra,
    ...(limit === undefined ? {} : { limit }),
    ...(given === undefined ? {} : { given }),
  }),
};

export function apiJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The revision value inside the ETag produced by this API, when supplied. */
export function apiExpectedRevision(request: Request): string | undefined {
  const ifMatch = request.headers.get("if-match");
  if (ifMatch === null) return undefined;
  return ifMatch.trim() === "*" ? "*" : ifMatch.trim().replace(/^"|"$/g, "");
}

/**
 * The project directory for an authorized request, or the response to send instead.
 *
 * Both halves have to be configured: a token with no directory has nowhere to
 * put a project, and a directory with no token is the dashboard's own storage
 * and stays private to it.
 */
export async function apiContext(request: Request) {
  const authorization = authorizeApiRequest(request);
  if (authorization === "disabled") {
    return { error: apiError(`The REST API is disabled. Set ${API_TOKEN_ENV} to enable it.`, 404, "api_disabled") };
  }
  if (authorization === "unauthorized") {
    return {
      error: NextResponse.json(
        { error: "A valid bearer token is required.", code: "unauthorized" satisfies ApiErrorCode },
        { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": 'Bearer realm="SketchForge"' } },
      ),
    };
  }
  const root = await ensureProjectsDirectory();
  if (!root) {
    return { error: apiError(`The REST API needs server-side project storage. Set ${SERVER_PROJECTS_ENV}.`, 503, "storage_unconfigured") };
  }
  return { root };
}

/**
 * The project and shape a request names, from its query string.
 *
 * Query parameters rather than path segments: a dynamic route segment makes
 * the whole static-export build fail, because `output: export` has no server
 * to resolve one against. The dashboard's own routes are shaped this way for
 * the same reason.
 */
export function apiTarget(request: Request) {
  const params = new URL(request.url).searchParams;
  const requestedProject = params.get("projectId");
  const requestedShape = params.get("shapeId");
  return {
    projectId: requestedProject ? safeServerProjectId(requestedProject) : null,
    shapeId: requestedShape?.trim() || null,
  };
}

type ApiBodyLimit = { maxBytes: number };

export async function apiJsonBody(request: Request, options: ApiBodyLimit = { maxBytes: 16 * 1024 * 1024 }) {
  return apiJsonBodyWithLimit(request, options);
}

async function apiJsonBodyWithLimit(request: Request, { maxBytes }: ApiBodyLimit): Promise<Record<string, unknown> | null | Response> {
  const bytes = await apiRequestBodyBytes(request, { maxBytes });
  if (bytes instanceof Response) return bytes;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read a request body without allowing its stream to exceed the configured size. */
export async function apiRequestBodyBytes(request: Request, { maxBytes }: ApiBodyLimit): Promise<Uint8Array | Response> {
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    return apiErrors.limitExceeded(`The request body can be at most ${Math.floor(maxBytes / (1024 * 1024))}MB.`, maxBytes, declaredBytes);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return apiErrors.limitExceeded(`The request body can be at most ${Math.floor(maxBytes / (1024 * 1024))}MB.`, maxBytes, size);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A list of shape ids from a request body field, or null when it is malformed.
 *
 * One id on its own is a list of one: an operation over a set of shapes reads
 * better as `holeIds: "x"` when there is a single hole, and a script building
 * the list up has no reason to special-case its length.
 */
export function apiShapeIds(value: unknown): string[] | null {
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries)) return null;
  if (!entries.every((entry) => typeof entry === "string" && entry.trim())) return null;
  const ids = (entries as string[]).map((entry) => entry.trim());
  return new Set(ids).size === ids.length ? ids : null;
}
