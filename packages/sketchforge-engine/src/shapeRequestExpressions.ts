/**
 * The `expressions` field of a shape request (#613).
 *
 * A request binds a field with `expressions: { width: "wall * 2" }` and clears
 * one with `null`. The numeric field keeps its resolved number, so a shape read
 * back and sent whole carries both.
 */

import { boundFieldValue, EXPRESSION_BINDABLE_FIELDS } from "./expressionBindings.js";
import type { ShapeRequest } from "./shapeRequests.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

/** Bounds one expression's source text. */
export const MAX_REQUEST_EXPRESSION_LENGTH = 1_000;

export type RequestExpressions = Record<string, string | null>;

export type ParsedRequestExpressions =
  | { readonly ok: true; readonly expressions: RequestExpressions }
  | { readonly ok: false; readonly message: string };

/** Validates a request's `expressions`. `null` clears a binding, so only a change may send it. */
export function parseRequestExpressions(value: unknown, { allowNull }: { allowNull: boolean }): ParsedRequestExpressions {
  if (value === undefined) return { ok: true, expressions: {} };
  const refused = (message: string) => ({ ok: false as const, message });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return refused("expressions must be an object of field names to expression strings.");
  }
  const entries = Object.entries(value);
  if (entries.length > EXPRESSION_BINDABLE_FIELDS.length) {
    return refused(`expressions can name at most ${EXPRESSION_BINDABLE_FIELDS.length} fields.`);
  }
  for (const [field, expression] of entries) {
    if (expression === null && allowNull) continue;
    if (typeof expression !== "string" || !expression.trim()) {
      return refused(allowNull
        ? `expressions.${field} must be an expression string, or null to clear the binding.`
        : `expressions.${field} must be an expression string.`);
    }
    if (expression.length > MAX_REQUEST_EXPRESSION_LENGTH) {
      return refused(`expressions.${field} can be at most ${MAX_REQUEST_EXPRESSION_LENGTH} characters.`);
    }
  }
  return { ok: true, expressions: value as RequestExpressions };
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

/** Reads the literal a request sends for a binding key, in any of the forms a change accepts. */
export function requestedBindingValue(request: ShapeRequest, field: string): number | undefined {
  if (field.startsWith("revolve.")) {
    const setting = field.slice("revolve.".length);
    const nested = request.revolve && typeof request.revolve === "object" ? (request.revolve as Record<string, unknown>)[setting] : undefined;
    return numberOrUndefined(nested ?? request[setting]);
  }
  if (field === "faceDraft.angle") {
    return request.faceDraft && typeof request.faceDraft === "object" ? numberOrUndefined((request.faceDraft as Record<string, unknown>).angle) : undefined;
  }
  if (field === "width" || field === "depth" || field === "height") return numberOrUndefined(request[field] ?? request.size);
  return numberOrUndefined(request[field]);
}

/**
 * Lists bound fields the request sends back unchanged. Such a literal is an echo
 * of the summary, not an edit, so its binding stays.
 */
export function echoedBindings(shape: WorkplaneShape, request: ShapeRequest): string[] {
  return Object.keys(shape.expressions ?? {}).filter((field) => {
    const requested = requestedBindingValue(request, field);
    return requested !== undefined && requested === boundFieldValue(shape, field);
  });
}
