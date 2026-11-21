/**
 * Sketch dimensional constraints bound to parameter expressions (#612).
 *
 * A bound constraint keeps its resolved number in `valueMm` or `valueDeg`, and
 * `expression` records the source. The solver and older readers read the number.
 */

import {
  evaluateExpression,
  expressionDependencies,
  renameExpressionReference,
  type ExpressionError,
  type ExpressionQuantity,
} from "./parameterExpressions.js";
import { parameterScope } from "./expressionBindings.js";
import type { ProjectParameter, ProjectParameterDimension, SketchConstraint, SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";

export type BindableSketchConstraint = Extract<SketchConstraint, { expression?: string }>;
export type BindableSketchConstraintKind = BindableSketchConstraint["kind"];

export type SketchConstraintBindingSpec = {
  readonly kind: BindableSketchConstraintKind;
  readonly valueField: "valueMm" | "valueDeg";
  readonly dimension: ProjectParameterDimension;
};

/** Lists the constraint kinds that bind, with the field and dimension each one drives. */
export const SKETCH_CONSTRAINT_BINDABLE_KINDS: readonly SketchConstraintBindingSpec[] = Object.freeze([
  Object.freeze({ kind: "distance", valueField: "valueMm", dimension: "length" } as const),
  Object.freeze({ kind: "radius", valueField: "valueMm", dimension: "length" } as const),
  Object.freeze({ kind: "diameter", valueField: "valueMm", dimension: "length" } as const),
  Object.freeze({ kind: "angle", valueField: "valueDeg", dimension: "angle" } as const),
]);

const SPEC_BY_KIND = new Map(SKETCH_CONSTRAINT_BINDABLE_KINDS.map((entry) => [entry.kind as string, entry]));

/** Returns the spec when `constraint` can carry an expression. */
export function bindableSketchConstraint(constraint: SketchConstraint): SketchConstraintBindingSpec | undefined {
  return SPEC_BY_KIND.get(constraint.kind);
}

/** Reads the number a bindable constraint holds. */
export function sketchConstraintValue(constraint: BindableSketchConstraint): number {
  return constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
}

export type SketchConstraintBindingErrorCode =
  | "shapeNotFound" | "constraintNotFound" | "constraintNotBindable" | "invalidExpression" | "outOfRange"
  | "sketchNotRebuildable";

export type SketchConstraintBindingError = {
  readonly code: SketchConstraintBindingErrorCode;
  readonly message: string;
  /** The sketch output that holds the profile. */
  readonly shapeId: string;
  readonly constraintId: string;
  /** Set for `invalidExpression`. */
  readonly expressionError?: ExpressionError;
};

export type SketchConstraintBindingIssue = SketchConstraintBindingError;

export type SketchConstraintBindingResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: SketchConstraintBindingError };

function failure(code: SketchConstraintBindingErrorCode, shapeId: string, constraintId: string, message: string, expressionError?: ExpressionError) {
  return { ok: false as const, error: { code, shapeId, constraintId, message, ...(expressionError ? { expressionError } : {}) } };
}

/** Mirrors the `.skf` reader's ranges, so a resolved value always reloads. */
function inRange(kind: BindableSketchConstraintKind, value: number) {
  if (kind === "distance") return value >= 0;
  if (kind === "angle") return value >= 0 && value <= 180;
  return value > 0;
}

/** Evaluates `expression` for `constraint`. A bare number takes the constraint's unit. Never throws. */
export function resolveSketchConstraintBinding(
  shapeId: string,
  constraint: SketchConstraint,
  expression: string,
  parameters: readonly ProjectParameter[] | ReadonlyMap<string, ExpressionQuantity>,
): SketchConstraintBindingResult {
  const found = bindableSketchConstraint(constraint);
  if (!found) {
    return failure("constraintNotBindable", shapeId, constraint.id, `A ${constraint.kind} constraint has no value to bind.`);
  }
  const scope = parameters instanceof Map ? parameters : parameterScope(parameters as readonly ProjectParameter[]);
  const result = evaluateExpression(expression, scope, found.dimension);
  if (!result.ok) {
    return failure("invalidExpression", shapeId, constraint.id, `${constraint.id}: ${result.error.message}`, result.error);
  }
  if (!inRange(found.kind, result.value)) {
    return failure("outOfRange", shapeId, constraint.id, `${constraint.id}: a ${found.kind} constraint cannot be ${result.value}.`);
  }
  return { ok: true, value: result.value };
}

/** Sets resolved values, and the expressions when given, on the named constraints. */
export function withSketchConstraintValues(
  profile: SketchProfile,
  values: Readonly<Record<string, number>>,
  expressions: Readonly<Record<string, string | null>> = {},
): SketchProfile {
  const constraints = (profile.constraints ?? []).map((constraint) => {
    if (!bindableSketchConstraint(constraint)) return constraint;
    const bindable = constraint as BindableSketchConstraint;
    const value = values[constraint.id];
    const expression = expressions[constraint.id];
    if (value === undefined && expression === undefined) return constraint;
    const { expression: previous, ...rest } = bindable;
    const valued = value === undefined ? rest
      : rest.kind === "angle" ? { ...rest, valueDeg: value } : { ...rest, valueMm: value };
    const kept = expression === undefined ? previous : expression ?? undefined;
    return (kept === undefined ? valued : { ...valued, expression: kept }) as SketchConstraint;
  });
  return { ...profile, constraints };
}

/**
 * Reports whether a profile edit can rebuild `shape`. A nested output is reached only by its source ID.
 */
export function rebuildableSketch(shape: WorkplaneShape, topLevel: boolean): boolean {
  return Boolean(shape.sketchProfile && shape.sketchOperation && (shape.sketchSourceId || topLevel));
}

/** Visits every shape with a sketch profile, pre-order, skipping treatment `before` snapshots. */
function visitSketches(shapes: readonly WorkplaneShape[], visit: (shape: WorkplaneShape, topLevel: boolean) => void) {
  const walk = (shape: WorkplaneShape, topLevel: boolean) => {
    if (!shape || typeof shape !== "object") return;
    if (shape.sketchProfile) visit(shape, topLevel);
    shape.groupedShapes?.forEach((child) => walk(child, false));
  };
  shapes.forEach((shape) => walk(shape, true));
}

/** Refuses a binding whose sketch no profile edit can rebuild. */
export function sketchNotRebuildable(shapeId: string, constraintId: string): SketchConstraintBindingError {
  return { code: "sketchNotRebuildable", shapeId, constraintId, message: `The sketch on ${shapeId} has no rebuild recipe, so its constraints cannot bind.` };
}

/** Yields each bound constraint of `shape`'s profile. */
export function boundSketchConstraints(shape: WorkplaneShape): Array<{ constraint: BindableSketchConstraint; expression: string }> {
  return (shape.sketchProfile?.constraints ?? []).flatMap((constraint) => {
    const expression = (constraint as { expression?: unknown }).expression;
    return typeof expression === "string" ? [{ constraint: constraint as BindableSketchConstraint, expression }] : [];
  });
}

/** Lists constraint bindings that do not resolve against `parameters`. Changes nothing. */
export function sketchConstraintBindingIssues(
  shapes: readonly WorkplaneShape[],
  parameters: readonly ProjectParameter[],
): SketchConstraintBindingIssue[] {
  const scope = parameterScope(parameters);
  const issues: SketchConstraintBindingIssue[] = [];
  visitSketches(shapes, (shape, topLevel) => {
    for (const { constraint, expression } of boundSketchConstraints(shape)) {
      if (!rebuildableSketch(shape, topLevel)) {
        issues.push(sketchNotRebuildable(shape.id, constraint.id));
        continue;
      }
      const result = resolveSketchConstraintBinding(shape.id, constraint, expression, scope);
      if (!result.ok) issues.push(result.error);
    }
  });
  return issues;
}

export type SketchConstraintDependent = { readonly shapeId: string; readonly constraintIds: readonly string[] };

/** Lists sketch outputs whose constraint bindings reference `name` directly, in tree order. */
export function parameterSketchConstraintDependents(shapes: readonly WorkplaneShape[], name: string): SketchConstraintDependent[] {
  const dependents: SketchConstraintDependent[] = [];
  visitSketches(shapes, (shape) => {
    const constraintIds = boundSketchConstraints(shape)
      .filter(({ expression }) => expressionDependencies(expression).includes(name))
      .map(({ constraint }) => constraint.id);
    if (constraintIds.length) dependents.push({ shapeId: shape.id, constraintIds });
  });
  return dependents;
}

/** Rewrites `oldName` in every constraint binding, including treatment `before` snapshots. Keeps untouched shapes by reference. */
export function renameSketchConstraintReferences(shapes: readonly WorkplaneShape[], oldName: string, newName: string): WorkplaneShape[] {
  const rename = (shape: WorkplaneShape): WorkplaneShape => {
    if (!shape || typeof shape !== "object") return shape;
    let next = shape;
    const bound = boundSketchConstraints(shape);
    if (bound.length) {
      const expressions = Object.fromEntries(bound.map(({ constraint, expression }) =>
        [constraint.id, renameExpressionReference(expression, oldName, newName)]));
      if (bound.some(({ constraint, expression }) => expressions[constraint.id] !== expression)) {
        next = { ...next, sketchProfile: withSketchConstraintValues(shape.sketchProfile!, {}, expressions) };
      }
    }
    if (shape.groupedShapes) {
      const children = shape.groupedShapes.map(rename);
      if (children.some((child, index) => child !== shape.groupedShapes![index])) next = { ...next, groupedShapes: children };
    }
    if (shape.edgeTreatmentHistory) {
      const history = shape.edgeTreatmentHistory.map((entry) => {
        const before = rename(entry.before);
        return before === entry.before ? entry : { ...entry, before };
      });
      if (history.some((entry, index) => entry !== shape.edgeTreatmentHistory![index])) next = { ...next, edgeTreatmentHistory: history };
    }
    return next;
  };
  return shapes.map(rename);
}

/**
 * Treats an incoming profile's constraint values as literals. Keeps an expression only
 * when the stored constraint has the same expression and value; binding goes through the engine.
 */
export function literalSketchProfile(existing: SketchProfile | undefined, incoming: SketchProfile): SketchProfile {
  if (!Array.isArray(incoming.constraints) || !incoming.constraints.some((constraint) => (constraint as { expression?: unknown }).expression !== undefined)) return incoming;
  const stored = new Map((existing?.constraints ?? []).map((constraint) => [constraint.id, constraint]));
  const constraints = incoming.constraints.map((constraint) => {
    const { expression, ...rest } = constraint as BindableSketchConstraint;
    if (expression === undefined) return constraint;
    const previous = stored.get(constraint.id) as BindableSketchConstraint | undefined;
    const kept = previous?.kind === constraint.kind && previous.expression === expression
      && bindableSketchConstraint(constraint)
      && sketchConstraintValue(previous) === sketchConstraintValue(constraint as BindableSketchConstraint);
    return (kept ? constraint : rest) as SketchConstraint;
  });
  return { ...incoming, constraints };
}
