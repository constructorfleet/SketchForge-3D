/**
 * Binding validation (#681): the rules a new binding must pass before it is stored.
 *
 * Every bind path calls `validateBinding`, so a rule is added in one place. The issue
 * listers report stored bindings that break the same rules; those still load and recompute.
 */

import {
  bindableField,
  boundFieldValue,
  parameterScope,
  resolveShapeBinding,
  resolveShapeBindings,
  visitBoundShapes,
  withoutBindings,
  type ShapeBindingError,
  type ShapeBindingIssue,
} from "./expressionBindings.js";
import {
  boundSketchConstraints,
  resolveSketchConstraintBinding,
  visitSketches,
  type SketchConstraintBindingError,
  type SketchConstraintBindingIssue,
} from "./sketchConstraintBindings.js";
import { requestedBindingValue } from "./shapeRequestExpressions.js";
import type { ShapeRequest } from "./shapeRequests.js";
import type { ProjectParameter, SketchConstraint, WorkplaneShape } from "./domain/sketchforge.js";

/** A shape as found in the tree. `locked` names the shape or its nearest locked ancestor. */
export type BindingTarget = { readonly shape: WorkplaneShape; readonly topLevel: boolean; readonly locked?: string };

/**
 * `expression: null` clears. `constraint` is the profile's constraint with that ID, if any;
 * a draft's lives in the open profile. `clearedFields` are size bindings the same request clears.
 */
export type BindingChange =
  | { readonly field: string; readonly expression: string | null }
  | {
    readonly constraintId: string;
    readonly constraint: SketchConstraint | undefined;
    readonly expression: string | null;
    readonly clearedFields?: readonly string[];
  };

export type BindingRefusal =
  /** `topLevelId` is the top-level group holding a nested locked shape, which no request can unlock. */
  | { reason: "shape_locked"; ids: string[]; topLevelId?: string }
  | { reason: "binding_invalid"; error: ShapeBindingError }
  | { reason: "constraint_binding_invalid"; error: SketchConstraintBindingError };

export type BindingValidation =
  | { readonly ok: true; readonly value?: number }
  | { readonly ok: false; readonly failure: BindingRefusal };

export type BindingCheck = {
  readonly roots: readonly WorkplaneShape[];
  readonly target: BindingTarget;
  /** Resolves the expression and returns its value. Without it, only the tree rules run. */
  readonly parameters?: readonly ProjectParameter[];
  /** The request also sends `locked: false`, which lifts the target's own lock. */
  readonly unlocking?: boolean;
  /** An open, unsaved sketch: its lock and rebuild recipe are checked when it is committed. */
  readonly draft?: boolean;
};

/**
 * Refuses a bind its target cannot hold. Order: lock, placement, expression, conflicts
 * with bindings in the tree. Callers depend on this order. Only a lock refuses a clear.
 */
export function validateBinding(check: BindingCheck, change: BindingChange): BindingValidation {
  const { roots, target, parameters, draft } = check;
  const { shape } = target;
  if ("field" in change) {
    const { field, expression } = change;
    // A field bind never named the top-level group; kept for wire compatibility.
    if (target.locked && !draft) return refused({ reason: "shape_locked", ids: [target.locked] });
    if (expression === null) return { ok: true };
    if (bindableField(shape, field)?.target === "shape" && !target.topLevel) {
      return invalidField({ code: "fieldNotBindable", shapeId: shape.id, field, message: `${field} binds on top-level shapes only.` });
    }
    let value: number | undefined;
    if (parameters) {
      const resolved = resolveShapeBinding(shape, field, expression, parameters);
      if (!resolved.ok) return invalidField(resolved.error);
      value = resolved.value;
    }
    const conflict = profileFieldConflict(shape, field) ?? groupFieldConflict(roots, target, field);
    return conflict ? invalidField(conflict) : { ok: true, value };
  }
  const { constraintId, constraint, expression } = change;
  if (!draft) {
    const locked = lockRefusal(roots, target, check.unlocking ?? false);
    if (locked) return refused(locked);
    if (!constraint) {
      return invalidConstraint({ code: "constraintNotFound", shapeId: shape.id, constraintId, message: `The sketch on ${shape.id} has no constraint ${constraintId}.` });
    }
  }
  if (expression === null) return { ok: true };
  if (!draft && !rebuildableSketch(shape, target.topLevel)) return invalidConstraint(sketchNotRebuildable(shape.id, constraintId));
  let value: number | undefined;
  if (parameters && constraint) {
    const resolved = resolveSketchConstraintBinding(shape.id, constraint, expression, parameters);
    if (!resolved.ok) return invalidConstraint(resolved.error);
    value = resolved.value;
  }
  const conflict = constraintConflict(withoutBindings(shape, change.clearedFields ?? []), constraintId, boundAncestorSizeFields(roots, shape.id));
  return conflict ? invalidConstraint(conflict) : { ok: true, value };
}

/** Refuses a change to a locked shape. `unlocking` lifts only the shape's own lock. */
export function lockRefusal(
  roots: readonly WorkplaneShape[],
  found: { shape: WorkplaneShape; locked?: string } | undefined,
  unlocking: boolean,
): Extract<BindingRefusal, { reason: "shape_locked" }> | undefined {
  const locked = found?.locked;
  if (!locked || (locked === found.shape.id && unlocking)) return undefined;
  if (roots.some((root) => root.id === locked)) return { reason: "shape_locked", ids: [locked] };
  const topLevelId = roots.find((root) => holds(root, locked))?.id;
  return { reason: "shape_locked", ids: [locked], ...(topLevelId ? { topLevelId } : {}) };
}

/**
 * Reports whether a profile edit can rebuild `shape`. A nested output is reached only by its source ID,
 * and a shell cannot be replayed from the recipe. Other constraint bindings stay stale.
 */
export function rebuildableSketch(shape: WorkplaneShape, topLevel: boolean): boolean {
  return Boolean(shape.sketchProfile && shape.sketchOperation && !shape.shell && (shape.sketchSourceId || topLevel));
}

/**
 * Lists the size fields a sketch output's profile determines. Binding one rescales the
 * solved profile, so it conflicts with constraint bindings. Extrusion height is not in the profile.
 */
export function profileSizeFields(shape: WorkplaneShape): readonly string[] {
  if (!shape.sketchProfile) return [];
  return shape.sketchOperation === "extrude" ? ["width", "depth"] : ["width", "depth", "height"];
}

/** Lists profile size fields `request` sets to a literal other than the stored value: a resize of the solved sketch. */
export function resizedProfileFields(shape: WorkplaneShape, request: ShapeRequest): string[] {
  return profileSizeFields(shape).filter((field) => {
    const requested = requestedBindingValue(request, field);
    return requested !== undefined && requested !== boundFieldValue(shape, field);
  });
}

/** Lists bound size fields on a group. A refit around its children rewrites them. */
export function boundGroupSizeFields(shape: WorkplaneShape): string[] {
  if (!shape.groupedShapes?.length) return [];
  return GROUP_SIZE_FIELDS.filter((field) => typeof shape.expressions?.[field] === "string");
}

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
    // Nested constraint bindings are reported with the constraint issues.
    const nested = shape.groupedShapes?.length ? nestedRefitFields(shape) : [];
    if (!nested.length) return;
    for (const field of boundGroupSizeFields(shape)) {
      issues.push({
        code: "conflictingBinding",
        shapeId: shape.id,
        field,
        message: `${field} on ${shape.id} is bound, and ${nested.join(", ")} inside it rebuilds a child and refits the group. Clear one binding.`,
      });
    }
  });
  return issues;
}

/** Lists constraint bindings that do not resolve against `parameters`. Changes nothing. */
export function sketchConstraintBindingIssues(
  shapes: readonly WorkplaneShape[],
  parameters: readonly ProjectParameter[],
): SketchConstraintBindingIssue[] {
  const scope = parameterScope(parameters);
  const issues: SketchConstraintBindingIssue[] = [];
  const seen = new Set<string>();
  visitSketches(shapes, (shape, topLevel, ancestors) => {
    const groupSizes = [...new Set(ancestors.flatMap(boundGroupSizeFields))];
    for (const { constraint, expression } of boundSketchConstraints(shape)) {
      // A snapshot shares its owner's ID, so one binding is reported once.
      const key = JSON.stringify([shape.id, constraint.id, expression]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!rebuildableSketch(shape, topLevel)) {
        issues.push(sketchNotRebuildable(shape.id, constraint.id));
        continue;
      }
      const conflict = constraintConflict(shape, constraint.id, groupSizes);
      if (conflict) {
        issues.push(conflict);
        continue;
      }
      const result = resolveSketchConstraintBinding(shape.id, constraint, expression, scope);
      if (!result.ok) issues.push(result.error);
    }
  });
  return issues;
}

const GROUP_SIZE_FIELDS: readonly string[] = ["width", "depth", "height"];

const refused = (failure: BindingRefusal) => ({ ok: false as const, failure });
const invalidField = (error: ShapeBindingError) => refused({ reason: "binding_invalid", error });
const invalidConstraint = (error: SketchConstraintBindingError) => refused({ reason: "constraint_binding_invalid", error });

function holds(shape: WorkplaneShape, id: string): boolean {
  return shape.id === id || Boolean(shape.groupedShapes?.some((child) => holds(child, id)));
}

/** Reports whether a binding on a nested shape can rebuild it. Treatment amounts keep its bounds. */
function refitsParent(field: string): boolean {
  return !field.startsWith("edgeTreatments.");
}

/** Lists bound fields below `group` that rebuild a child, as `shapeId.field`. */
function nestedRefitFields(group: WorkplaneShape): string[] {
  const fields: string[] = [];
  const walk = (shape: WorkplaneShape) => {
    Object.keys(shape.expressions ?? {}).filter(refitsParent).forEach((field) => fields.push(`${shape.id}.${field}`));
    shape.groupedShapes?.forEach(walk);
  };
  group.groupedShapes?.forEach(walk);
  return fields;
}

/** Lists the constraint bindings below `group`. Each rebuilds a child, and so refits the group. */
function nestedConstraintBindings(group: WorkplaneShape): string[] {
  const constraintIds: string[] = [];
  const walk = (shape: WorkplaneShape) => {
    boundSketchConstraints(shape).forEach(({ constraint }) => constraintIds.push(constraint.id));
    shape.groupedShapes?.forEach(walk);
  };
  group.groupedShapes?.forEach(walk);
  return constraintIds;
}

/** Lists bound size fields on the groups that hold `shapeId`. */
function boundAncestorSizeFields(roots: readonly WorkplaneShape[], shapeId: string): string[] {
  const search = (shapes: readonly WorkplaneShape[], ancestors: readonly WorkplaneShape[]): readonly WorkplaneShape[] | undefined => {
    for (const shape of shapes) {
      if (shape.id === shapeId) return ancestors;
      const found = search(shape.groupedShapes ?? [], [...ancestors, shape]);
      if (found) return found;
    }
    return undefined;
  };
  return [...new Set((search(roots, []) ?? []).flatMap(boundGroupSizeFields))];
}

function sketchNotRebuildable(shapeId: string, constraintId: string): SketchConstraintBindingError {
  return { code: "sketchNotRebuildable", shapeId, constraintId, message: `The sketch on ${shapeId} has no rebuild recipe, so its constraints cannot bind.` };
}

/** Refuses a size field that would rescale a sketch whose constraints are bound. */
function profileFieldConflict(shape: WorkplaneShape, field: string): ShapeBindingError | undefined {
  if (!profileSizeFields(shape).includes(field)) return undefined;
  const constraintIds = boundSketchConstraints(shape).map(({ constraint }) => constraint.id);
  if (!constraintIds.length) return undefined;
  return {
    code: "conflictingBinding",
    shapeId: shape.id,
    field,
    constraintIds,
    message: `${field} cannot bind: it would rescale the sketch on ${shape.id}, whose ${constraintIds.join(", ")} is bound. Clear one binding first.`,
  };
}

/** Refuses a group size binding next to a nested binding that refits the group, either way round. */
function groupFieldConflict(roots: readonly WorkplaneShape[], target: BindingTarget, field: string): ShapeBindingError | undefined {
  const { shape } = target;
  if (shape.groupedShapes?.length && GROUP_SIZE_FIELDS.includes(field)) {
    const constraintIds = nestedConstraintBindings(shape);
    const fields = nestedRefitFields(shape);
    if (constraintIds.length || fields.length) {
      return {
        code: "conflictingBinding",
        shapeId: shape.id,
        field,
        ...(constraintIds.length ? { constraintIds } : {}),
        message: `${field} cannot bind: ${[...constraintIds, ...fields].join(", ")} inside ${shape.id} is bound, and its rebuild refits the group. Clear one binding first.`,
      };
    }
  }
  if (target.topLevel || !refitsParent(field)) return undefined;
  const sizes = boundAncestorSizeFields(roots, shape.id);
  if (!sizes.length) return undefined;
  return {
    code: "conflictingBinding",
    shapeId: shape.id,
    field,
    message: `${field} cannot bind: ${sizes.join(", ")} is bound on a group that holds ${shape.id}, and a rebuild would refit that group. Clear one binding first.`,
  };
}

/** Refuses a constraint binding beside a bound profile size, or inside a group whose size is bound. */
function constraintConflict(shape: WorkplaneShape, constraintId: string, groupSizes: readonly string[]): SketchConstraintBindingError | undefined {
  const fields = profileSizeFields(shape).filter((field) => typeof shape.expressions?.[field] === "string");
  if (fields.length) {
    return {
      code: "conflictingBinding",
      shapeId: shape.id,
      constraintId,
      fields,
      message: `${constraintId} cannot bind: ${fields.join(", ")} on ${shape.id} is bound and rescales the sketch. Clear one binding first.`,
    };
  }
  if (!groupSizes.length) return undefined;
  return {
    code: "conflictingBinding",
    shapeId: shape.id,
    constraintId,
    fields: groupSizes,
    message: `${constraintId} cannot bind: ${groupSizes.join(", ")} is bound on a group that holds ${shape.id}, and a re-solve would refit that group. Clear one binding first.`,
  };
}
