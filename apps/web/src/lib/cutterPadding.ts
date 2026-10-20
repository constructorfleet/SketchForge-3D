/**
 * Every allowance this app adds to a hole, and the one rule each obeys.
 *
 * There are three, for one problem, and they used to be spread over two files
 * with no stated relationship -- so this is the whole table:
 *
 * | What                       | Grows a cutter by | Who asks for it                  |
 * |----------------------------|-------------------|----------------------------------|
 * | `CUTTER_PADDING`           | 0.05 mm per side  | the mesh cut, now the fallback   |
 * | `CUTTER_RESIDUAL_INSET`    | (a tolerance)     | the inside-test, after padding   |
 * | `CUT_PREVIEW_SEPARATION`   | 0.01 mm per side  | the live preview's own evaluator |
 * | nothing                    | 0                 | the exact cut, which commits     |
 *
 * `cutterShapeForBoolean` is the one place that picks between them.
 */

import { shapeDepth, shapeOverallFootprintDimensions, shapeTaperDimensions, shapeHasTaper, shapeWidth } from "@/lib/workplaneShapes";
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

/**
 * How far the live cut preview separates its cutter from the solid it highlights.
 *
 * Not an allowance on the cut: the preview highlights the hole as drawn, which
 * is what the exact cut now removes. This is a separation the preview's *own*
 * mesh evaluator needs, and it is not optional. Measured on a 40x40x10 plate
 * with a 12 mm blind pocket whose top cap is coplanar with the plate's top
 * face, `HOLLOW_INTERSECTION` returns 179 triangles in 11.6 ms with this
 * separation and had not returned after four minutes with none.
 *
 * A fifth of `CUTTER_PADDING`, and five thousandths of the smallest hole anyone
 * draws, so the highlight is within a pixel of the truth at any usable zoom.
 */
export const CUT_PREVIEW_SEPARATION = 0.01;

/** Below this a dimension is treated as degenerate rather than divided by. */
const MIN_CUTTER_DIMENSION = 0.01;

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

/** Which boolean kernel, or the live preview, a cutter is being built for. */
export type BooleanCutterKernel = "mesh" | "exact" | "preview";

/**
 * The shape to subtract for a hole, for the kernel that will do the cutting.
 *
 * Only the mesh path needs the padding. An exact B-rep cut resolves a coplanar
 * face by construction rather than by luck, so growing the cutter there buys
 * nothing and costs accuracy: a pocket asked to stop flush with a face would
 * come out `CUTTER_PADDING` deeper than it was asked for, and a through hole
 * would come out `CUTTER_PADDING` wider all round.
 *
 * The preview asks for the hole as drawn too, deliberately. It could instead
 * mirror whichever backend is about to run and show the mesh path's 0.05 mm
 * where that one will serve -- but a user cannot see which backend ran, and the
 * overcut is a defect of the fallback rather than anything they asked for. So
 * the highlight shows the hole that was drawn, which is also what the exact cut
 * removes; `cutPreviewCutterScale` then adds the separation its evaluator needs
 * on top, and nothing else.
 *
 * This is the one place that decides, so no two paths can drift apart.
 */
export function cutterShapeForBoolean(shape: WorkplaneShape, kernel: BooleanCutterKernel): WorkplaneShape {
  return kernel === "mesh" ? paddedCutterShape(shape) : shape;
}

/**
 * How far the preview grows its cutter at the cutter's widest section, per side.
 *
 * `CUT_PREVIEW_SEPARATION` for anything straight-sided, which is almost every
 * hole. A taper needs more, and the reason is the one thing a scale cannot do:
 * the preview grows the hole by scaling its rendered mesh, and a scale grows a
 * narrow section by less than a wide one. A cutter tapering from 20 mm down to
 * 2 mm, scaled to clear 0.01 mm at its mouth, clears a tenth of that at its
 * tip -- and the measurement above says what too little separation costs, which
 * is a UI that stops responding for minutes rather than a slightly wrong
 * highlight. So the growth is scaled up by the taper's own ratio, which leaves
 * the narrowest section clearing exactly the separation and the widest
 * over-grown by the same ratio.
 *
 * Capped at `CUTTER_PADDING`, because a cutter may taper almost to nothing and
 * the uncapped ratio would then grow the mouth without bound. 0.05 mm is the
 * allowance this app already treats as geometrically acceptable on a cut, so it
 * is the natural ceiling for a highlight.
 */
export function cutPreviewCutterGrowth(shape: WorkplaneShape) {
  if (!shapeHasTaper(shape)) {
    return CUT_PREVIEW_SEPARATION;
  }

  const taper = shapeTaperDimensions(shape);
  const footprint = shapeOverallFootprintDimensions(shape);
  const narrowest = Math.min(taper.topWidth, taper.bottomWidth, taper.topDepth, taper.bottomDepth);
  const widest = Math.max(footprint.width, footprint.depth);
  if (narrowest < MIN_CUTTER_DIMENSION || widest < MIN_CUTTER_DIMENSION) {
    return CUT_PREVIEW_SEPARATION;
  }
  return Math.min(CUTTER_PADDING, CUT_PREVIEW_SEPARATION * Math.max(1, widest / narrowest));
}

/** Multiply an absolute profile dimension, leaving it undefined if it was. */
function scaleDimension(value: number | undefined, factor: number) {
  return value === undefined || !Number.isFinite(value) ? value : value * factor;
}

/**
 * The cutter the preview highlights with: the hole as drawn, grown by the
 * separation its evaluator needs.
 *
 * Expressed as a shape rather than a matrix because the growth is a *scale*,
 * not an offset. The preview works on the hole's rendered mesh, and scaling a
 * mesh about the shape's own origin is the same thing as scaling the dimensions
 * that mesh was generated from -- every kind's builder takes width, depth,
 * height and its taper rows, so multiplying those reproduces it exactly. The
 * taper *scale* rows are ratios and follow the size on their own.
 *
 * Measured against the widest section rather than `width`/`depth`, since those
 * are the taper's *reference* size and can be neither of its ends: a cutter
 * flaring to twice its nominal width would otherwise be grown by twice the
 * intended amount.
 *
 * Growing about the hole's middle is what keeps the highlight where the hole
 * is: the shape object the viewport scales is positioned at the shape's centre,
 * and the elevation drops by half the height's growth to match.
 */
export function cutPreviewCutterShape(shape: WorkplaneShape): WorkplaneShape {
  const growth = cutPreviewCutterGrowth(shape);
  const footprint = shapeOverallFootprintDimensions(shape);
  const factor = (size: number) => {
    const base = Math.max(MIN_CUTTER_DIMENSION, size);
    return (base + growth * 2) / base;
  };
  const widthFactor = factor(footprint.width);
  const depthFactor = factor(footprint.depth);
  const heightFactor = factor(shape.height);
  const width = shapeWidth(shape) * widthFactor;
  const depth = shapeDepth(shape) * depthFactor;
  const height = shape.height * heightFactor;
  return {
    ...shape,
    width,
    depth,
    height,
    size: Math.max(width, depth),
    elevation: (shape.elevation ?? 0) - (height - shape.height) / 2,
    baseRadius: scaleDimension(shape.baseRadius, widthFactor),
    topRadius: scaleDimension(shape.topRadius, widthFactor),
    loftTopWidth: scaleDimension(shape.loftTopWidth, widthFactor),
    loftTopDepth: scaleDimension(shape.loftTopDepth, depthFactor),
    taperTopWidth: scaleDimension(shape.taperTopWidth, widthFactor),
    taperTopDepth: scaleDimension(shape.taperTopDepth, depthFactor),
    taperBottomWidth: scaleDimension(shape.taperBottomWidth, widthFactor),
    taperBottomDepth: scaleDimension(shape.taperBottomDepth, depthFactor),
  };
}

/**
 * The same growth as the matrix scale the viewport applies to the hole's brush.
 *
 * Derived from `cutPreviewCutterShape` rather than recomputed, so the shape the
 * tests measure and the matrix the viewport uses cannot come apart.
 */
export function cutPreviewCutterScale(shape: WorkplaneShape) {
  const grown = cutPreviewCutterShape(shape);
  const before = shapeOverallFootprintDimensions(shape);
  const after = shapeOverallFootprintDimensions(grown);
  const ratio = (to: number, from: number) => (from < MIN_CUTTER_DIMENSION ? 1 : to / from);
  return {
    x: ratio(after.width, before.width),
    y: ratio(grown.height, shape.height),
    z: ratio(after.depth, before.depth),
  };
}
