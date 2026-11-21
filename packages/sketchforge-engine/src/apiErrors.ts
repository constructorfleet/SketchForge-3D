/**
 * Maps engine failures to REST v1 errors: status, code, sentence and detail fields.
 *
 * REST and MCP local mode both answer from here, so a refusal reads the same
 * whichever transport carried it. Transports only wrap the result.
 */

import type { EngineFailure } from "./engine.js";
import type { ShapeBindingError } from "./expressionBindings.js";
import type { ExpressionError } from "./parameterExpressions.js";
import type { ProjectParameterError } from "./projectParameters.js";
import type { SketchConstraintBindingError } from "./sketchConstraintBindings.js";

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
  "revision_mismatch",
  "shape_not_found",
  "shape_locked",
  "parameter_not_found",
  "parameter_exists",
  "parameter_in_use",
  "invalid_expression",
  "unsupported_kind",
  "unsupported_format",
  "unapplicable_fields",
  "too_many_shapes",
  "limit_exceeded",
  "geometry_failed",
  "cad_failed",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** One refusal, before a transport writes it. `detail` never holds `error` or `code`. */
export type ApiErrorReply = {
  message: string;
  status: number;
  code: ApiErrorCode;
  detail: Record<string, unknown>;
};

/** Sentences shared by every route, so a code and its sentence cannot drift apart. */
export const API_ERROR_MESSAGES = {
  invalidProjectId: "Invalid project id.",
  shapeIdRequired: "A shapeId is required.",
  jsonBodyRequired: "Expected a JSON object body.",
  projectNotFound: "That project is not on the server.",
  projectBusy: "That project is being changed; try again.",
  revisionMismatch: "The project changed since the supplied revision.",
  shapeNotFound: "That shape is not in the project.",
  shapesNotFound: (ids: readonly string[]) => `Not in the project: ${ids.join(", ")}.`,
  shapeLocked: "That shape is locked.",
} as const;

/** Same rule as the store: the id becomes a file name in the project directory. */
export const API_PROJECT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$";
export const API_PROJECT_ID_MAX_LENGTH = 120;

/** Returns the trimmed project id, or undefined when a query could not carry it. */
export function apiProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length <= API_PROJECT_ID_MAX_LENGTH && new RegExp(API_PROJECT_ID_PATTERN).test(trimmed) ? trimmed : undefined;
}

/**
 * How a route words the refusals whose wording is its own.
 *
 * - `oneShape`: a route addressing one shape through `?shapeId=` says "That
 *   shape is not in the project." instead of naming the missing ids.
 * - `locked` names which shapes have to be unlocked.
 * - `cadFailed` is the kernel failing with nothing to say.
 * - `tooFewShapes` words the count an operation needs.
 * - `refusal` words a domain refusal a caller can act on.
 */
export type ApiFailureWording = {
  oneShape?: boolean;
  locked?: (ids: string[]) => string;
  cadFailed?: string;
  tooFewShapes?: (needed: number, given: number) => string;
  refusal?: Partial<Record<"not_a_group" | "single_body" | "hole_has_no_parts" | "cut_removed_nothing", string>>;
};

/** `PATCH /shapes` wording; MCP's set_shape_expression takes the same path. */
export const SHAPE_CHANGE_WORDING: ApiFailureWording = {
  oneShape: true,
  locked: () => "That shape is locked. Send locked: false to change it.",
};

const DEFAULT_REFUSALS: Required<NonNullable<ApiFailureWording["refusal"]>> = {
  not_a_group: "That shape is not a group.",
  single_body: "That shape is a single connected body.",
  hole_has_no_parts: "A hole has nothing to separate; it is a cutter, not a body.",
  // The editor treats the same case as a failed cut: a solid handed back
  // unchanged is the one reply a script cannot tell from success.
  cut_removed_nothing: "None of the holes meet the solid, so there is nothing to cut.",
};

/** `invalid_request` for refusals about the request, `geometry_failed` for ones about the geometry. */
const REFUSAL_CODES: Record<keyof typeof DEFAULT_REFUSALS, ApiErrorCode> = {
  not_a_group: "invalid_request",
  single_body: "invalid_request",
  hole_has_no_parts: "invalid_request",
  cut_removed_nothing: "geometry_failed",
};

function reply(message: string, status: number, code: ApiErrorCode, detail: Record<string, unknown> = {}): ApiErrorReply {
  return { message, status, code, detail };
}

/** Names a batch entry by position; `POST /shapes` takes up to two hundred. */
function atIndex(message: string, index: number | undefined) {
  return index === undefined ? message : `Shape ${index}: ${message}`;
}

function limitExceeded(message: string, limit: number, given: number, detail: Record<string, unknown>) {
  return reply(message, 413, "limit_exceeded", { ...detail, limit, given });
}

/** The three readings of `unapplicable_fields`, each a 422 with `fields` attached. */
function unapplicableFields(failure: Extract<EngineFailure, { reason: "unapplicable_fields" }>, detail: Record<string, unknown>) {
  const message = failure.because === "no_sweep"
    ? `A shape of kind "${failure.kind}" has no sweep to change: ${failure.fields.join(", ")}.`
    : failure.because === "outline_not_described"
      ? "That revolve's outline was drawn rather than described, so the sweep cannot be rebuilt from it. Send a profile to replace it."
      : `A shape of kind "${failure.kind}" cannot take: ${failure.fields.join(", ")}.`;
  return reply(message, 422, "unapplicable_fields", { fields: failure.fields, ...detail });
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
  // No route edits configurations yet (#618); `reason` keeps the finer code.
  invalidConfiguration: [400, "invalid_request"],
  invalidConfigurationName: [400, "invalid_request"],
  duplicateConfigurationName: [400, "invalid_request"],
  unknownConfiguration: [400, "invalid_request"],
  tooManyConfigurations: [413, "limit_exceeded"],
};

/** Maps a table refusal. `reason` carries the engine's finer code. */
function parameterError(error: ProjectParameterError) {
  const [status, code] = PARAMETER_ERROR_STATUS[error.code];
  return reply(error.message, status, code, {
    parameter: error.parameter,
    reason: error.code,
    ...(error.configuration !== undefined ? { configuration: error.configuration } : {}),
    ...(error.expressionError ? { expressionError: wireExpressionError(error.expressionError) } : {}),
    ...(error.code === "parameterInUse" ? {
      dependents: [...(error.dependents ?? [])],
      shapeDependents: (error.shapeDependents ?? []).map(({ shapeId, fields }) => ({ shapeId, fields: [...fields] })),
      sketchConstraintDependents: (error.sketchConstraintDependents ?? [])
        .map(({ shapeId, constraintIds }) => ({ shapeId, constraintIds: [...constraintIds] })),
      configurationDependents: [...(error.configurationDependents ?? [])],
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
  if (error.code === "shapeNotFound") return reply(message, 404, "shape_not_found", detail);
  if (error.code === "fieldNotBindable") return reply(message, 422, "unapplicable_fields", { ...detail, fields: [error.field] });
  if (error.code === "conflictingBinding") {
    return reply(message, 422, "unapplicable_fields", { ...detail, fields: [error.field], constraintIds: error.constraintIds ?? [] });
  }
  return reply(message, 422, "invalid_expression", detail);
}

/** Maps a sketch constraint binding refusal, in the shape `bindingError` uses for fields. */
function constraintBindingError(error: SketchConstraintBindingError, index: number | undefined) {
  const detail = {
    ...(index === undefined ? { shapeId: error.shapeId } : { index }),
    constraintId: error.constraintId,
    reason: error.code,
    ...(error.expressionError ? { expressionError: wireExpressionError(error.expressionError) } : {}),
  };
  const message = atIndex(error.message, index);
  if (error.code === "constraintNotBindable" || error.code === "sketchNotRebuildable") {
    return reply(message, 422, "unapplicable_fields", detail);
  }
  if (error.code === "conflictingBinding") return reply(message, 422, "unapplicable_fields", { ...detail, fields: error.fields ?? [] });
  if (error.code === "invalidExpression" || error.code === "outOfRange") return reply(message, 422, "invalid_expression", detail);
  return reply(message, 422, "invalid_request", detail);
}

/** Maps one engine failure. `detail` adds fields to every refusal; a wrapped binding failure names the bound shape. */
export function engineFailureToApiError(failure: EngineFailure, wording: ApiFailureWording = {}, detail: Record<string, unknown> = {}): ApiErrorReply {
  const fail = (message: string, status: number, code: ApiErrorCode, extra?: Record<string, unknown>) =>
    reply(message, status, code, { ...extra, ...detail });
  switch (failure.reason) {
    case "project_busy":
      return reply(API_ERROR_MESSAGES.projectBusy, 409, "project_busy", detail);
    case "project_not_found":
      return reply(API_ERROR_MESSAGES.projectNotFound, 404, "project_not_found", detail);
    case "shapes_not_found":
      return reply(wording.oneShape ? API_ERROR_MESSAGES.shapeNotFound : API_ERROR_MESSAGES.shapesNotFound(failure.ids), 404, "shape_not_found", detail);
    case "shape_locked":
      return reply(wording.locked?.(failure.ids) ?? API_ERROR_MESSAGES.shapeLocked, 409, "shape_locked", detail);
    case "geometry_failed":
      return fail(failure.message, failure.status === 500 ? 422 : failure.status, "geometry_failed");
    case "cad_refused":
      return fail(failure.message, failure.status, "cad_failed");
    case "cad_failed":
      return fail(wording.cadFailed ?? "The CAD kernel could not complete that operation.", 500, "cad_failed");
    case "interference_refused": {
      const refusal = failure.refusal;
      if (refusal.reason === "invalid_clearance") return fail("clearance must be a finite, non-negative number of millimetres.", 400, "invalid_request");
      if (refusal.reason === "too_many_shapes") return limitExceeded(`Interference check refused: ${refusal.given} shapes exceed the limit of ${refusal.limit}. Narrow the ids list.`, refusal.limit, refusal.given, detail);
      return limitExceeded(`Interference check refused: more than ${refusal.limit} candidate pairs; narrow the ids list or reduce clearance.`, refusal.limit, refusal.given, detail);
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
    case "constraint_binding_invalid":
      return constraintBindingError(failure.error, failure.index);
    case "sketch_unsolvable":
      return fail(atIndex(failure.message, failure.index), 422, "geometry_failed", {
        ...(failure.index === undefined ? { shapeId: failure.shapeId } : { index: failure.index }),
        constraintIds: [...failure.constraintIds],
      });
    case "binding_failed":
      return engineFailureToApiError(failure.failure, wording, {
        ...detail,
        ...(failure.index === undefined ? { shapeId: failure.shapeId } : { index: failure.index }),
        fields: [...failure.fields],
        ...(failure.constraintIds ? { constraintIds: [...failure.constraintIds] } : {}),
      });
    default:
      return fail(
        wording.refusal?.[failure.reason] ?? DEFAULT_REFUSALS[failure.reason],
        422,
        REFUSAL_CODES[failure.reason],
      );
  }
}

/**
 * Maps a `PATCH /shapes` refusal. A locked shape names itself and any fields the
 * request would bind, as a parameter change blocked by the same lock does.
 */
export function shapeChangeApiError(failure: EngineFailure, shapeId: string, request: { expressions?: unknown }): ApiErrorReply {
  if (failure.reason !== "shape_locked") return engineFailureToApiError(failure, SHAPE_CHANGE_WORDING);
  const bound = request.expressions && typeof request.expressions === "object" && !Array.isArray(request.expressions)
    ? Object.keys(request.expressions)
    : [];
  return engineFailureToApiError(failure, SHAPE_CHANGE_WORDING, { shapeId, ...(bound.length ? { fields: bound } : {}) });
}
