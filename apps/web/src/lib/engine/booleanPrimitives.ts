import { normalizeDegrees, shapeHasTaper } from "@/lib/engine/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

function straightAngle(value: number) {
  const angle = Math.abs(normalizeDegrees(value));
  return angle < 0.001 || Math.abs(angle - 180) < 0.001 || Math.abs(angle - 360) < 0.001;
}

/**
 * Whether a shape can stand in for an axis-aligned cuboid during a boolean.
 *
 * The fast boolean paths replace such a shape with a plain box built from its
 * width, depth and height -- cuboid arithmetic, or a Manifold cube primitive.
 * A tapered box is not a cuboid: its horizontal section changes with height, so
 * substituting one silently discards the taper from the result.
 */
export function isAxisAlignedBoxCutter(shape: WorkplaneShape) {
  return shape.kind === "box"
    && straightAngle(shape.rotation)
    && straightAngle(shape.rotationX ?? 0)
    && straightAngle(shape.rotationZ ?? 0)
    && !shapeHasTaper(shape);
}

/**
 * Whether a shape's silhouette is fully described by width/depth/height, so a
 * primitive solid can be built from those three numbers instead of meshing it.
 *
 * Taper is the exception every primitive builder here misses: cube, sphere,
 * cylinder and cone all take a single size per axis. A tapered shape has to go
 * the long way through its real mesh, which applies the taper per vertex.
 */
export function canUsePrimitiveSolid(shape: WorkplaneShape) {
  return !shapeHasTaper(shape);
}
