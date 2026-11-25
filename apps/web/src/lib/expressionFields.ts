/**
 * Expression entry in editor dimension fields (#617). Resolves with the engine's own
 * binding functions, so the editor refuses exactly what REST refuses.
 */

import {
  EXPRESSION_BINDABLE_FIELDS,
  bindableField,
  boundFieldValue,
  withoutBindings,
  type BindableFieldSpec,
  type ShapeBindingError,
} from "@constructorfleet/sketchforge-engine/expressionBindings";
import { validateBinding } from "@constructorfleet/sketchforge-engine/bindingValidation";
import { plainPrimitive } from "@constructorfleet/sketchforge-engine/parameterBindingPlan";
import {
  bindableSketchConstraint,
  resolveSketchConstraintBinding,
  sketchConstraintValue,
  type BindableSketchConstraint,
  type SketchConstraintBindingError,
} from "@constructorfleet/sketchforge-engine/sketchConstraintBindings";
import { shapeWithRequestedChanges } from "@constructorfleet/sketchforge-engine/shapeRequests";
import type { ExpressionError } from "@constructorfleet/sketchforge-engine/parameterExpressions";
import type { MessageKey } from "@/i18n/locales";
import { parseMeasurementInput } from "@/lib/measurementUnits";
import {
  formatParameterValue,
  parameterEditFailureMessage,
  parameterErrorMessage,
  parameterRecomputeResponseMessage,
  type ParameterEditFailure,
  type ParameterMessage,
} from "@/lib/projectParameterEdits";
import type { RangePropertyConfig } from "@/lib/shapeProperties";
import type { ProjectParameter, ProjectParameterDimension, SketchConstraint, SketchProfile, WorkplaneShape } from "@/types/sketchforge";

// Matches what parseMeasurementInput reads as a number, including exponents such as 1e3.
const LITERAL_NUMBER = /^[+-]?(?:\d[\d.,]*|[.,]\d+)(?:[eE][+-]?\d+)?$/;

/** Reports whether `text` is a plain number, which sets a literal and removes any binding. */
export function isLiteralNumberEntry(text: string) {
  const compact = text.trim().replace(/[\s ]/g, "");
  return LITERAL_NUMBER.test(compact) && Number.isFinite(parseMeasurementInput(compact));
}

function sameAngle(left: number, right: number) {
  const turn = ((left - right) % 360 + 360) % 360;
  return Math.min(turn, 360 - turn) < 1e-6;
}

/**
 * Returns the bindable field an inspector row drives on `shape`. Refuses a row whose
 * displayed number is not the stored field, such as a tapered shape's overall width.
 */
export function propertyBindingField(shape: WorkplaneShape, property: Pick<RangePropertyConfig, "field" | "value">): BindableFieldSpec | undefined {
  if (!property.field) return undefined;
  const found = bindableField(shape, property.field);
  if (!found) return undefined;
  const stored = boundFieldValue(shape, property.field);
  if (stored === undefined) return undefined;
  const matches = found.periodic ? sameAngle(stored, property.value) : Math.abs(stored - property.value) <= 1e-6 * Math.max(1, Math.abs(stored));
  return matches ? found : undefined;
}

function releaseConstraints(previous: SketchProfile | undefined, next: SketchProfile | undefined): SketchProfile | undefined {
  if (!next?.constraints || previous === next) return next;
  const before = new Map((previous?.constraints ?? []).map((constraint) => [constraint.id, constraint]));
  let changed = false;
  const constraints = next.constraints.map((constraint) => {
    const bound = constraint as BindableSketchConstraint;
    if (!bindableSketchConstraint(constraint) || bound.expression === undefined) return constraint;
    const old = before.get(constraint.id) as BindableSketchConstraint | undefined;
    if (!old || old.kind !== bound.kind || old.expression !== bound.expression || sketchConstraintValue(old) === sketchConstraintValue(bound)) return constraint;
    changed = true;
    const { expression: _released, ...literal } = bound;
    return literal as SketchConstraint;
  });
  return changed ? { ...next, constraints } : next;
}

function releaseShape(previous: WorkplaneShape | undefined, next: WorkplaneShape): WorkplaneShape {
  if (!previous || previous === next) return next;
  const edited = Object.entries(next.expressions ?? {})
    .filter(([field, expression]) => previous.expressions?.[field] === expression && !Object.is(boundFieldValue(previous, field), boundFieldValue(next, field)))
    .map(([field]) => field);
  let shape = withoutBindings(next, edited);
  const profile = releaseConstraints(previous.sketchProfile, next.sketchProfile);
  if (profile !== next.sketchProfile) shape = { ...shape, sketchProfile: profile };
  if (next.groupedShapes && next.groupedShapes !== previous.groupedShapes) {
    const children = releaseEditedBindings(previous.groupedShapes ?? [], next.groupedShapes);
    if (children !== next.groupedShapes) shape = { ...shape, groupedShapes: children };
  }
  return shape;
}

/**
 * Drops each binding whose number a local edit changed while its expression stayed,
 * so the next parameter change cannot snap the edit back. Keeps arrays and shapes by reference when nothing drops.
 */
export function releaseEditedBindings(previous: readonly WorkplaneShape[], next: WorkplaneShape[]): WorkplaneShape[] {
  if (previous === next) return next;
  const before = new Map(previous.map((shape) => [shape.id, shape]));
  let changed = false;
  const released = next.map((shape) => {
    const result = releaseShape(before.get(shape.id), shape);
    if (result !== shape) changed = true;
    return result;
  });
  return changed ? released : next;
}

/**
 * Carries `previous`'s bindings onto a shape rebuilt from scratch, such as a revolve.
 * Drops any binding whose number the rebuild changed, and each `released` field still bound to the released expression.
 */
export function withRebuiltBindings(
  previous: WorkplaneShape,
  rebuilt: WorkplaneShape,
  released: Readonly<Record<string, string>> = {},
): WorkplaneShape {
  if (!previous.expressions) return rebuilt;
  // A field rebound since its release keeps the new binding.
  const stillReleased = Object.keys(released).filter((field) => previous.expressions![field] === released[field]);
  const carried = withoutBindings({ ...rebuilt, expressions: previous.expressions }, stillReleased);
  return releaseEditedBindings([previous], [carried])[0]!;
}

/** Binds, or with `expression: null` unbinds, one shape field through `POST /api/editor/parameters`. */
export type EditorFieldBind = { kind: "bindShape"; shapeId: string; field: string; expression: string | null };

function containsShape(shape: WorkplaneShape, id: string): boolean {
  return shape.id === id || Boolean(shape.groupedShapes?.some((child) => containsShape(child, id)));
}

function sketchSourceIds(shape: WorkplaneShape, into = new Set<string>()) {
  if (shape.sketchSourceId) into.add(shape.sketchSourceId);
  shape.groupedShapes?.forEach((child) => sketchSourceIds(child, into));
  return into;
}

/** Picks the top-level trees a bind must send: the one holding `shapeId`, and trees sharing its sketch sources. */
export function bindScope(shapes: readonly WorkplaneShape[], shapeId: string): WorkplaneShape[] {
  const target = shapes.find((shape) => containsShape(shape, shapeId));
  if (!target) return [];
  const sources = sketchSourceIds(target);
  return shapes.filter((shape) => shape === target || [...sketchSourceIds(shape)].some((source) => sources.has(source)));
}

export type LocalBindResult = { ok: true; shapes: WorkplaneShape[] } | { ok: false; failure: ParameterEditFailure };

/**
 * Binds `field` on a top-level plain primitive, or removes a binding on any top-level shape.
 * Returns null when the bind needs the engine's kernel paths on the server.
 */
export function bindShapeFieldLocally(
  shapes: readonly WorkplaneShape[],
  parameters: readonly ProjectParameter[],
  shapeId: string,
  field: string,
  expression: string | null,
): LocalBindResult | null {
  const index = shapes.findIndex((shape) => shape.id === shapeId);
  if (index < 0) return null;
  const shape = shapes[index]!;
  const replace = (next: WorkplaneShape) => [...shapes.slice(0, index), next, ...shapes.slice(index + 1)];
  if (shape.locked) return { ok: false, failure: { reason: "binding_failed", shapeId, fields: [field], failure: { reason: "shape_locked" } } };
  if (expression === null) return { ok: true, shapes: replace(withoutBindings(shape, [field])) };
  const found = bindableField(shape, field);
  if (!plainPrimitive(shape) || !found || found.target !== "shape") return null;
  // The lock is checked above, with the editor's own refusal.
  const checked = validateBinding({ roots: shapes, target: { shape, topLevel: true }, parameters }, { field, expression });
  if (!checked.ok) return { ok: false, failure: { ...checked.failure } };
  const value = checked.value!;
  let next = shape;
  if (boundFieldValue(shape, field) !== value) {
    const changed = shapeWithRequestedChanges(shape, { [field]: value });
    if (!changed.ok) return { ok: false, failure: { reason: "binding_failed", shapeId, fields: [field] } };
    next = changed.shape;
  }
  return { ok: true, shapes: replace({ ...next, expressions: { ...shape.expressions, [field]: expression } }) };
}

const NEEDS_DIMENSION: Record<ProjectParameterDimension, MessageKey> = {
  length: "editor.expressionField.error.needsLength",
  angle: "editor.expressionField.error.needsAngle",
  unitless: "editor.expressionField.error.needsUnitless",
};

function expressionMessage(error: ExpressionError | undefined, label: string, dimension: ProjectParameterDimension | undefined): ParameterMessage {
  if (error?.code === "dimensionMismatch" && dimension) return { key: NEEDS_DIMENSION[dimension], values: {} };
  return parameterErrorMessage({ code: "invalidExpression", parameter: label, message: error?.message ?? "", ...(error ? { expressionError: error } : {}) });
}

const SPEC_BY_FIELD = new Map(EXPRESSION_BINDABLE_FIELDS.map((entry) => [entry.field, entry]));

/** Maps a refused field bind, local or from the server, to a catalog message. */
export function bindingFailureMessage(failure: ParameterEditFailure | null, shapes: readonly WorkplaneShape[]): ParameterMessage {
  if (failure?.reason === "binding_invalid" && failure.error) {
    const error = failure.error as unknown as ShapeBindingError;
    if (error.code === "invalidExpression") return expressionMessage(error.expressionError, error.field, SPEC_BY_FIELD.get(error.field)?.dimension);
    if (error.code === "outOfRange") return { key: "editor.expressionField.error.outOfRange", values: { value: formatParameterValue(error.value ?? Number.NaN) } };
    if (error.code === "notAnInteger") return { key: "editor.expressionField.error.notAnInteger", values: {} };
    if (error.code === "fieldNotBindable") return { key: "editor.expressionField.error.fieldNotBindable", values: {} };
    if ((error.code as string) === "conflictingBinding") {
      const constraints = (failure.error as { constraintIds?: readonly string[] }).constraintIds ?? [];
      return { key: "editor.expressionField.error.sizeConflictsWithConstraints", values: { constraints: constraints.join(", ") } };
    }
  }
  if (failure?.reason === "constraint_binding_invalid" && failure.error) {
    return constraintBindingMessage(failure.error as unknown as SketchConstraintBindingError);
  }
  return parameterEditFailureMessage(failure, shapes);
}

/** Maps a bind response that is not a success to a message. */
export function bindResponseMessage(status: number, body: unknown, shapes: readonly WorkplaneShape[]): ParameterMessage {
  const failure = body && typeof body === "object" ? (body as { failure?: ParameterEditFailure }).failure : undefined;
  return failure ? bindingFailureMessage(failure, shapes) : parameterRecomputeResponseMessage(status, body, shapes);
}

/** Maps a refused sketch constraint bind to a catalog message. `dimension` is the constraint's own. */
export function constraintBindingMessage(error: SketchConstraintBindingError, dimension: ProjectParameterDimension = "length"): ParameterMessage {
  if (error.code === "invalidExpression") return expressionMessage(error.expressionError, error.constraintId, dimension);
  if (error.code === "outOfRange") return { key: "editor.expressionField.error.constraintOutOfRange", values: {} };
  if (error.code === "conflictingBinding") return { key: "editor.expressionField.error.constraintConflictsWithSize", values: { fields: (error.fields ?? []).join(", ") } };
  if (error.code === "sketchNotRebuildable") return { key: "editor.expressionField.error.sketchNotRebuildable", values: {} };
  return { key: "editor.expressionField.error.fieldNotBindable", values: {} };
}

/**
 * Refuses binding a constraint of the open sketch that the saved output's bindings forbid.
 * The output's lock and rebuild recipe are checked when the sketch is finished.
 */
export function draftConstraintConflict(output: WorkplaneShape, constraintId: string, expression: string): SketchConstraintBindingError | undefined {
  const checked = validateBinding(
    { roots: [output], target: { shape: output, topLevel: true }, draft: true },
    { constraintId, constraint: undefined, expression },
  );
  return checked.ok || checked.failure.reason !== "constraint_binding_invalid" ? undefined : checked.failure.error;
}

export type ConstraintEntry =
  | { ok: true; value: number; expression: string | null }
  | { ok: false; error: SketchConstraintBindingError };

/** Resolves typed text for a dimensional constraint. A plain number is a literal; `expression: null` clears a binding. */
export function resolveConstraintEntry(
  constraint: SketchConstraint,
  text: string,
  parameters: readonly ProjectParameter[],
  /** The sketch's existing output, whose bound profile size refuses a constraint binding (#629). */
  output?: WorkplaneShape | null,
): ConstraintEntry {
  const literal = isLiteralNumberEntry(text);
  const source = literal ? String(parseMeasurementInput(text)) : text.trim();
  const conflict = !literal && output ? draftConstraintConflict(output, constraint.id, source) : undefined;
  if (conflict) return { ok: false, error: conflict };
  const resolved = resolveSketchConstraintBinding("sketch", constraint, source, parameters);
  if (!resolved.ok) return resolved;
  return { ok: true, value: resolved.value, expression: literal ? null : source };
}

export type ExpressionCompletion = { start: number; end: number; query: string };

const NAME_CHAR = /[A-Za-z0-9_]/;

/** Finds the parameter name being typed at `caret`, or null when the caret is not in a name. */
export function expressionCompletionAt(text: string, caret: number): ExpressionCompletion | null {
  let start = caret;
  while (start > 0 && NAME_CHAR.test(text[start - 1]!)) start -= 1;
  let end = caret;
  while (end < text.length && NAME_CHAR.test(text[end]!)) end += 1;
  const query = text.slice(start, caret);
  // A name cannot start with a digit; `2mm` is a number and its unit.
  if (start === end || !/[A-Za-z_]/.test(text[start]!)) return null;
  return { start, end, query };
}

/** Replaces the name at `completion` with `name` and places the caret after it. */
export function applyExpressionCompletion(text: string, completion: ExpressionCompletion, name: string) {
  return { text: text.slice(0, completion.start) + name + text.slice(completion.end), caret: completion.start + name.length };
}
