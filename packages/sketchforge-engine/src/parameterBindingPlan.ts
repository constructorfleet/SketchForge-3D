/**
 * Plans which bindings a parameter table change moves, with no CAD work.
 *
 * `Engine.updateParameter` runs the plan; the editor's static build runs `applyKernelFreeBindings`,
 * which applies the same plan. Their refusals and resolved values cannot drift apart.
 */

import { rebuildableSketch } from "./bindingValidation.js";
import { bindableField, boundFieldValue, resolveShapeBindings, type ShapeBindingError } from "./expressionBindings.js";
import { expressionDependencies } from "./parameterExpressions.js";
import { REQUESTABLE_SHAPE_KINDS, shapeWithRequestedChanges } from "./shapeRequests.js";
import {
  boundSketchConstraints,
  resolveSketchConstraintBindings,
  sketchConstraintValue,
  withSketchConstraintValues,
  type SketchConstraintBindingError,
} from "./sketchConstraintBindings.js";
import { solveSketchConstraints } from "./sketchConstraints.js";
import type { ProjectParameter, SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";

/** One shape the change moves: resolved field values, and a solved profile when constraints moved. */
export type PendingParameterBinding = {
  id: string;
  topLevel: boolean;
  values: Record<string, number>;
  /** The shape itself, or the nearest locked ancestor. */
  locked: string | undefined;
  sketchProfile?: SketchProfile;
  constraintIds?: string[];
};

export type SketchUnsolvableFailure = { reason: "sketch_unsolvable"; shapeId: string; constraintIds: string[]; message: string };

export type ParameterBindingFailure =
  | { reason: "binding_invalid"; error: ShapeBindingError }
  | { reason: "constraint_binding_invalid"; error: SketchConstraintBindingError }
  | SketchUnsolvableFailure
  | { reason: "binding_failed"; shapeId: string; fields: string[]; constraintIds?: string[]; failure: { reason: "shape_locked"; ids: string[] } };

export type ParameterBindingPlan =
  | { ok: true; pending: PendingParameterBinding[] }
  | { ok: false; failure: ParameterBindingFailure };

/** Names whose value or dimension differs. `Object.is`, so an unresolved entry's NaN is not a change. */
export function changedParameterNames(previous: readonly ProjectParameter[], next: readonly ProjectParameter[]): Set<string> {
  const before = new Map(previous.map((parameter) => [parameter.name, parameter]));
  const after = new Map(next.map((parameter) => [parameter.name, parameter]));
  const changed = new Set<string>();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(name);
    const right = after.get(name);
    if (!left || !right || !Object.is(left.value, right.value) || left.dimension !== right.dimension) changed.add(name);
  }
  return changed;
}

/**
 * Sets resolved constraint values on `shape`'s profile and solves it. Refuses only constraints
 * the change breaks: the editor saves profiles with constraints it could not satisfy.
 */
export function solvedSketchProfile(
  shape: WorkplaneShape,
  values: Readonly<Record<string, number>>,
): { ok: true; profile: SketchProfile } | { ok: false; failure: SketchUnsolvableFailure } {
  const solved = solveSketchConstraints(withSketchConstraintValues(shape.sketchProfile!, values));
  if (!solved.unsatisfiedConstraintIds.length) return { ok: true, profile: solved.profile };
  const already = new Set(solveSketchConstraints(shape.sketchProfile!).unsatisfiedConstraintIds);
  const broken = solved.unsatisfiedConstraintIds.filter((id) => Object.hasOwn(values, id) || !already.has(id));
  if (broken.length) {
    return {
      ok: false,
      failure: {
        reason: "sketch_unsolvable",
        shapeId: shape.id,
        constraintIds: broken,
        message: `The sketch on ${shape.id} cannot satisfy ${broken.join(", ")} with the new values.`,
      },
    };
  }
  return { ok: true, profile: solved.profile };
}

/** Re-resolves bindings that depend on a changed parameter, children first, and refuses as the engine does. */
export function planParameterBindings(
  shapes: readonly WorkplaneShape[],
  previous: readonly ProjectParameter[],
  next: readonly ProjectParameter[],
): ParameterBindingPlan {
  const changed = changedParameterNames(previous, next);
  if (!changed.size) return { ok: true, pending: [] };
  const pending: PendingParameterBinding[] = [];
  let invalid: ShapeBindingError | undefined;
  let invalidConstraint: SketchConstraintBindingError | undefined;
  let unsolvable: SketchUnsolvableFailure | undefined;
  const visit = (shape: WorkplaneShape, topLevel: boolean, lockedAncestor: string | undefined) => {
    const locked = shape.locked ? shape.id : lockedAncestor;
    shape.groupedShapes?.forEach((child) => visit(child, false, locked));
    const values: Record<string, number> = {};
    const touches = (expression: string) => expressionDependencies(expression).some((name) => changed.has(name));
    const expressions = Object.entries(shape.expressions ?? {});
    if (!invalid && expressions.some(([, expression]) => touches(expression))) {
      // Every binding on a touched shape is rechecked, since one field's limit can depend on another's value.
      const after = resolveShapeBindings(shape, next);
      const before = resolveShapeBindings(shape, previous);
      for (const [field] of expressions) {
        // A misplaced shape binding stays stale, as on load.
        if (invalid || bindableField(shape, field)?.target === "shape" && !topLevel) continue;
        const resolved = after.get(field)!;
        if (resolved.ok) {
          if (boundFieldValue(shape, field) !== resolved.value) values[field] = resolved.value;
        } else if (before.get(field)!.ok) {
          // Refuses only a binding this change breaks; one already stale stays stale.
          invalid = resolved.error;
        }
      }
    }
    const constraintValues: Record<string, number> = {};
    // A binding on a sketch no edit can rebuild stays stale, as on load.
    const bound = rebuildableSketch(shape, topLevel) ? boundSketchConstraints(shape) : [];
    if (!invalidConstraint && bound.some(({ expression }) => touches(expression))) {
      // As for shapes, every binding on a touched sketch is rechecked against the whole change.
      const after = resolveSketchConstraintBindings(shape, next);
      const before = resolveSketchConstraintBindings(shape, previous);
      for (const { constraint } of bound) {
        if (invalidConstraint) break;
        const resolved = after.get(constraint.id)!;
        if (resolved.ok) {
          if (sketchConstraintValue(constraint) !== resolved.value) constraintValues[constraint.id] = resolved.value;
        } else if (before.get(constraint.id)!.ok) {
          invalidConstraint = resolved.error;
        }
      }
    }
    const constraintIds = Object.keys(constraintValues);
    let sketchProfile: SketchProfile | undefined;
    if (constraintIds.length && !unsolvable) {
      // Solved before any rebuild, so an unsolvable sketch costs no CAD work.
      const solved = solvedSketchProfile(shape, constraintValues);
      if (solved.ok) sketchProfile = solved.profile;
      else unsolvable = solved.failure;
    }
    if (Object.keys(values).length || sketchProfile) {
      pending.push({ id: shape.id, topLevel, values, locked, ...(sketchProfile ? { sketchProfile, constraintIds } : {}) });
    }
  };
  shapes.forEach((shape) => visit(shape, true, undefined));
  if (invalid) return { ok: false, failure: { reason: "binding_invalid", error: invalid } };
  if (invalidConstraint) return { ok: false, failure: { reason: "constraint_binding_invalid", error: invalidConstraint } };
  if (unsolvable) return { ok: false, failure: unsolvable };
  // A change that would alter a locked shape, or rebuild a locked group around one, is refused as a manual edit is.
  const blocked = pending.find((entry) => entry.locked);
  if (blocked) {
    return {
      ok: false,
      failure: {
        reason: "binding_failed",
        shapeId: blocked.id,
        fields: Object.keys(blocked.values),
        ...(blocked.constraintIds ? { constraintIds: blocked.constraintIds } : {}),
        failure: { reason: "shape_locked", ids: [blocked.locked!] },
      },
    };
  }
  return { ok: true, pending };
}

// Any of these means the shape's geometry comes from more than its own fields.
const KERNEL_FIELDS = [
  "importedMesh", "imagePlate", "sketchProfile", "sketchSourceId", "sketchRevolve", "draftPrismAngle", "faceDraft",
  "edgeTreatments", "edgeTreatmentHistory", "shell", "cadBrep", "cadDisplayEdges", "groupedShapes", "stepAssembly", "stepComponent",
  // A size change on these re-matches faces through the kernel.
  "faceIds", "faceColors",
] as const;

/** Reports whether a shape's geometry follows from its own fields alone, with no kernel work. */
export function plainPrimitive(shape: WorkplaneShape): boolean {
  return (REQUESTABLE_SHAPE_KINDS as readonly string[]).includes(shape.kind)
    && KERNEL_FIELDS.every((field) => shape[field] === undefined);
}

export type KernelFreeBindingFailure =
  | ParameterBindingFailure
  | {
    reason: "binding_failed";
    shapeId: string;
    fields: string[];
    failure: { reason: "unapplicable_fields"; kind: WorkplaneShape["kind"]; fields: string[]; because: "not_this_kind" };
  };

export type KernelFreeBindingResult =
  | { ok: true; shapes: WorkplaneShape[] }
  | { ok: false; failure: KernelFreeBindingFailure };

/**
 * Plans a table change and applies it with no kernel, when every shape it moves is a plain
 * top-level primitive. Refuses as the engine does. Null when kernel work is needed.
 */
export function applyKernelFreeBindings(
  shapes: readonly WorkplaneShape[],
  previous: readonly ProjectParameter[],
  next: readonly ProjectParameter[],
): KernelFreeBindingResult | null {
  const plan = planParameterBindings(shapes, previous, next);
  if (!plan.ok) return { ok: false, failure: plan.failure };
  let result = [...shapes];
  for (const entry of plan.pending) {
    const shape = result.find((candidate) => candidate.id === entry.id);
    if (!entry.topLevel || !shape || entry.sketchProfile || !plainPrimitive(shape)) return null;
    const fields = Object.keys(entry.values);
    if (fields.some((field) => bindableField(shape, field)?.target !== "shape")) return null;
    // The engine's own-field step for a plain primitive, refused the same way.
    const changed = shapeWithRequestedChanges(shape, entry.values);
    if (!changed.ok) {
      return {
        ok: false,
        failure: {
          reason: "binding_failed",
          shapeId: entry.id,
          fields,
          failure: { reason: "unapplicable_fields", kind: shape.kind, fields: changed.unapplicable, because: "not_this_kind" },
        },
      };
    }
    result = result.map((candidate) => (candidate.id === entry.id ? changed.shape : candidate));
  }
  return { ok: true, shapes: result };
}
