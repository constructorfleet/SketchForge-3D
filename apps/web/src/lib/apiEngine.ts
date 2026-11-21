/**
 * The REST API's half of the engine boundary (upstream issue #55).
 *
 * `lib/engine` reports *what happened*; this file decides what that is worth in
 * HTTP. It lives in the app rather than in the engine for the same reason
 * `apiShapeSummary` does: a status code and an English sentence are the wire
 * shape of this one transport, and the editor would want a translated
 * `LocalizedError` for the very same refusal.
 *
 * Route handlers share the same status and error-code rules here. In particular,
 * request-size and operation-count caps use `413 limit_exceeded`; malformed values
 * stay `400`, while geometry refusals stay `422`.
 */

import { apiError, apiErrors, apiExpectedRevision, type ApiErrorCode } from "@/lib/apiV1";
// The two modules, not the `@/lib/engine` barrel. The barrel re-exports the STEP
// exporter, which reaches the browser's OCCT loader, and no route needs that in
// its module graph -- importing the barrel here would put it in all seven.
import { createEngine, type Engine, type EngineFailure } from "@/lib/engine/engine";
import type { ShapeBindingError } from "@constructorfleet/sketchforge-engine/expressionBindings";
import type { ExpressionError } from "@constructorfleet/sketchforge-engine/parameterExpressions";
import type { ProjectParameterError } from "@constructorfleet/sketchforge-engine/projectParameters";
import { directoryProjectStore } from "@/lib/engine/projectStore";

/** The engine over a request's project directory. */
export function apiEngine(root: string, request?: Request): Engine {
  const expectedRevision = request ? apiExpectedRevision(request) : undefined;
  return createEngine(directoryProjectStore(root, expectedRevision));
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
  /**
   * How many shapes this operation needs, in its own words.
   *
   * The engine reports the count; the sentence is the route's, because "at
   * least two to align" and "at least three to distribute" say *why* in a way
   * a number on its own does not.
   */
  tooFewShapes?: (needed: number, given: number) => string;
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

/**
 * A message about one entry of a batch, named by its position.
 *
 * `POST /shapes` takes up to two hundred shapes in one request, so "that is not
 * a valid profile" is useless without saying which of them. An operation about
 * a single shape has no index and reads as a plain sentence.
 */
function atIndex(message: string, index: number | undefined) {
  return index === undefined ? message : `Shape ${index}: ${message}`;
}

/** The three readings of `unapplicable_fields`, each a 422 with `fields` attached. */
function unapplicableFields(failure: Extract<EngineFailure, { reason: "unapplicable_fields" }>, detail: Record<string, unknown>) {
  const message = failure.because === "no_sweep"
    ? `A shape of kind "${failure.kind}" has no sweep to change: ${failure.fields.join(", ")}.`
    : failure.because === "outline_not_described"
      ? "That revolve's outline was drawn rather than described, so the sweep cannot be rebuilt from it. Send a profile to replace it."
      : `A shape of kind "${failure.kind}" cannot take: ${failure.fields.join(", ")}.`;
  return apiError(message, 422, "unapplicable_fields", { fields: failure.fields, ...detail });
}

/** Serializes an evaluation error: code, message, span and, for a cycle, its path. */
export function wireExpressionError(error: ExpressionError) {
  return {
    code: error.code,
    message: error.message,
    span: { start: error.span.start, end: error.span.end },
    ...(error.cycle ? { cycle: [...error.cycle] } : {}),
  };
}

const PARAMETER_ERROR_STATUS: Record<ProjectParameterError["code"], readonly [number, ApiErrorCode]> = {
  invalidParameter: [400, "invalid_request"],
  invalidName: [400, "invalid_request"],
  invalidDimension: [400, "invalid_request"],
  duplicateName: [409, "parameter_exists"],
  unknownParameter: [404, "parameter_not_found"],
  parameterInUse: [409, "parameter_in_use"],
  invalidExpression: [422, "invalid_expression"],
  tooManyParameters: [413, "limit_exceeded"],
};

/** Maps a table refusal. `reason` carries the engine's finer code. */
function parameterError(error: ProjectParameterError) {
  const [status, code] = PARAMETER_ERROR_STATUS[error.code];
  return apiError(error.message, status, code, {
    parameter: error.parameter,
    reason: error.code,
    ...(error.expressionError ? { expressionError: wireExpressionError(error.expressionError) } : {}),
    ...(error.code === "parameterInUse" ? {
      dependents: [...(error.dependents ?? [])],
      shapeDependents: (error.shapeDependents ?? []).map(({ shapeId, fields }) => ({ shapeId, fields: [...fields] })),
    } : {}),
  });
}

/** Maps a binding refusal. An unbindable field reads as `unapplicable_fields`, as an unknown literal does. */
function bindingError(error: ShapeBindingError, index: number | undefined) {
  // A batch create names the shape by index; its id was never stored.
  const detail = {
    ...(index === undefined ? { shapeId: error.shapeId } : { index }),
    field: error.field,
    reason: error.code,
    ...(error.expressionError ? { expressionError: wireExpressionError(error.expressionError) } : {}),
    ...Object.fromEntries((["value", "min", "max", "stored"] as const)
      .filter((key) => typeof error[key] === "number")
      .map((key) => [key, error[key]])),
  };
  const message = atIndex(error.message, index);
  if (error.code === "shapeNotFound") return apiError(message, 404, "shape_not_found", detail);
  if (error.code === "fieldNotBindable") return apiError(message, 422, "unapplicable_fields", { ...detail, fields: [error.field] });
  return apiError(message, 422, "invalid_expression", detail);
}

/** `detail` adds fields to every refusal; a wrapped binding failure uses it to name the bound shape. */
export function apiEngineError(failure: EngineFailure, wording: ApiFailureWording = {}, detail: Record<string, unknown> = {}) {
  const fail = (message: string, status: number, code: ApiErrorCode, extra?: Record<string, unknown>) =>
    apiError(message, status, code, { ...extra, ...detail });
  switch (failure.reason) {
    case "project_busy":
      return apiErrors.projectBusy(detail);
    case "project_not_found":
      return apiErrors.projectNotFound(detail);
    case "shapes_not_found":
      return wording.oneShape ? apiErrors.shapeNotFound(detail) : apiErrors.shapesNotFound(failure.ids, detail);
    case "shape_locked":
      return apiErrors.shapeLocked(wording.locked?.(failure.ids), detail);
    case "geometry_failed":
      return fail(failure.message, failure.status === 500 ? 422 : failure.status, "geometry_failed");
    case "cad_refused":
      return fail(failure.message, failure.status, "cad_failed");
    case "cad_failed":
      return fail(wording.cadFailed ?? "The CAD kernel could not complete that operation.", 500, "cad_failed");
    case "interference_refused": {
      const refusal = failure.refusal;
      if (refusal.reason === "invalid_clearance") return fail("clearance must be a finite, non-negative number of millimetres.", 400, "invalid_request");
      if (refusal.reason === "too_many_shapes") return apiErrors.limitExceeded(`Interference check refused: ${refusal.given} shapes exceed the limit of ${refusal.limit}. Narrow the ids list.`, refusal.limit, refusal.given, detail);
      return apiErrors.limitExceeded(`Interference check refused: more than ${refusal.limit} candidate pairs; narrow the ids list or reduce clearance.`, refusal.limit, refusal.given, detail);
    }
    case "unsupported_kind":
      return fail(
        `Shape ${failure.index} has an unsupported kind. The API can build: ${failure.kinds.join(", ")}.`,
        422,
        "unsupported_kind",
      );
    case "invalid_shape_request":
      return fail(atIndex(failure.message, failure.index), 400, "invalid_request", {
        ...(failure.index === undefined ? {} : { index: failure.index }),
        ...(failure.shapeId === undefined ? {} : { shapeId: failure.shapeId }),
        ...(failure.field === undefined ? {} : { field: failure.field }),
      });
    case "sweep_failed":
      return fail(atIndex(`${failure.message}.`, failure.index), 422, "geometry_failed");
    case "unapplicable_fields":
      return unapplicableFields(failure, detail);
    case "selection_too_small":
      return fail(
        wording.tooFewShapes?.(failure.needed, failure.given)
          ?? `This needs at least ${failure.needed} shapes; ${failure.given} were given.`,
        422,
        "invalid_request",
      );
    case "no_distribute_axis":
      return fail(
        "Every shape sits at the same place along both axes, so there is nothing to spread. Move them apart, or send axis as x or z.",
        422,
        "invalid_request",
      );
    case "pattern_has_no_step":
      return fail(
        failure.kind === "linear"
          ? "A row needs a stepX or a stepZ, or every copy lands on top of the original."
          : "A ring needs a sweepAngle other than zero, or every copy lands on top of the original.",
        400,
        "invalid_request",
      );
    case "import_unsupported":
      return fail(
        `Nothing here can read "${failure.fileName}". The readable formats are: ${failure.formats.join(", ")}.`,
        415,
        "unsupported_format",
      );
    case "import_failed":
      return fail(`${failure.fileName}: ${failure.message}`, 422, "geometry_failed");
    case "parameter_invalid":
      return parameterError(failure.error);
    case "binding_invalid":
      return bindingError(failure.error, failure.index);
    case "binding_failed":
      return apiEngineError(failure.failure, wording, {
        ...detail,
        ...(failure.index === undefined ? { shapeId: failure.shapeId } : { index: failure.index }),
        fields: [...failure.fields],
      });
    default:
      return fail(
        wording.refusal?.[failure.reason] ?? DEFAULT_REFUSALS[failure.reason],
        422,
        REFUSAL_CODES[failure.reason],
      );
  }
}
