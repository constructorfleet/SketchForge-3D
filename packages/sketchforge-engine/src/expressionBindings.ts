/**
 * Shape and feature fields bound to parameter expressions (#611).
 *
 * A bound field keeps its resolved number in the shape, and `shape.expressions`
 * records the expression. Kernels, exports and older readers read the number.
 * Everything here is pure; the engine applies resolved values through its
 * normal change path so retained features replay as for a manual edit.
 */

import {
  evaluateExpression,
  expressionDependencies,
  renameExpressionReference,
  type ExpressionError,
  type ExpressionQuantity,
} from "./parameterExpressions.js";
import { SHAPE_PARAMETERS, type ShapeParameterName } from "./shapeRequests.js";
import type { ProjectParameter, ProjectParameterDimension, ShapeKind, WorkplaneShape } from "./domain/sketchforge.js";

/** Names the retained feature a feature field needs on the shape. */
export type BindableFieldRequirement = "revolve" | "draftPrism" | "faceDraft" | "sketchEdgeTreatment" | "sketchChamfer";

export type BindableFieldSpec = {
  /** Key in `shape.expressions`. Dotted keys name a retained feature's setting. */
  readonly field: string;
  readonly dimension: ProjectParameterDimension;
  /** Requires the resolved value to be a whole number. */
  readonly integer?: true;
  /**
   * `shape` fields bind on top-level shapes only. `feature` fields also bind on
   * sketch outputs inside groups, because a sketch-source edit reaches them.
   */
  readonly target: "shape" | "feature";
  /** Kinds that carry the field. Absent means every kind. */
  readonly kinds?: readonly ShapeKind[];
  readonly requires?: BindableFieldRequirement;
};

const ALL_SHAPE_KINDS: readonly ShapeKind[] = [
  "box", "cylinder", "sphere", "sketch", "scribble", "cone", "pyramid", "roof", "text", "roundRoof",
  "halfSphere", "torus", "tube", "gear", "ring", "wedge", "polygon", "icosahedron", "mesh", "loft",
];

const NUMERIC_SHAPE_PARAMETERS: ReadonlyArray<readonly [ShapeParameterName, ProjectParameterDimension, boolean]> = [
  ["steps", "unitless", true], ["sides", "unitless", true], ["bevel", "length", false], ["segments", "unitless", true],
  ["topRadius", "length", false], ["baseRadius", "length", false],
  ["taperTopWidth", "length", false], ["taperTopDepth", "length", false],
  ["taperBottomWidth", "length", false], ["taperBottomDepth", "length", false],
  ["teeth", "unitless", true], ["toothSize", "length", false], ["toothWidth", "length", false],
  ["centerHoleSize", "length", false], ["helixAngle", "angle", false],
  ["loftTopWidth", "length", false], ["loftTopDepth", "length", false],
  ["loftBottomRotation", "angle", false], ["loftTopRotation", "angle", false],
  ["loftSegments", "unitless", true], ["loftLayers", "unitless", true],
];

function spec(field: string, dimension: ProjectParameterDimension, extra: Partial<BindableFieldSpec> = {}): BindableFieldSpec {
  return Object.freeze({ field, dimension, target: "shape" as const, ...extra });
}

/** Lists every bindable numeric field with its dimension. REST, MCP, clients and the editor share it. */
export const EXPRESSION_BINDABLE_FIELDS: readonly BindableFieldSpec[] = Object.freeze([
  ...(["x", "z", "elevation", "width", "depth", "height"] as const).map((field) => spec(field, "length")),
  ...(["rotation", "rotationX", "rotationZ"] as const).map((field) => spec(field, "angle")),
  ...NUMERIC_SHAPE_PARAMETERS.map(([field, dimension, integer]) => spec(field, dimension, {
    ...(integer ? { integer: true as const } : {}),
    kinds: Object.freeze(ALL_SHAPE_KINDS.filter((kind) => SHAPE_PARAMETERS[field].appliesTo(kind))),
  })),
  spec("revolve.startAngle", "angle", { target: "feature", requires: "revolve" }),
  spec("revolve.sweepAngle", "angle", { target: "feature", requires: "revolve" }),
  spec("revolve.sides", "unitless", { target: "feature", requires: "revolve", integer: true }),
  spec("revolve.quality", "unitless", { target: "feature", requires: "revolve" }),
  spec("revolve.pitch", "length", { target: "feature", requires: "revolve" }),
  spec("revolve.turns", "unitless", { target: "feature", requires: "revolve" }),
  spec("revolve.coreRadius", "length", { target: "feature", requires: "revolve" }),
  spec("draftPrismAngle", "angle", { target: "feature", requires: "draftPrism" }),
  spec("faceDraft.angle", "angle", { target: "feature", requires: "faceDraft" }),
  spec("edgeTreatments.0.amount", "length", { target: "feature", requires: "sketchEdgeTreatment" }),
  spec("edgeTreatments.0.chamferAngle", "angle", { target: "feature", requires: "sketchChamfer" }),
]);

const SPEC_BY_FIELD = new Map(EXPRESSION_BINDABLE_FIELDS.map((entry) => [entry.field, entry]));

/** Treatment amounts replay only through a sketch recipe rebuild, so plain solids cannot bind them. */
function hasSketchRecipe(shape: WorkplaneShape) {
  return Boolean(shape.sketchSourceId && shape.sketchProfile && shape.sketchOperation);
}

function meetsRequirement(shape: WorkplaneShape, requirement: BindableFieldRequirement | undefined) {
  switch (requirement) {
    case undefined: return true;
    case "revolve": return shape.sketchOperation === "revolve" && Boolean(shape.sketchProfile) && Boolean(shape.sketchRevolve);
    case "draftPrism": return shape.draftPrismAngle !== undefined && shape.sketchOperation === "extrude" && Boolean(shape.sketchProfile);
    case "faceDraft": return shape.faceDraft !== undefined;
    case "sketchEdgeTreatment": return hasSketchRecipe(shape) && shape.edgeTreatments?.length === 1;
    case "sketchChamfer": return hasSketchRecipe(shape) && shape.edgeTreatments?.length === 1 && shape.edgeTreatments[0]!.kind === "chamfer";
  }
}

/** Returns the spec when `shape` can bind `field`. */
export function bindableField(shape: WorkplaneShape, field: string): BindableFieldSpec | undefined {
  const found = SPEC_BY_FIELD.get(field);
  if (!found) return undefined;
  if (found.kinds && !found.kinds.includes(shape.kind)) return undefined;
  return meetsRequirement(shape, found.requires) ? found : undefined;
}

/** Lists the fields `shape` can bind, in catalog order. */
export function bindableFieldsFor(shape: WorkplaneShape): BindableFieldSpec[] {
  return EXPRESSION_BINDABLE_FIELDS.filter((entry) => bindableField(shape, entry.field) !== undefined);
}

/** Reads the number a binding drives, or undefined when the shape lacks it. */
export function boundFieldValue(shape: WorkplaneShape, field: string): number | undefined {
  const read = (value: unknown) => (typeof value === "number" ? value : undefined);
  if (field.startsWith("revolve.")) return read((shape.sketchRevolve as Record<string, unknown> | undefined)?.[field.slice(8)]);
  if (field === "faceDraft.angle") return read(shape.faceDraft?.angle);
  if (field === "edgeTreatments.0.amount") return read(shape.edgeTreatments?.[0]?.amount);
  if (field === "edgeTreatments.0.chamferAngle") return read(shape.edgeTreatments?.[0]?.chamferAngle ?? (shape.edgeTreatments?.[0]?.kind === "chamfer" ? 45 : undefined));
  return read((shape as unknown as Record<string, unknown>)[field]);
}

const REVOLVE_SETTINGS = ["startAngle", "sweepAngle", "sides", "quality", "pitch", "turns", "coreRadius"];

/** Maps change-request fields to the binding keys a literal value replaces. */
export function boundFieldsNamedBy(changes: Record<string, unknown>): string[] {
  const fields = new Set<string>();
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (key === "size") ["width", "depth", "height"].forEach((field) => fields.add(field));
    else if (key === "revolve" && value && typeof value === "object") {
      Object.keys(value).filter((name) => REVOLVE_SETTINGS.includes(name)).forEach((name) => fields.add(`revolve.${name}`));
    } else if (key === "faceDraft") fields.add("faceDraft.angle");
    else {
      if (SPEC_BY_FIELD.has(key)) fields.add(key);
      if (REVOLVE_SETTINGS.includes(key)) fields.add(`revolve.${key}`);
    }
  }
  return [...fields];
}

/** Drops shape-target bindings, whose placement and size stop meaning the same thing inside a group. */
export function withoutShapeBindings(shape: WorkplaneShape): WorkplaneShape {
  const fields = Object.keys(shape.expressions ?? {}).filter((field) => SPEC_BY_FIELD.get(field)?.target === "shape");
  return withoutBindings(shape, fields);
}

/** Returns `shape` without the named bindings, or `shape` itself when none were bound. */
export function withoutBindings(shape: WorkplaneShape, fields: readonly string[]): WorkplaneShape {
  if (!shape.expressions || !fields.some((field) => Object.hasOwn(shape.expressions!, field))) return shape;
  const expressions = Object.fromEntries(Object.entries(shape.expressions).filter(([field]) => !fields.includes(field)));
  const { expressions: _dropped, ...rest } = shape;
  return Object.keys(expressions).length ? { ...rest, expressions } : rest;
}

export type ShapeBindingErrorCode = "shapeNotFound" | "fieldNotBindable" | "invalidExpression" | "notAnInteger";

export type ShapeBindingError = {
  readonly code: ShapeBindingErrorCode;
  readonly message: string;
  readonly shapeId: string;
  readonly field: string;
  /** Set for `invalidExpression`. */
  readonly expressionError?: ExpressionError;
};

export type ShapeBindingResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: ShapeBindingError };

/** Builds an evaluation scope from resolved table values. */
export function parameterScope(parameters: readonly ProjectParameter[]): Map<string, ExpressionQuantity> {
  return new Map(parameters.map((parameter) => [parameter.name, { value: parameter.value, dimension: parameter.dimension }]));
}

function bindingFailure(code: ShapeBindingErrorCode, shapeId: string, field: string, message: string, expressionError?: ExpressionError) {
  return { ok: false as const, error: { code, shapeId, field, message, ...(expressionError ? { expressionError } : {}) } };
}

/** Evaluates `expression` for `field` on `shape`. A bare number takes the field's unit. Never throws. */
export function resolveShapeBinding(
  shape: WorkplaneShape,
  field: string,
  expression: string,
  parameters: readonly ProjectParameter[] | ReadonlyMap<string, ExpressionQuantity>,
): ShapeBindingResult {
  const found = bindableField(shape, field);
  if (!found) return bindingFailure("fieldNotBindable", shape.id, field, `Shape ${shape.id} has no bindable field "${field}".`);
  const scope = parameters instanceof Map ? parameters : parameterScope(parameters as readonly ProjectParameter[]);
  const result = evaluateExpression(expression, scope, found.dimension);
  if (!result.ok) {
    return bindingFailure("invalidExpression", shape.id, field, `${field}: ${result.error.message}`, result.error);
  }
  if (found.integer) {
    const rounded = Math.round(result.value);
    if (Math.abs(result.value - rounded) > 1e-9) {
      return bindingFailure("notAnInteger", shape.id, field, `${field} needs a whole number, got ${result.value}.`);
    }
    return { ok: true, value: rounded };
  }
  return { ok: true, value: result.value };
}

/** Visits active shapes pre-order, skipping treatment `before` snapshots. */
export function visitBoundShapes(
  shapes: readonly WorkplaneShape[],
  visit: (shape: WorkplaneShape, topLevel: boolean) => void,
) {
  const walk = (shape: WorkplaneShape, topLevel: boolean) => {
    if (!shape || typeof shape !== "object") return;
    visit(shape, topLevel);
    shape.groupedShapes?.forEach((child) => walk(child, false));
  };
  shapes.forEach((shape) => walk(shape, true));
}

export type ShapeBindingIssue = ShapeBindingError;

/** Lists bindings that do not resolve against `parameters`, or bind a field the shape lacks. Changes nothing. */
export function shapeBindingIssues(shapes: readonly WorkplaneShape[], parameters: readonly ProjectParameter[]): ShapeBindingIssue[] {
  const scope = parameterScope(parameters);
  const issues: ShapeBindingIssue[] = [];
  visitBoundShapes(shapes, (shape, topLevel) => {
    for (const [field, expression] of Object.entries(shape.expressions ?? {})) {
      const found = bindableField(shape, field);
      if (found && found.target === "shape" && !topLevel) {
        issues.push({ code: "fieldNotBindable", shapeId: shape.id, field, message: `${field} binds on top-level shapes only.` });
        continue;
      }
      const result = resolveShapeBinding(shape, field, expression, scope);
      if (!result.ok) issues.push(result.error);
    }
  });
  return issues;
}

export type ShapeBindingDependent = { readonly shapeId: string; readonly fields: readonly string[] };

/** Lists active shapes whose bindings reference `name` directly, in tree order. */
export function parameterShapeDependents(shapes: readonly WorkplaneShape[], name: string): ShapeBindingDependent[] {
  const dependents: ShapeBindingDependent[] = [];
  visitBoundShapes(shapes, (shape) => {
    const fields = Object.entries(shape.expressions ?? {})
      .filter(([, expression]) => expressionDependencies(expression).includes(name))
      .map(([field]) => field);
    if (fields.length) dependents.push({ shapeId: shape.id, fields });
  });
  return dependents;
}

/**
 * Rewrites `oldName` in every binding, including treatment `before` snapshots,
 * since reverting a treatment restores that snapshot. Keeps untouched shapes by reference.
 */
export function renameShapeBindingReferences(shapes: readonly WorkplaneShape[], oldName: string, newName: string): WorkplaneShape[] {
  const rename = (shape: WorkplaneShape): WorkplaneShape => {
    if (!shape || typeof shape !== "object") return shape;
    let next = shape;
    if (shape.expressions) {
      const expressions = Object.fromEntries(Object.entries(shape.expressions)
        .map(([field, expression]) => [field, typeof expression === "string" ? renameExpressionReference(expression, oldName, newName) : expression]));
      if (Object.entries(expressions).some(([field, expression]) => shape.expressions![field] !== expression)) next = { ...next, expressions };
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
