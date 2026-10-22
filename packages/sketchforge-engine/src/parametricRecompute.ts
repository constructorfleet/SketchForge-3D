import { buildGroupFromSelection } from "./serverShapeBooleans.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type RecomputeTreeResult =
  | { ok: true; shapes: WorkplaneShape[]; updated: WorkplaneShape; matchCount: number }
  | { ok: false; reason: "recompute_failed" | "dependency_missing" | "dependency_ambiguous"; message?: string };

/** Find a retained sketch output anywhere in the feature tree, replace it, then rebuild boolean ancestors bottom-up. */
export async function recomputeSketchOutput(
  roots: WorkplaneShape[],
  sourceId: string,
  replacement: WorkplaneShape,
): Promise<RecomputeTreeResult> {
  let matchCount = 0;
  let updated: WorkplaneShape | undefined;

  const visit = async (shape: WorkplaneShape): Promise<WorkplaneShape> => {
    if (shape.id === replacement.id && shape.sketchSourceId === sourceId) {
      matchCount += 1;
      updated = replacement;
      return replacement;
    }
    if (!shape.groupedShapes?.length) return shape;

    const children: WorkplaneShape[] = [];
    let changed = false;
    for (const child of shape.groupedShapes) {
      const next = await visit(child);
      children.push(next);
      changed ||= next !== child;
    }
    if (!changed) return shape;

    // Plain groups are containers; boolean groups have retained operand hole
    // modes and exact BREP. Rebuild those in dependency order after their child.
    if (!shape.cadBrep || !children.some((child) => child.hole)) {
      return { ...shape, groupedShapes: children };
    }
    const result = await buildGroupFromSelection(children);
    if ("error" in result || result.cutRemovedNothing) {
      throw new Error("The edited sketch made a dependent boolean invalid or ineffective.");
    }
    return {
      ...result.group,
      id: shape.id,
      name: shape.name,
      color: shape.color,
      locked: shape.locked,
      // `children` are expressed in this group's local coordinate system.
      // Rebuilding a new group from them produces a local origin; restore the
      // retained group's world placement on the rebuilt ancestor.
      x: result.group.x + shape.x,
      z: result.group.z + shape.z,
      elevation: (result.group.elevation ?? 0) + (shape.elevation ?? 0),
      rotation: shape.rotation,
      rotationX: shape.rotationX,
      rotationZ: shape.rotationZ,
      // The group builder creates fresh child IDs because ordinary grouping
      // is a new operation. Recompute is different: each retained child is the
      // same feature with new geometry, so keep its existing feature identity.
      groupedShapes: result.group.groupedShapes?.map((child, index) => ({
        ...child,
        id: children[index]?.id ?? child.id,
      })),
    };
  };

  try {
    const shapes = [] as WorkplaneShape[];
    for (const root of roots) shapes.push(await visit(root));
    if (matchCount === 0) return { ok: false, reason: "dependency_missing" };
    if (matchCount !== 1) return { ok: false, reason: "dependency_ambiguous" };
    return { ok: true, shapes, updated: updated!, matchCount };
  } catch (error) {
    return {
      ok: false,
      reason: "recompute_failed",
      message: error instanceof Error ? error.message : "A dependent feature could not be recomputed.",
    };
  }
}

export function findSketchOutput(roots: WorkplaneShape[], sourceId: string): WorkplaneShape[] {
  const matches: WorkplaneShape[] = [];
  const visit = (shape: WorkplaneShape) => {
    if (shape.sketchSourceId === sourceId) matches.push(shape);
    shape.groupedShapes?.forEach(visit);
  };
  roots.forEach(visit);
  return matches;
}
