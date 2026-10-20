import { shapeDepth, shapeHasTaper, shapeTaperDimensions, shapeWidth } from "@/lib/engine/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export type ProfilePoint = [number, number, number];

/**
 * Facet count at or above which a cylinder is exported as a true round
 * cylinder rather than a prism.
 *
 * The editor always builds a cylinder as a prism of `sides` facets; 96 is the
 * default, where the facets are invisible and "round" is what the user means.
 * Choosing fewer is a deliberate design decision -- a hex bar, an octagonal
 * post -- and the export has to honour it, because a STEP file that silently
 * rounds off the flats is wrong in a way only discovered downstream.
 */
export const ROUND_CYLINDER_SIDES = 96;

/** A cylinder the user has deliberately faceted, so it must export as a prism. */
export function isFacetedCylinder(shape: WorkplaneShape) {
  if (shape.kind !== "cylinder") return false;
  const sides = shape.sides;
  return typeof sides === "number" && Number.isFinite(sides) && sides >= 3 && sides < ROUND_CYLINDER_SIDES;
}

/**
 * Yaw only vanishes for a shape that is actually round.
 *
 * A circular cylinder looks identical at any yaw, so dropping it keeps the
 * exported diameter invariant. A faceted one does not -- its flats have an
 * orientation, and dropping yaw silently turns the part.
 */
export function exportYawDegrees(shape: WorkplaneShape, circularEps = 0.0005) {
  const round = (shape.kind === "cylinder" || shape.kind === "cone") && !isFacetedCylinder(shape);
  const circular = Math.abs(shapeWidth(shape) - shapeDepth(shape)) < circularEps;
  return round && circular ? 0 : shape.rotation;
}

/**
 * One ring of a prism or a loft, in the editor's Y-up frame.
 *
 * The angles match THREE's CylinderGeometry (x = r·sin θ, z = r·cos θ, first
 * vertex towards +Z), so the exported flats sit where the viewport draws them
 * rather than rotated by half a facet.
 */
export function polygonRing(radiusX: number, radiusZ: number, sides: number, y: number): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  for (let i = 0; i < sides; i += 1) {
    const theta = (i / sides) * Math.PI * 2;
    points.push([radiusX * Math.sin(theta), y, radiusZ * Math.cos(theta)]);
  }
  return points;
}

/** One ring of a box, corners in the same winding as polygonRing. */
export function rectangleRing(width: number, depth: number, y: number): ProfilePoint[] {
  const x = width / 2;
  const z = depth / 2;
  return [[x, y, z], [x, y, -z], [-x, y, -z], [-x, y, z]];
}

export type TaperedProfile = {
  bottomWidth: number;
  bottomDepth: number;
  topWidth: number;
  topDepth: number;
};

/** The two end sizes a tapered shape lofts between. */
export function taperedProfile(shape: WorkplaneShape): TaperedProfile {
  const taper = shapeTaperDimensions(shape);
  return {
    bottomWidth: taper.bottomWidth,
    bottomDepth: taper.bottomDepth,
    topWidth: taper.topWidth,
    topDepth: taper.topDepth,
  };
}

export type TaperPlan =
  | { kind: "none" }
  | { kind: "cone"; bottomRadius: number; topRadius: number }
  | { kind: "loft"; bottom: ProfilePoint[]; top: ProfilePoint[] }
  | { kind: "skip"; reason: string };

/**
 * How a tapered shape should be built for export.
 *
 * A circular tapered cylinder is exactly a cone, so it uses the analytic
 * primitive. A box or a faceted cylinder lofts between its two end rings. Any
 * other kind is reported rather than exported straight, because writing the
 * untapered shape produces a file that does not match the screen.
 */
export function planTaper(shape: WorkplaneShape, circularEps = 0.0005): TaperPlan {
  if (!shapeHasTaper(shape)) return { kind: "none" };

  const { bottomWidth, bottomDepth, topWidth, topDepth } = taperedProfile(shape);
  const height = shape.height;

  if (shape.kind === "cylinder") {
    const bottomCircular = Math.abs(bottomWidth - bottomDepth) < circularEps;
    const topCircular = Math.abs(topWidth - topDepth) < circularEps;
    if (!isFacetedCylinder(shape) && bottomCircular && topCircular) {
      return { kind: "cone", bottomRadius: bottomWidth / 2, topRadius: topWidth / 2 };
    }
    const sides = isFacetedCylinder(shape) ? (shape.sides as number) : ROUND_CYLINDER_SIDES;
    return {
      kind: "loft",
      bottom: polygonRing(bottomWidth / 2, bottomDepth / 2, sides, -height / 2),
      top: polygonRing(topWidth / 2, topDepth / 2, sides, height / 2),
    };
  }

  if (shape.kind === "box") {
    return {
      kind: "loft",
      bottom: rectangleRing(bottomWidth, bottomDepth, -height / 2),
      top: rectangleRing(topWidth, topDepth, height / 2),
    };
  }

  return { kind: "skip", reason: `taper on a ${shape.kind} has no exact B-Rep mapping` };
}
