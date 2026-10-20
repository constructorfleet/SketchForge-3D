import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

/**
 * How far a hole's mesh is grown before it is subtracted.
 *
 * A cutter face that lands exactly on a solid's face is coplanar, which the CSG
 * evaluator resolves unpredictably -- it leaves slivers, or drops the face
 * entirely. Growing the cutter slightly moves those faces off each other.
 */
export const CUTTER_PADDING = 0.05;

/** Residual tolerance for deciding a point is inside a cutter after padding. */
export const CUTTER_RESIDUAL_INSET = CUTTER_PADDING * 0.4;

/** Grow an absolute profile dimension by the padding, leaving it undefined if it was. */
function padDimension(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? value : value + CUTTER_PADDING * 2;
}

/**
 * The shape to subtract for a hole: the hole grown by CUTTER_PADDING on every side.
 *
 * `width`, `depth` and `height` are the generic size, but several kinds carry
 * their own *absolute* profile dimensions -- a loft's independent top end, and
 * the taper rows on every other kind. Those must grow with the rest: padding
 * only the generic size changes the cutter's profile rather than offsetting it,
 * so the hole comes out the wrong shape and its unpadded end stays coplanar
 * with the solid it is cutting.
 *
 * The taper *scale* fields are relative, so they follow the padded size on
 * their own and are deliberately left alone.
 */
export function paddedCutterShape(shape: WorkplaneShape): WorkplaneShape {
  const width = shapeWidth(shape) + CUTTER_PADDING * 2;
  const depth = shapeDepth(shape) + CUTTER_PADDING * 2;
  const height = shape.height + CUTTER_PADDING * 2;
  return {
    ...shape,
    width,
    depth,
    height,
    size: Math.max(width, depth),
    elevation: (shape.elevation ?? 0) - CUTTER_PADDING,
    baseRadius: shape.baseRadius ? shape.baseRadius + CUTTER_PADDING : shape.baseRadius,
    loftTopWidth: padDimension(shape.loftTopWidth),
    loftTopDepth: padDimension(shape.loftTopDepth),
    taperTopWidth: padDimension(shape.taperTopWidth),
    taperTopDepth: padDimension(shape.taperTopDepth),
    taperBottomWidth: padDimension(shape.taperBottomWidth),
    taperBottomDepth: padDimension(shape.taperBottomDepth),
  };
}

/** Which boolean kernel a cutter is being built for. */
export type BooleanCutterKernel = "mesh" | "exact";

/**
 * The shape to subtract for a hole, for the kernel that will do the cutting.
 *
 * Only the mesh path needs the padding. An exact B-rep cut resolves a coplanar
 * face by construction rather than by luck, so growing the cutter there buys
 * nothing and costs accuracy: a pocket asked to stop flush with a face would
 * come out `CUTTER_PADDING` deeper than it was asked for, and a through hole
 * would come out `CUTTER_PADDING` wider all round.
 *
 * This is the one place that decides, so neither path can drift from the other.
 */
export function cutterShapeForBoolean(shape: WorkplaneShape, kernel: BooleanCutterKernel): WorkplaneShape {
  return kernel === "exact" ? shape : paddedCutterShape(shape);
}
