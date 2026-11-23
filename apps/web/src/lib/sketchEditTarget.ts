import type { WorkplaneShape } from "@/types/sketchforge";

export type SketchEditRefusal = "selectToEdit" | "locked";

/** Returns why the selection cannot reopen its sketch, or null when it can. */
export function sketchEditRefusal(selection: readonly WorkplaneShape[]): SketchEditRefusal | null {
  const [shape] = selection;
  if (selection.length !== 1 || !shape?.sketchProfile) return "selectToEdit";
  // Selection reaches only top-level shapes, so the shape's own lock is its nearest one.
  return shape.locked ? "locked" : null;
}

/** Reports whether the shape a sketch edit would replace is locked in `shapes`. */
export function sketchEditTargetLocked(shapes: readonly WorkplaneShape[], editingId: string | null): boolean {
  return editingId !== null && Boolean(shapes.find((shape) => shape.id === editingId)?.locked);
}
