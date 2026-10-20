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
import { ensureProjectsDirectory } from "@/lib/serverProjectFiles";
import { SERVER_PROJECTS_ENV, safeServerProjectId } from "@/lib/serverProjectStore";

export const API_V1_PREFIX = "/api/v1";

export function apiError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

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
    return { error: apiError(`The REST API is disabled. Set ${API_TOKEN_ENV} to enable it.`, 404) };
  }
  if (authorization === "unauthorized") {
    return {
      error: NextResponse.json(
        { error: "A valid bearer token is required." },
        { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": 'Bearer realm="SketchForge"' } },
      ),
    };
  }
  const root = await ensureProjectsDirectory();
  if (!root) {
    return { error: apiError(`The REST API needs server-side project storage. Set ${SERVER_PROJECTS_ENV}.`, 503) };
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
