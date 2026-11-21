/**
 * The REST API's half of the engine boundary (upstream issue #55).
 *
 * `lib/engine` reports *what happened*; the engine's `apiErrors` decides what
 * that is worth in REST v1, so MCP local mode answers with the same codes. This
 * file only writes the result as an HTTP response.
 *
 * Request-size and operation-count caps use `413 limit_exceeded`; malformed
 * values stay `400`, while geometry refusals stay `422`.
 */

import { apiError, apiExpectedRevision } from "@/lib/apiV1";
// The two modules, not the `@/lib/engine` barrel. The barrel re-exports the STEP
// exporter, which reaches the browser's OCCT loader, and no route needs that in
// its module graph -- importing the barrel here would put it in all seven.
import { createEngine, type Engine, type EngineFailure } from "@/lib/engine/engine";
import { directoryProjectStore } from "@/lib/engine/projectStore";
import { engineFailureToApiError, type ApiFailureWording } from "@constructorfleet/sketchforge-engine/apiErrors";

export { wireExpressionError, type ApiFailureWording } from "@constructorfleet/sketchforge-engine/apiErrors";

/** The engine over a request's project directory. */
export function apiEngine(root: string, request?: Request): Engine {
  const expectedRevision = request ? apiExpectedRevision(request) : undefined;
  return createEngine(directoryProjectStore(root, expectedRevision));
}

/** `detail` adds fields to every refusal; a wrapped binding failure uses it to name the bound shape. */
export function apiEngineError(failure: EngineFailure, wording: ApiFailureWording = {}, detail: Record<string, unknown> = {}) {
  const { message, status, code, detail: fields } = engineFailureToApiError(failure, wording, detail);
  return apiError(message, status, code, fields);
}
