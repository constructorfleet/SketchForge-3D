import type { MeshPoint } from "./meshCoordinates.js";

export type TriangleFace = readonly [number, number, number];

export function analyzeMeshTopology(vertices: readonly MeshPoint[], faces: readonly TriangleFace[], tolerance = 0.0005) {
  const key = (point: MeshPoint) => point.map((value) => Math.round(value / tolerance)).join(",");
  const incidence = new Map<string, number>();
  let degenerateTriangles = 0;
  for (const [aIndex, bIndex, cIndex] of faces) {
    const a = vertices[aIndex];
    const b = vertices[bIndex];
    const c = vertices[cIndex];
    if (!a || !b || !c) { degenerateTriangles += 1; continue; }
    const area2 = Math.hypot((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (area2 <= tolerance * tolerance) {
      degenerateTriangles += 1;
      continue;
    }
    for (const [start, end] of [[a, b], [b, c], [c, a]] as const) {
      const edgeKey = [key(start), key(end)].sort().join("|");
      incidence.set(edgeKey, (incidence.get(edgeKey) ?? 0) + 1);
    }
  }
  const counts = [...incidence.values()];
  return {
    triangles: faces.length,
    boundaryEdges: counts.filter((count) => count === 1).length,
    nonManifoldEdges: counts.filter((count) => count > 2).length,
    degenerateTriangles,
    watertight: counts.length > 0 && counts.every((count) => count === 2) && degenerateTriangles === 0,
  };
}
