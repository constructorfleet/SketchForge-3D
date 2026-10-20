import type { MeshPoint } from "./meshCoordinates.js";

export type ProjectionPoint = [number, number];
export type ProjectionFace = readonly [number, number, number];

/** Project a triangle soup onto SketchForge's X/Z plane, keeping nonzero, CCW contours. */
export function projectedMeshContours(vertices: readonly MeshPoint[], faces: readonly ProjectionFace[], areaTolerance = 1e-10) {
  const contours: ProjectionPoint[][] = [];
  for (const [aIndex, bIndex, cIndex] of faces) {
    const a = vertices[aIndex];
    const b = vertices[bIndex];
    const c = vertices[cIndex];
    if (!a || !b || !c) continue;
    const contour: ProjectionPoint[] = [[a[0] || 0, -a[2] || 0], [b[0] || 0, -b[2] || 0], [c[0] || 0, -c[2] || 0]];
    const signedArea2 = contour[0][0] * (contour[1][1] - contour[2][1]) + contour[1][0] * (contour[2][1] - contour[0][1]) + contour[2][0] * (contour[0][1] - contour[1][1]);
    if (Math.abs(signedArea2) <= areaTolerance) continue;
    contours.push(signedArea2 > 0 ? contour : [contour[0], contour[2], contour[1]]);
  }
  return contours;
}
