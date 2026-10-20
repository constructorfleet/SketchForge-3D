/**
 * The box a shape occupies, from its parameters alone.
 *
 * Align, distribute and pattern are all arithmetic on extents, and all three
 * need the extents without a renderer. The editor measures them off the mesh
 * (`meshAabb`), which is more faithful and needs `three`, a tessellation and --
 * for an imported model -- the triangles themselves; headless there is nothing
 * to mesh, and the parameters say the same thing for everything built from
 * them. An imported mesh carries its own measured size in `width`, `depth` and
 * `height`, so it is right for those too.
 *
 * Where the two differ is rotation: a box turned 45 degrees sweeps a wider
 * footprint than its own width, and this reports the width. The editor's own
 * fallback (`shapeAabb`, used when a mesh has no vertices) makes the same
 * simplification, and an alignment measured on the unrotated footprint is at
 * least the one a caller can predict from the numbers it sent.
 */

import { shapeDepth, shapeWidth } from "@/lib/engine/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export type ShapeBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

/** The axis-aligned box a shape occupies, centred on `x`/`z` and seated on its elevation. */
export function shapeBounds(shape: WorkplaneShape): ShapeBounds {
  const halfWidth = shapeWidth(shape) / 2;
  const halfDepth = shapeDepth(shape) / 2;
  const elevation = shape.elevation ?? 0;
  return {
    minX: shape.x - halfWidth,
    maxX: shape.x + halfWidth,
    minY: elevation,
    maxY: elevation + shape.height,
    minZ: shape.z - halfDepth,
    maxZ: shape.z + halfDepth,
  };
}

/** The box around several shapes, or null when there are none to bound. */
export function boundsForShapes(shapes: readonly WorkplaneShape[]): ShapeBounds | null {
  if (shapes.length === 0) return null;
  const boxes = shapes.map(shapeBounds);
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxY: Math.max(...boxes.map((box) => box.maxY)),
    minZ: Math.min(...boxes.map((box) => box.minZ)),
    maxZ: Math.max(...boxes.map((box) => box.maxZ)),
  };
}

/** The centre of a box on the workplane, which is where a circular pattern turns about. */
export function footprintCenter(bounds: ShapeBounds) {
  return { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
}
