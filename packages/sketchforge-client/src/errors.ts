/** Errors the API answers with, kept distinguishable so a macro can react to them. */

import type { ExpressionError, ShapeDependent, SketchConstraintDependent } from "./types.js";

/**
 * The server's machine-readable reason, which a status code is too coarse to
 * carry: `404` is a missing project, a missing shape or an API that is switched
 * off, and `409` is both a busy project worth retrying and a locked shape that
 * never will be.
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
  "configuration_not_found",
  "configuration_exists",
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

export type ApiErrorContext = {
  method: string;
  url: string;
  status: number;
  /** The server's `error` string, when it sent one. */
  detail?: string;
  /** The server's `code`, absent against a server older than codes. */
  code?: string;
  body?: unknown;
};

export class SketchForgeApiError extends Error {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(context: ApiErrorContext) {
    super(`${context.method} ${context.url} failed with ${context.status}: ${context.detail ?? "no detail"}`);
    this.name = "SketchForgeApiError";
    this.method = context.method;
    this.url = context.url;
    this.status = context.status;
    this.detail = context.detail;
    this.code = context.code;
    this.body = context.body;
  }

  /**
   * Whether the server gave this reason.
   *
   * The prose match is the fallback for a server from before codes existed, and
   * is deliberately kept: a client that only read `code` would treat every error
   * from such a server as unrecognised.
   */
  private is(code: ApiErrorCode, status: number, prose: RegExp) {
    if (this.code) return this.code === code;
    return this.status === status && prose.test(this.detail ?? "");
  }

  /**
   * The API answers 404 for every route when `SKETCHFORGE_API_TOKEN` is unset,
   * which is indistinguishable from a missing project by status alone.
   */
  get looksDisabled() {
    return this.is("api_disabled", 404, /disabled/i);
  }

  /** The server has a token but no project directory, so it can store nothing. */
  get needsStorage() {
    return this.status === 503;
  }

  /** A size or count cap was reached; `too_many_shapes` is accepted during the compatibility window. */
  get isLimitExceeded() {
    return this.code ? this.code === "limit_exceeded" || this.code === "too_many_shapes" : this.status === 413;
  }

  /** Another write holds the project's lock. Retrying is the right response. */
  get isProjectBusy() {
    return this.is("project_busy", 409, /being changed/i);
  }

  /** The project changed since the supplied If-Match revision. */
  get isRevisionMismatch() {
    return this.is("revision_mismatch", 409, /changed since/i);
  }

  get currentRevision(): number | undefined {
    const revision = (this.body as { revision?: unknown } | undefined)?.revision;
    return typeof revision === "number" ? revision : undefined;
  }

  /** That shape is locked. Retrying will not help; unlock it first. */
  get isShapeLocked() {
    return this.is("shape_locked", 409, /locked/i);
  }

  /** No such project on the server. */
  get isProjectMissing() {
    return this.is("project_not_found", 404, /project is not on the server/i);
  }

  /** No such shape in the project. */
  get isShapeMissing() {
    return this.is("shape_not_found", 404, /not in the project/i);
  }

  /**
   * The change named fields the shape's kind has no use for.
   *
   * `unapplicableFields` lists them, which is the whole reason this is an error
   * rather than a silent no-op.
   */
  get hasUnapplicableFields() {
    return this.is("unapplicable_fields", 422, /cannot take|no sweep to change/i);
  }

  get unapplicableFields(): string[] {
    return this.fields;
  }

  /** A parameter or bound field does not evaluate; `expressionError` says where. */
  get isInvalidExpression() {
    return this.code === "invalid_expression";
  }

  get isParameterMissing() {
    return this.code === "parameter_not_found";
  }

  /** The table already has a parameter with that name. */
  get isParameterDuplicate() {
    return this.code === "parameter_exists";
  }

  /** A delete was refused; `dependents` and `shapeDependents` name what still uses it. */
  get isParameterInUse() {
    return this.code === "parameter_in_use";
  }

  /** No parameter configuration has that name. */
  get isConfigurationMissing() {
    return this.code === "configuration_not_found";
  }

  /** A parameter configuration with that name already exists. */
  get isConfigurationDuplicate() {
    return this.code === "configuration_exists";
  }

  /** The parameter that failed, which can be a dependent of the one changed. */
  get parameter(): string | undefined {
    return this.text("parameter");
  }

  /** The engine's finer code, such as `outOfRange` or `duplicateName`. */
  get reason(): string | undefined {
    return this.text("reason");
  }

  get expressionError(): ExpressionError | undefined {
    const detail = this.detailBody.expressionError;
    return detail && typeof detail === "object" ? (detail as ExpressionError) : undefined;
  }

  /** Parameters whose expressions use the one a delete was refused for. */
  get dependents(): string[] {
    return strings(this.detailBody.dependents);
  }

  get shapeDependents(): ShapeDependent[] {
    const entries = this.detailBody.shapeDependents;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry): entry is { shapeId: string; fields?: unknown } => !!entry && typeof entry === "object" && typeof (entry as { shapeId?: unknown }).shapeId === "string")
      .map((entry) => ({ shapeId: entry.shapeId, fields: strings(entry.fields) }));
  }

  get sketchConstraintDependents(): SketchConstraintDependent[] {
    const entries = this.detailBody.sketchConstraintDependents;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry): entry is { shapeId: string; constraintIds?: unknown } => !!entry && typeof entry === "object" && typeof (entry as { shapeId?: unknown }).shapeId === "string")
      .map((entry) => ({ shapeId: entry.shapeId, constraintIds: strings(entry.constraintIds) }));
  }

  /** Parameter configurations whose overrides use the one a delete was refused for. */
  get configurationDependents(): string[] {
    return strings(this.detailBody.configurationDependents);
  }

  /** The parameter configuration whose table failed; absent for the base table. */
  get configuration(): string | undefined {
    return this.text("configuration");
  }

  /** The shape a binding refusal is about. A batch create names its `index` instead. */
  get shapeId(): string | undefined {
    return this.text("shapeId");
  }

  get field(): string | undefined {
    return this.text("field");
  }

  /** Fields named by `unapplicable_fields`, or the bound fields of a refused rebuild. */
  get fields(): string[] {
    return strings(this.detailBody.fields);
  }

  /** The sketch constraint a constraint-binding refusal is about. */
  get constraintId(): string | undefined {
    return this.text("constraintId");
  }

  /** Sketch constraints that conflict with a refused binding, or that an unsolvable sketch could not satisfy. */
  get constraintIds(): string[] {
    return strings(this.detailBody.constraintIds);
  }

  /** Position in a batch `POST /shapes`, whose new shape has no id yet. */
  get index(): number | undefined {
    const index = this.detailBody.index;
    return typeof index === "number" ? index : undefined;
  }

  private get detailBody(): Record<string, unknown> {
    return this.body && typeof this.body === "object" ? (this.body as Record<string, unknown>) : {};
  }

  private text(key: string): string | undefined {
    const value = this.detailBody[key];
    return typeof value === "string" ? value : undefined;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The request never reached the server, or never came back. */
export class SketchForgeTransportError extends Error {
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string, cause: unknown) {
    super(`${method} ${url} could not be completed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SketchForgeTransportError";
    this.method = method;
    this.url = url;
    this.cause = cause;
  }
}
