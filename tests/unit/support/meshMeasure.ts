import type * as THREE from "three";

/**
 * Volume and centroid of a closed triangle mesh, by the divergence theorem.
 *
 * Shared by `tests/unit/primitiveGeometry.test.ts` and
 * `tests/e2e/primitiveGeometryAgreement.e2e.ts` so that the mesh and the exact
 * solid are measured the same way.
 *
 * Deliberately not bounding extents. A bounding box cannot see a mirrored or a
 * misordered solid -- a box or a cylinder is unchanged by the exact 180-degree
 * error a negated yaw produces -- and that blind spot has hidden two real bugs
 * in this repository already: a box built from its corner instead of its centre,
 * and a rotation composition that disagreed with the editor in four of six cases
 * while every test in the suite passed either way.
 *
 * The signed volume is also a winding check for free: each triangle contributes
 * the signed volume of the tetrahedron it makes with the origin, so a mesh whose
 * faces point outward comes back positive and one with its winding reversed
 * comes back negative. A mesh with *some* faces reversed lands somewhere
 * between, which is why these are compared against closed-form values rather
 * than only tested for sign.
 */
export type MeshMeasurement = {
  /** Signed: positive for outward-facing winding, negative for reversed. */
  volume: number;
  centroid: readonly [number, number, number];
  triangles: number;
};

export function measureMesh(geometry: THREE.BufferGeometry): MeshMeasurement {
  const position = geometry.getAttribute("position");
  const index = geometry.index;
  const count = index ? index.count : position.count;
  if (count % 3 !== 0) throw new Error(`not a triangle mesh: ${count} vertices`);

  const at = (slot: number) => {
    const vertex = index ? index.getX(slot) : slot;
    return [position.getX(vertex), position.getY(vertex), position.getZ(vertex)] as const;
  };

  let volume = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let slot = 0; slot < count; slot += 3) {
    const a = at(slot);
    const b = at(slot + 1);
    const c = at(slot + 2);
    // a . (b x c) / 6 -- the tetrahedron on the origin.
    const sixth = (
      a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
    volume += sixth;
    cx += sixth * (a[0] + b[0] + c[0]) / 4;
    cy += sixth * (a[1] + b[1] + c[1]) / 4;
    cz += sixth * (a[2] + b[2] + c[2]) / 4;
  }

  const scale = Math.abs(volume) < 1e-12 ? 0 : 1 / volume;
  return {
    volume,
    centroid: [cx * scale, cy * scale, cz * scale],
    triangles: count / 3,
  };
}

/** The axis-aligned extents, for the few assertions where a box is the right tool. */
export function meshExtents(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const point = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return {
    min: min as [number, number, number],
    max: max as [number, number, number],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as [number, number, number],
  };
}
