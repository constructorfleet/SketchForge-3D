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

export const API_V1_PREFIX = "/api/v1";

/**
 * The machine-readable half of an error, alongside the sentence.
 *
 * A status code is too coarse to act on here. `404` covers a missing project, a
 * missing shape and an API that is switched off entirely; `409` covers both "the
 * project is busy, retry" and "that shape is locked, do not retry". Without a
 * code a client has to match on the prose, which makes every wording change a
 * breaking one -- and both client libraries were doing exactly that.
 */
export const API_ERROR_CODES = [
  "api_disabled",
  "unauthorized",
  "storage_unconfigured",
  "invalid_project_id",
  "invalid_shape_id",
  "invalid_body",
  "invalid_request",
  "project_not_found",
  "project_exists",
  "project_busy",
  "shape_not_found",
  "shape_locked",
  "unsupported_kind",
  "unapplicable_fields",
  "too_many_shapes",
  "geometry_failed",
  "cad_failed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

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
  invalidProjectId: () => apiError("Invalid project id.", 400, "invalid_project_id"),
  shapeIdRequired: () => apiError("A shapeId is required.", 400, "invalid_shape_id"),
  jsonBodyRequired: () => apiError("Expected a JSON object body.", 400, "invalid_body"),
  projectNotFound: () => apiError("That project is not on the server.", 404, "project_not_found"),
  projectBusy: () => apiError("That project is being changed; try again.", 409, "project_busy"),
  shapeNotFound: () => apiError("That shape is not in the project.", 404, "shape_not_found"),
  shapesNotFound: (ids: readonly string[]) => apiError(`Not in the project: ${ids.join(", ")}.`, 404, "shape_not_found"),
  shapeLocked: (message = "That shape is locked.") => apiError(message, 409, "shape_locked"),
};

export function apiJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
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

export async function apiJsonBody(request: Request) {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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
