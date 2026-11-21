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
import { MAX_GEAR_HELIX_ANGLE, MAX_GEAR_TEETH, MIN_GEAR_HELIX_ANGLE, MIN_GEAR_TEETH } from "./gearProfile.js";
import { MAX_LOFT_LAYERS, MAX_LOFT_SEGMENTS, MIN_LOFT_LAYERS, MIN_LOFT_SEGMENTS } from "./loftProfile.js";
import {
  MAX_REQUESTED_DIMENSION,
  MIN_REQUESTED_DIMENSION,
  SHAPE_PARAMETERS,
  shapeWithRequestedChanges,
  type ShapeParameterName,
} from "./shapeRequests.js";
import { MAX_REVOLVE_PITCH, MAX_REVOLVE_TURNS, normalizeSketchRevolveSettings } from "./sketchRevolve.js";
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
  /** Static bounds. Fields bounded by the shape itself, such as a gear's tooth size, have none. */
  readonly min?: number;
  readonly max?: number;
  /** `min` and `max` are excluded, and so is 0 for drafts. */
  readonly exclusive?: true;
  /** Accepts any angle and stores it normalized to [0, 360). */
  readonly periodic?: true;
};

const ALL_SHAPE_KINDS: readonly ShapeKind[] = [
  "box", "cylinder", "sphere", "sketch", "scribble", "cone", "pyramid", "roof", "text", "roundRoof",
  "halfSphere", "torus", "tube", "gear", "ring", "wedge", "polygon", "icosahedron", "mesh", "loft",
];

const SIZE = { min: MIN_REQUESTED_DIMENSION, max: MAX_REQUESTED_DIMENSION };
const COUNT = { integer: true as const };
const TURN = { periodic: true as const };

const NUMERIC_SHAPE_PARAMETERS: ReadonlyArray<readonly [ShapeParameterName, ProjectParameterDimension, Partial<BindableFieldSpec>]> = [
  ["steps", "unitless", { ...COUNT, min: 4 }], ["sides", "unitless", { ...COUNT, min: 3 }], ["bevel", "length", {}],
  ["segments", "unitless", { ...COUNT, min: 1 }],
  ["topRadius", "length", { min: 0 }], ["baseRadius", "length", { min: MIN_REQUESTED_DIMENSION }],
  ["taperTopWidth", "length", SIZE], ["taperTopDepth", "length", SIZE],
  ["taperBottomWidth", "length", SIZE], ["taperBottomDepth", "length", SIZE],
  ["teeth", "unitless", { ...COUNT, min: MIN_GEAR_TEETH, max: MAX_GEAR_TEETH }], ["toothSize", "length", {}], ["toothWidth", "length", {}],
  ["centerHoleSize", "length", {}], ["helixAngle", "angle", { min: MIN_GEAR_HELIX_ANGLE, max: MAX_GEAR_HELIX_ANGLE }],
  ["loftTopWidth", "length", { min: 0.01 }], ["loftTopDepth", "length", { min: 0.01 }],
  ["loftBottomRotation", "angle", TURN], ["loftTopRotation", "angle", TURN],
  ["loftSegments", "unitless", { ...COUNT, min: MIN_LOFT_SEGMENTS, max: MAX_LOFT_SEGMENTS }],
  ["loftLayers", "unitless", { ...COUNT, min: MIN_LOFT_LAYERS, max: MAX_LOFT_LAYERS }],
];

function spec(field: string, dimension: ProjectParameterDimension, extra: Partial<BindableFieldSpec> = {}): BindableFieldSpec {
  return Object.freeze({ field, dimension, target: "shape" as const, ...extra });
}

/** Lists every bindable numeric field with its dimension. REST, MCP, clients and the editor share it. */
export const EXPRESSION_BINDABLE_FIELDS: readonly BindableFieldSpec[] = Object.freeze([
  ...(["x", "z", "elevation"] as const).map((field) => spec(field, "length")),
  ...(["width", "depth", "height"] as const).map((field) => spec(field, "length", SIZE)),
  ...(["rotation", "rotationX", "rotationZ"] as const).map((field) => spec(field, "angle", TURN)),
  ...NUMERIC_SHAPE_PARAMETERS.map(([field, dimension, extra]) => spec(field, dimension, {
    ...extra,
    kinds: Object.freeze(ALL_SHAPE_KINDS.filter((kind) => SHAPE_PARAMETERS[field].appliesTo(kind))),
  })),
  spec("revolve.startAngle", "angle", { target: "feature", requires: "revolve", ...TURN }),
  spec("revolve.sweepAngle", "angle", { target: "feature", requires: "revolve", min: -360, max: 360 }),
  spec("revolve.sides", "unitless", { target: "feature", requires: "revolve", ...COUNT, min: 3 }),
  spec("revolve.quality", "unitless", { target: "feature", requires: "revolve", ...COUNT, min: 1, max: 10 }),
  spec("revolve.pitch", "length", { target: "feature", requires: "revolve", min: -MAX_REVOLVE_PITCH, max: MAX_REVOLVE_PITCH }),
  spec("revolve.turns", "unitless", { target: "feature", requires: "revolve", min: 0.1, max: MAX_REVOLVE_TURNS }),
  spec("revolve.coreRadius", "length", { target: "feature", requires: "revolve", min: 0 }),
  spec("draftPrismAngle", "angle", { target: "feature", requires: "draftPrism", min: -45, max: 45, exclusive: true }),
  spec("faceDraft.angle", "angle", { target: "feature", requires: "faceDraft", min: -45, max: 45, exclusive: true }),
  spec("edgeTreatments.0.amount", "length", { target: "feature", requires: "sketchEdgeTreatment", min: 0, exclusive: true }),
  spec("edgeTreatments.0.chamferAngle", "angle", { target: "feature", requires: "sketchChamfer", min: 0, max: 90, exclusive: true }),
]);

const SPEC_BY_FIELD = new Map(EXPRESSION_BINDABLE_FIELDS.map((entry) => [entry.field, entry]));

/** Treatment amounts replay only through a sketch recipe rebuild, which plain solids and shells lack. */
function hasSketchRecipe(shape: WorkplaneShape) {
  return Boolean(shape.sketchSourceId && shape.sketchProfile && shape.sketchOperation && !shape.shell);
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

export type ShapeBindingErrorCode = "shapeNotFound" | "fieldNotBindable" | "invalidExpression" | "notAnInteger" | "outOfRange";

export type ShapeBindingError = {
  readonly code: ShapeBindingErrorCode;
  readonly message: string;
  readonly shapeId: string;
  readonly field: string;
  /** Set for `invalidExpression`. */
  readonly expressionError?: ExpressionError;
  /** Set for `outOfRange`: the resolved value, the field's static bounds, and what the field would store. */
  readonly value?: number;
  readonly min?: number;
  readonly max?: number;
  readonly stored?: number;
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

function insideBounds(found: BindableFieldSpec, value: number) {
  if (found.exclusive) {
    if ((found.requires === "draftPrism" || found.requires === "faceDraft") && value === 0) return false;
    return (found.min === undefined || value > found.min) && (found.max === undefined || value < found.max);
  }
  return (found.min === undefined || value >= found.min) && (found.max === undefined || value <= found.max);
}

/**
 * Returns what the shape would store for each value when all are applied in one change,
 * via the normalizers a manual edit uses. Dependent limits, such as a gear's tooth size
 * against its width, are read against the shape as the change leaves it. NaN means refused.
 */
export function storedBindingValues(shape: WorkplaneShape, values: Readonly<Record<string, number>>): Record<string, number> {
  const stored: Record<string, number> = {};
  const own: Record<string, number> = {};
  const revolve: Record<string, number> = {};
  for (const [field, value] of Object.entries(values)) {
    const found = bindableField(shape, field);
    if (!found || (!found.periodic && !insideBounds(found, value))) stored[field] = Number.NaN;
    else if (field.startsWith("revolve.")) revolve[field.slice("revolve.".length)] = value;
    else if (found.target === "feature") stored[field] = value;
    else own[field] = value;
  }
  if (Object.keys(revolve).length) {
    const settings = normalizeSketchRevolveSettings({ ...shape.sketchRevolve, ...revolve }) as unknown as Record<string, number>;
    for (const name of Object.keys(revolve)) stored[`revolve.${name}`] = settings[name]!;
  }
  if (Object.keys(own).length) {
    const changed = shapeWithRequestedChanges(shape, own);
    for (const field of Object.keys(own)) {
      stored[field] = changed.ok ? boundFieldValue(changed.shape, field) ?? Number.NaN : Number.NaN;
    }
  }
  return stored;
}

/** Returns what the shape would store for `value` on its own. NaN means refused. */
export function storedBindingValue(shape: WorkplaneShape, field: string, value: number): number {
  return storedBindingValues(shape, { [field]: value })[field] ?? Number.NaN;
}

function evaluateBinding(
  shape: WorkplaneShape,
  field: string,
  expression: string,
  scope: ReadonlyMap<string, ExpressionQuantity>,
): ShapeBindingResult {
  const found = bindableField(shape, field);
  if (!found) return bindingFailure("fieldNotBindable", shape.id, field, `Shape ${shape.id} has no bindable field "${field}".`);
  const result = evaluateExpression(expression, scope, found.dimension);
  if (!result.ok) {
    return bindingFailure("invalidExpression", shape.id, field, `${field}: ${result.error.message}`, result.error);
  }
  if (!found.integer) return { ok: true, value: result.value };
  const rounded = Math.round(result.value);
  if (Math.abs(result.value - rounded) > 1e-9) {
    return bindingFailure("notAnInteger", shape.id, field, `${field} needs a whole number, got ${result.value}.`);
  }
  return { ok: true, value: rounded };
}

function checkedRange(shape: WorkplaneShape, field: string, value: number, stored: number): ShapeBindingResult {
  const found = bindableField(shape, field)!;
  if (found.periodic && Number.isFinite(stored)) return { ok: true, value: stored };
  // Refused, not clamped: a clamped binding would differ from its expression forever.
  if (Number.isFinite(stored) && Math.abs(stored - value) <= 1e-9 * Math.max(1, Math.abs(value))) return { ok: true, value };
  const bounds = found.min !== undefined || found.max !== undefined
    ? ` It must be ${found.exclusive ? "strictly " : ""}between ${found.min ?? "-∞"} and ${found.max ?? "∞"}.`
    : Number.isFinite(stored) ? ` The shape would store ${stored}.` : "";
  return {
    ok: false,
    error: {
      code: "outOfRange", shapeId: shape.id, field, value,
      message: `${field} cannot be ${value}.${bounds}`,
      ...(found.min !== undefined ? { min: found.min } : {}),
      ...(found.max !== undefined ? { max: found.max } : {}),
      ...(Number.isFinite(stored) ? { stored } : {}),
    },
  };
}

/**
 * Resolves every binding on `shape`, plus `overrides`, as one change, so each is range-checked
 * against the others' new values. Never throws.
 */
export function resolveShapeBindings(
  shape: WorkplaneShape,
  parameters: readonly ProjectParameter[] | ReadonlyMap<string, ExpressionQuantity>,
  overrides: Readonly<Record<string, string>> = {},
): Map<string, ShapeBindingResult> {
  const scope = parameters instanceof Map ? parameters : parameterScope(parameters as readonly ProjectParameter[]);
  const evaluated = new Map(Object.entries({ ...shape.expressions, ...overrides })
    .filter(([, expression]) => typeof expression === "string")
    .map(([field, expression]) => [field, evaluateBinding(shape, field, expression, scope)]));
  const values = Object.fromEntries([...evaluated].flatMap(([field, result]) => (result.ok ? [[field, result.value]] : [])));
  const stored = storedBindingValues(shape, values);
  return new Map([...evaluated].map(([field, result]) => [field, result.ok ? checkedRange(shape, field, result.value, stored[field]!) : result]));
}

/** Evaluates `expression` for `field` on `shape`, together with its other bindings. A bare number takes the field's unit. */
export function resolveShapeBinding(
  shape: WorkplaneShape,
  field: string,
  expression: string,
  parameters: readonly ProjectParameter[] | ReadonlyMap<string, ExpressionQuantity>,
): ShapeBindingResult {
  return resolveShapeBindings(shape, parameters, { [field]: expression }).get(field)!;
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
    if (!shape.expressions) return;
    const results = resolveShapeBindings(shape, scope);
    for (const field of Object.keys(shape.expressions)) {
      const found = bindableField(shape, field);
      if (found && found.target === "shape" && !topLevel) {
        issues.push({ code: "fieldNotBindable", shapeId: shape.id, field, message: `${field} binds on top-level shapes only.` });
        continue;
      }
      const result = results.get(field);
      if (result && !result.ok) issues.push(result.error);
    }
  });
  return issues;
}

export type ShapeBindingDependent = { readonly shapeId: string; readonly fields: readonly string[] };

/**
 * Lists shapes whose bindings reference `name` directly, in tree order. Includes treatment
 * `before` snapshots, the set `renameShapeBindingReferences` rewrites, merged by shape ID.
 */
export function parameterShapeDependents(shapes: readonly WorkplaneShape[], name: string): ShapeBindingDependent[] {
  const fieldsById = new Map<string, Set<string>>();
  const visit = (shape: WorkplaneShape) => {
    if (!shape || typeof shape !== "object") return;
    for (const [field, expression] of Object.entries(shape.expressions ?? {})) {
      if (!expressionDependencies(expression).includes(name)) continue;
      const fields = fieldsById.get(shape.id) ?? new Set<string>();
      fields.add(field);
      fieldsById.set(shape.id, fields);
    }
    shape.groupedShapes?.forEach(visit);
    shape.edgeTreatmentHistory?.forEach((entry) => visit(entry.before));
  };
  shapes.forEach(visit);
  return [...fieldsById].map(([shapeId, fields]) => ({ shapeId, fields: [...fields] }));
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
