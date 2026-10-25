/**
 * Mass properties of a triangle mesh, straight from its triangles (#508).
 *
 * Sewing an imported mesh into an OCCT solid only to ask the kernel for its
 * volume took over a minute on a 57k-triangle STL, blocked every other call
 * while it ran, and reported the answer as tessellated anyway. The divergence
 * theorem gives the same numbers from the triangles in one pass.
 *
 * The mesh may hold several shells, and some of them may be voids. Each shell's
 * triangles are first wound consistently with one another; whether the shell
 * then counts as material or as a cavity is decided by how many other shells
 * enclose it (even: material, odd: void), not by the file's winding, which
 * imported meshes get wrong often enough that OCCT's path had to repair it.
 *
 * Pure arithmetic, no kernel: safe to call from anywhere.
 */

import type { MeshData } from "./meshTransform.js";

export type MeshMassProperties = {
  volume: number;
  area: number;
  centerOfMass: { x: number; y: number; z: number };
  bbox: { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };
  /** Every shell closed and consistently orientable, with positive volume. */
  isValid: boolean;
};

/** A direction no axis-aligned or 45-degree feature lines up with, so a ray along it rarely grazes an edge. */
const RAY = (() => {
  const d = [0.5773502691896258 + 0.1234567, 0.5773502691896258 + 0.0456789, 0.5773502691896258 - 0.0789123];
  const length = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / length, d[1] / length, d[2] / length] as const;
})();

export function meshMassProperties(mesh: MeshData): MeshMassProperties | null {
  if (!mesh.vertices.length || !mesh.faces.length) return null;

  // Bounds, from every vertex a triangle uses.
  let xmin = Infinity, ymin = Infinity, zmin = Infinity;
  let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
  for (const face of mesh.faces) {
    for (const index of face) {
      const vertex = mesh.vertices[index];
      if (!vertex) continue;
      const [x, y, z] = vertex;
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    }
  }
  if (!Number.isFinite(xmin + ymin + zmin + xmax + ymax + zmax)) return null;
  const bbox = { xmin, ymin, zmin, xmax, ymax, zmax };

  // Weld coincident corners so triangles that share an edge can find each
  // other. Measured from the bounds' centre to keep the products small.
  const ox = (xmin + xmax) / 2, oy = (ymin + ymax) / 2, oz = (zmin + zmax) / 2;
  const quantum = Math.max(1, Math.hypot(xmax - xmin, ymax - ymin, zmax - zmin)) * 1e-9;
  const welded = new Map<string, number>();
  const points: number[] = [];
  const weld = (index: number) => {
    const vertex = mesh.vertices[index];
    if (!vertex) return -1;
    const x = vertex[0] - ox, y = vertex[1] - oy, z = vertex[2] - oz;
    const key = `${Math.round(x / quantum)},${Math.round(y / quantum)},${Math.round(z / quantum)}`;
    let id = welded.get(key);
    if (id === undefined) {
      id = points.length / 3;
      welded.set(key, id);
      points.push(x, y, z);
    }
    return id;
  };

  const corners: number[] = [];
  for (const [a, b, c] of mesh.faces) {
    const ia = weld(a), ib = weld(b), ic = weld(c);
    // A triangle with a repeated corner encloses nothing and bounds nothing.
    if (ia < 0 || ib < 0 || ic < 0 || ia === ib || ib === ic || ia === ic) continue;
    corners.push(ia, ib, ic);
  }
  const triangleCount = corners.length / 3;
  if (!triangleCount) return null;
  const vertexCount = points.length / 3;
  const edgeKey = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);

  // Which triangles meet along each edge.
  const edgeTriangles = new Map<number, number[]>();
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(corners[3 * t + k], corners[3 * t + ((k + 1) % 3)]);
      const list = edgeTriangles.get(key);
      if (list) list.push(t);
      else edgeTriangles.set(key, [t]);
    }
  }
  const runsForward = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k += 1) {
      if (corners[3 * t + k] === a && corners[3 * t + ((k + 1) % 3)] === b) return true;
    }
    return false;
  };

  // Shells: triangles joined across manifold edges, wound to agree with the
  // first triangle of their shell. An edge shared by more than two triangles
  // (two parts touching along it) joins nothing.
  const shellOf = new Int32Array(triangleCount).fill(-1);
  const flipped = new Uint8Array(triangleCount);
  let orientable = true;
  const shells: number[][] = [];
  for (let seed = 0; seed < triangleCount; seed += 1) {
    if (shellOf[seed] >= 0) continue;
    const shell = shells.length;
    const members = [seed];
    shellOf[seed] = shell;
    for (let cursor = 0; cursor < members.length; cursor += 1) {
      const t = members[cursor];
      for (let k = 0; k < 3; k += 1) {
        let a = corners[3 * t + k], b = corners[3 * t + ((k + 1) % 3)];
        if (flipped[t]) [a, b] = [b, a];
        const sharing = edgeTriangles.get(edgeKey(a, b))!;
        if (sharing.length !== 2) continue;
        const other = sharing[0] === t ? sharing[1] : sharing[0];
        // Agreeing neighbours cross a shared edge in opposite directions.
        const otherFlip = runsForward(other, a, b) ? 1 : 0;
        if (shellOf[other] < 0) {
          shellOf[other] = shell;
          flipped[other] = otherFlip;
          members.push(other);
        } else if (shellOf[other] === shell && flipped[other] !== otherFlip) {
          orientable = false;
        }
      }
    }
    shells.push(members);
  }

  // Per shell: signed volume, first moment, area and bounds, in its own winding.
  const shellVolume = new Float64Array(shells.length);
  const shellMoment = new Float64Array(shells.length * 3);
  const shellBounds = new Float64Array(shells.length * 6);
  let area = 0;
  shells.forEach((members, shell) => {
    let volume = 0, mx = 0, my = 0, mz = 0;
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    for (const t of members) {
      const ia = 3 * corners[3 * t];
      let ib = 3 * corners[3 * t + 1];
      let ic = 3 * corners[3 * t + 2];
      if (flipped[t]) [ib, ic] = [ic, ib];
      const ax = points[ia], ay = points[ia + 1], az = points[ia + 2];
      const bx = points[ib], by = points[ib + 1], bz = points[ib + 2];
      const cx = points[ic], cy = points[ic + 1], cz = points[ic + 2];
      // Tetrahedron (origin, a, b, c): signed volume and centroid.
      const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      volume += v;
      mx += (v * (ax + bx + cx)) / 4;
      my += (v * (ay + by + cy)) / 4;
      mz += (v * (az + bz + cz)) / 4;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const wx = cx - ax, wy = cy - ay, wz = cz - az;
      area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
      bx0 = Math.min(bx0, ax, bx, cx); bx1 = Math.max(bx1, ax, bx, cx);
      by0 = Math.min(by0, ay, by, cy); by1 = Math.max(by1, ay, by, cy);
      bz0 = Math.min(bz0, az, bz, cz); bz1 = Math.max(bz1, az, bz, cz);
    }
    shellVolume[shell] = volume;
    shellMoment.set([mx, my, mz], shell * 3);
    shellBounds.set([bx0, by0, bz0, bx1, by1, bz1], shell * 6);
  });

  // How many other shells enclose this one: cast a ray from the shell's
  // extreme corner along RAY, which leaves the shell itself at once, and count
  // the crossings with each shell whose bounds contain that corner.
  const slack = quantum * 10;
  const enclosingCount = (shell: number) => {
    let best = -Infinity, px = 0, py = 0, pz = 0;
    for (const t of shells[shell]) {
      for (let k = 0; k < 3; k += 1) {
        const i = 3 * corners[3 * t + k];
        const reach = points[i] * RAY[0] + points[i + 1] * RAY[1] + points[i + 2] * RAY[2];
        if (reach > best) { best = reach; px = points[i]; py = points[i + 1]; pz = points[i + 2]; }
      }
    }
    let depth = 0;
    for (let other = 0; other < shells.length; other += 1) {
      if (other === shell) continue;
      const b = 6 * other;
      if (px < shellBounds[b] - slack || py < shellBounds[b + 1] - slack || pz < shellBounds[b + 2] - slack) continue;
      if (px > shellBounds[b + 3] + slack || py > shellBounds[b + 4] + slack || pz > shellBounds[b + 5] + slack) continue;
      let crossings = 0;
      for (const t of shells[other]) {
        if (rayHitsTriangle(px, py, pz, points, corners, t, slack)) crossings += 1;
      }
      if (crossings % 2 === 1) depth += 1;
    }
    return depth;
  };

  let volume = 0, mx = 0, my = 0, mz = 0;
  const sign = new Int8Array(shells.length);
  for (let shell = 0; shell < shells.length; shell += 1) {
    const own = shellVolume[shell];
    if (own === 0) continue;
    const wanted = shells.length > 1 && enclosingCount(shell) % 2 === 1 ? -1 : 1;
    sign[shell] = Math.sign(own) === wanted ? 1 : -1;
    volume += sign[shell] * own;
    mx += sign[shell] * shellMoment[3 * shell];
    my += sign[shell] * shellMoment[3 * shell + 1];
    mz += sign[shell] * shellMoment[3 * shell + 2];
  }

  // Closed: with every shell wound its final way, each edge is crossed as
  // often in one direction as in the other.
  const net = new Map<number, number>();
  for (let t = 0; t < triangleCount; t += 1) {
    const reversed = (flipped[t] ? -1 : 1) * (sign[shellOf[t]] || 1) < 0;
    for (let k = 0; k < 3; k += 1) {
      let a = corners[3 * t + k], b = corners[3 * t + ((k + 1) % 3)];
      if (reversed) [a, b] = [b, a];
      const key = edgeKey(a, b);
      net.set(key, (net.get(key) ?? 0) + (a < b ? 1 : -1));
    }
  }
  let closed = true;
  for (const count of net.values()) {
    if (count !== 0) { closed = false; break; }
  }

  const centerOfMass = volume !== 0
    ? { x: ox + mx / volume, y: oy + my / volume, z: oz + mz / volume }
    : { x: ox, y: oy, z: oz };
  return {
    volume,
    area,
    centerOfMass,
    bbox,
    isValid: closed && orientable && volume > 0,
  };
}

/** Möller-Trumbore: whether the ray from (px, py, pz) along RAY crosses triangle `t` beyond `minDistance`. */
function rayHitsTriangle(px: number, py: number, pz: number, points: number[], corners: number[], t: number, minDistance: number) {
  const ia = 3 * corners[3 * t], ib = 3 * corners[3 * t + 1], ic = 3 * corners[3 * t + 2];
  const ax = points[ia], ay = points[ia + 1], az = points[ia + 2];
  const e1x = points[ib] - ax, e1y = points[ib + 1] - ay, e1z = points[ib + 2] - az;
  const e2x = points[ic] - ax, e2y = points[ic + 1] - ay, e2z = points[ic + 2] - az;
  const hx = RAY[1] * e2z - RAY[2] * e2y;
  const hy = RAY[2] * e2x - RAY[0] * e2z;
  const hz = RAY[0] * e2y - RAY[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-15) return false;
  const inv = 1 / det;
  const sx = px - ax, sy = py - ay, sz = pz - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (RAY[0] * qx + RAY[1] * qy + RAY[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return distance > minDistance;
}
