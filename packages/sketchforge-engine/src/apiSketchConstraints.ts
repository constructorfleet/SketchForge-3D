/**
 * Reads and replies for `PATCH /api/v1/sketch-constraints`.
 *
 * Shared with MCP local mode, so both refuse the same requests with the same
 * sentence and reply with the same fields.
 */

import { apiShapeSummary } from "./apiShapeSummary.js";
import { engineFailureToApiError, type ApiErrorReply, type ApiFailureWording } from "./apiErrors.js";
import { API_PARAMETER_EXPRESSION_LIMIT, API_PARAMETER_EXPRESSION_MAX_LENGTH } from "./apiParameters.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";
import type { EngineFailure } from "./engine.js";
import { sketchConstraintSummary, type BindableSketchConstraint } from "./sketchConstraintBindings.js";

export const API_CONSTRAINT_ID_MAX_LENGTH = 200;

export const API_SKETCH_CONSTRAINT_MESSAGES = {
  constraintIdRequired: "A constraintId is required.",
  body: `Send expression as a non-empty string of at most ${API_PARAMETER_EXPRESSION_LIMIT}, or null to remove the binding.`,
} as const;

/**
 * The route addresses one shape through `?shapeId=`. A lock can sit on that
 * shape or on a group holding it, so the sentence names the locked one.
 */
export const SKETCH_CONSTRAINT_WORDING: ApiFailureWording = {
  oneShape: true,
  locked: (ids) => `Shape ${ids.join(", ")} is locked, so the sketch it holds cannot change. Send it locked: false first.`,
};

/** Maps a bind refusal. A lock names the locked shape or group as `shapeId`. */
export function sketchConstraintApiError(failure: EngineFailure): ApiErrorReply {
  return engineFailureToApiError(failure, SKETCH_CONSTRAINT_WORDING, failure.reason === "shape_locked" ? { shapeId: failure.ids[0] } : {});
}

/** Returns the trimmed `?constraintId=`, or undefined when it is missing or too long. */
export function apiConstraintId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= API_CONSTRAINT_ID_MAX_LENGTH ? trimmed : undefined;
}

/** Accepts `{ expression }` alone, where expression is a non-blank string or null. */
export function isApiSketchConstraintBindRequest(body: unknown): body is { expression: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "expression") || !("expression" in fields)) return false;
  const { expression } = fields;
  return expression === null
    || (typeof expression === "string" && /\S/.test(expression) && expression.length <= API_PARAMETER_EXPRESSION_MAX_LENGTH);
}

/** The bind reply: the rebuilt output, the constraint as summaries report it, and the revision. */
export function apiSketchConstraintBound(value: { shape: WorkplaneShape; revision: number }, constraintId: string) {
  const constraint = value.shape.sketchProfile?.constraints?.find((candidate) => candidate.id === constraintId);
  return {
    shape: apiShapeSummary(value.shape),
    constraint: sketchConstraintSummary(constraint as BindableSketchConstraint),
    revision: value.revision,
  };
}
