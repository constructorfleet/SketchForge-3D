/**
 * The REST API's half of the engine boundary (upstream issue #55).
 *
 * `lib/engine` reports *what happened*; this file decides what that is worth in
 * HTTP. It lives in the app rather than in the engine for the same reason
 * `apiShapeSummary` does: a status code and an English sentence are the wire
 * shape of this one transport, and the editor would want a translated
 * `LocalizedError` for the very same refusal.
 *
 * The wordings here are the ones the handlers used before they were thinned, so
 * a client matching on `code` -- or, against advice, on prose -- sees no change.
 */

import { apiError, apiErrors, type ApiErrorCode } from "@/lib/apiV1";
// The two modules, not the `@/lib/engine` barrel. The barrel re-exports the STEP
// exporter, which reaches the browser's OCCT loader, and no route needs that in
// its module graph -- importing the barrel here would put it in all seven.
import { createEngine, type Engine, type EngineFailure } from "@/lib/engine/engine";
import { directoryProjectStore } from "@/lib/engine/projectStore";

/** The engine over a request's project directory. */
export function apiEngine(root: string): Engine {
  return createEngine(directoryProjectStore(root));
}

/**
 * How a route words the refusals whose wording is its own.
 *
 * Three failures have no single right sentence, so each handler supplies its
 * own and the mapping below fills in the rest:
 *
 * - `locked` names which shapes have to be unlocked ("every operand", "every
 *   shape", "that group"), and the handlers differed on that before.
 * - `cadFailed` is the kernel failing with nothing to say: a read route says it
 *   "could not read that shape", a write route that it "could not complete that
 *   operation".
 * - `refusal` is a domain refusal a caller can act on -- not a group, a single
 *   body, a cut that removed nothing -- each of which is a 422 with its own
 *   sentence.
 */
export type ApiFailureWording = {
  /**
   * Set by a route that addresses a single shape through `?shapeId=`.
   *
   * Such a route answers a missing shape in the singular -- "That shape is not
   * in the project." -- where a route given a list of ids names the ones that
   * were not there. Both are `shape_not_found`.
   */
  oneShape?: boolean;
  locked?: (ids: string[]) => string;
  cadFailed?: string;
  refusal?: Partial<Record<"not_a_group" | "single_body" | "hole_has_no_parts" | "cut_removed_nothing", string>>;
};

const DEFAULT_REFUSALS: Required<NonNullable<ApiFailureWording["refusal"]>> = {
  not_a_group: "That shape is not a group.",
  single_body: "That shape is a single connected body.",
  hole_has_no_parts: "A hole has nothing to separate; it is a cutter, not a body.",
  // The editor treats the same case as a failed cut: a solid handed back
  // unchanged is the one reply a script cannot tell from success.
  cut_removed_nothing: "None of the holes meet the solid, so there is nothing to cut.",
};

/** `invalid_request` for the refusals that describe the request, `geometry_failed` for the ones that describe the geometry. */
const REFUSAL_CODES: Record<keyof typeof DEFAULT_REFUSALS, ApiErrorCode> = {
  not_a_group: "invalid_request",
  single_body: "invalid_request",
  hole_has_no_parts: "invalid_request",
  cut_removed_nothing: "geometry_failed",
};

export function apiEngineError(failure: EngineFailure, wording: ApiFailureWording = {}) {
  switch (failure.reason) {
    case "project_busy":
      return apiErrors.projectBusy();
    case "project_not_found":
      return apiErrors.projectNotFound();
    case "shapes_not_found":
      return wording.oneShape ? apiErrors.shapeNotFound() : apiErrors.shapesNotFound(failure.ids);
    case "shape_locked":
      return apiErrors.shapeLocked(wording.locked?.(failure.ids));
    case "geometry_failed":
      return apiError(failure.message, failure.status, "geometry_failed");
    case "cad_refused":
      return apiError(failure.message, failure.status, "cad_failed");
    case "cad_failed":
      return apiError(wording.cadFailed ?? "The CAD kernel could not complete that operation.", 500, "cad_failed");
    default:
      return apiError(
        wording.refusal?.[failure.reason] ?? DEFAULT_REFUSALS[failure.reason],
        422,
        REFUSAL_CODES[failure.reason],
      );
  }
}
