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
 * Only a mesh whose every shell is closed gets an answer. The signed volume of
 * an open fragment depends on where the origin is, so there is no honest number
 * to give for one; `null` sends the caller back to the kernel's sewing, which
 * can close gaps this does not and refuses what it cannot close.
 *
 * Pure arithmetic, no kernel: safe to call from anywhere.
 */

import type { MeshData } from "./meshTransform.js";

export type MeshMassProperties = {
  volume: number;
  area: number;
  centerOfMass: { x: number; y: number; z: number };
  bbox: { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };
};

/**
 * Weld tolerances tried in turn, in mm, after a near-exact weld. They follow
 * the sewing ladder `solidFromMeshPositions` uses, so a mesh whose corners miss
 * by a micron -- as a mesh boolean's output can -- closes here as it did there.
 */
const WELD_LADDER_MM = [1e-5, 1e-4, 1e-3, 1e-2];

/** A direction no axis-aligned or 45-degree feature lines up with, so a ray along it rarely grazes an edge. */
const RAY = (() => {
  const d = [0.5773502691896258 + 0.1234567, 0.5773502691896258 + 0.0456789, 0.5773502691896258 - 0.0789123];
  const length = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / length, d[1] / length, d[2] / length] as const;
})();

/** The mesh's mass properties, or `null` when its triangles do not bound a solid at any weld tolerance. */
export function meshMassProperties(mesh: MeshData): MeshMassProperties | null {
  return analyseMesh(mesh)?.properties ?? null;
}

/** One closed shell of a mesh, with its triangles wound as the mesh wound them. */
export type MeshSolidShell = {
  /** Flat triangle corners in the mesh's own coordinates. */
  positions: number[];
  /** How many other shells enclose it: even is material, odd is a void. */
  depth: number;
  /**
   * The volume it contributes to the mesh: positive for a body, negative for a
   * void. Their sum is the mesh's own volume, which is what a solid assembled
   * from the shells must come to if the nesting was read correctly.
   */
  volume: number;
};

/**
 * The closed shells a mesh is made of, each with its nesting depth (#501).
 *
 * OCCT sews one shell into one solid; a mesh with a sealed internal void, or
 * with several separate bodies, has more than one, and sewing them together
 * fails. A caller builds each shell into a solid and puts them back together:
 * material at even depth, voids at odd depth taken out of what encloses them.
 * The winding is left alone, since the depth -- not the winding -- says which
 * side is material, and the sewing orients each solid outward by itself.
 *
 * The shells are those of the first weld tolerance that closes the mesh, so
 * their corners are the welded ones. Null unless every shell is closed and
 * consistently orientable, because only then is the nesting well defined. A
 * shell enclosing no volume is left out.
 */
export function meshSolidShells(mesh: MeshData): MeshSolidShell[] | null {
  const analysis = analyseMesh(mesh);
  if (!analysis) return null;
  const { shells, depth, contribution, corners, points, origin } = analysis;
  return shells.flatMap((members, shell) => {
    if (depth[shell] < 0) return [];
    const positions: number[] = [];
    for (const t of members) {
      for (let k = 0; k < 3; k += 1) {
        const index = 3 * corners[3 * t + k];
        positions.push(points[index] + origin[0], points[index + 1] + origin[1], points[index + 2] + origin[2]);
      }
    }
    return [{ positions, depth: depth[shell], volume: contribution[shell] }];
  });
}

/** Flat triangle corners, as a stored mesh holds them, as `MeshData`. */
export function meshDataFromPositions(positions: readonly number[]): MeshData {
  const vertices: [number, number, number][] = [];
  const faces: [number, number, number][] = [];
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const first = vertices.length;
    for (let corner = 0; corner < 3; corner += 1) {
      const at = index + corner * 3;
      vertices.push([positions[at], positions[at + 1], positions[at + 2]]);
    }
    faces.push([first, first + 1, first + 2]);
  }
  return { name: "mesh", vertices, faces };
}

/** The mesh welded at the first tolerance that closes it, measured, with the shells it found. */
function analyseMesh(mesh: MeshData) {
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

  // Corners measured from the bounds' centre to keep the products small.
  const origin = [(xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2] as const;
  let welded = cornerPoints(mesh, origin);
  const tight = Math.max(1, Math.hypot(xmax - xmin, ymax - ymin, zmax - zmin)) * 1e-9;

  // Each pass welds what the last one left, so it only sees distinct points.
  for (const tolerance of [tight, ...WELD_LADDER_MM.filter((step) => step > tight)]) {
    welded = compact(welded, weld(welded.points, tolerance));
    const measured = measureWelded(welded, tolerance);
    if (!measured) continue;
    const { volume, area, moment } = measured;
    const properties: MeshMassProperties = {
      volume,
      area,
      centerOfMass: { x: origin[0] + moment[0] / volume, y: origin[1] + moment[1] / volume, z: origin[2] + moment[2] / volume },
      bbox,
    };
    return { ...measured, properties, points: welded.points, origin };
  }
  return null;
}

type WeldedPoints = {
  /** x, y, z of each point, relative to the bounds' centre. */
  points: Float64Array;
  /** The point each triangle corner is, three per face; -1 for a missing vertex. */
  corners: Int32Array;
};

function cornerPoints(mesh: MeshData, origin: readonly [number, number, number]): WeldedPoints {
  const points = new Float64Array(mesh.faces.length * 9);
  const corners = new Int32Array(mesh.faces.length * 3);
  mesh.faces.forEach((face, f) => {
    for (let k = 0; k < 3; k += 1) {
      const c = 3 * f + k;
      const vertex = mesh.vertices[face[k]];
      corners[c] = vertex ? c : -1;
      if (!vertex) continue;
      points[3 * c] = vertex[0] - origin[0];
      points[3 * c + 1] = vertex[1] - origin[1];
      points[3 * c + 2] = vertex[2] - origin[2];
    }
  });
  return { points, corners };
}

/** Keep only the points `into` maps to themselves, and point every corner at its survivor. */
function compact({ points, corners }: WeldedPoints, into: Int32Array): WeldedPoints {
  const renumbered = new Int32Array(into.length).fill(-1);
  let kept = 0;
  for (let p = 0; p < into.length; p += 1) if (into[p] === p) renumbered[p] = kept++;
  const next = new Float64Array(kept * 3);
  for (let p = 0; p < into.length; p += 1) {
    if (renumbered[p] < 0) continue;
    next.set(points.subarray(3 * p, 3 * p + 3), 3 * renumbered[p]);
  }
  const remapped = corners.map((c) => (c < 0 ? -1 : renumbered[into[c]]));
  return { points: next, corners: remapped };
}

/**
 * Merge points lying within `tolerance` of an earlier one on every axis.
 *
 * Points are bucketed into cells twice the tolerance wide, so the points within
 * reach of one lie in the 2 x 2 x 2 cells on the side of its cell it sits
 * nearest; checking those means two points straddling a cell boundary still
 * merge, where rounding to a grid alone would keep them apart however close
 * they are. Cells are keyed by a hash: a collision only puts two cells' points
 * in one bucket, and the distance test still tells them apart.
 */
function weld(points: Float64Array, tolerance: number) {
  const count = points.length / 3;
  const into = new Int32Array(count);
  const cells = new Map<number, number[]>();
  const size = 2 * tolerance;
  const hash = (i: number, j: number, k: number) => Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791);
  for (let p = 0; p < count; p += 1) {
    const x = points[3 * p], y = points[3 * p + 1], z = points[3 * p + 2];
    const fx = x / size, fy = y / size, fz = z / size;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const si = fx - i < 0.5 ? -1 : 1, sj = fy - j < 0.5 ? -1 : 1, sk = fz - k < 0.5 ? -1 : 1;
    let found = -1;
    search: for (let n = 0; n < 8; n += 1) {
      const bucket = cells.get(hash(n & 1 ? i + si : i, n & 2 ? j + sj : j, n & 4 ? k + sk : k));
      if (!bucket) continue;
      for (const q of bucket) {
        if (Math.abs(points[3 * q] - x) <= tolerance && Math.abs(points[3 * q + 1] - y) <= tolerance && Math.abs(points[3 * q + 2] - z) <= tolerance) {
          found = q;
          break search;
        }
      }
    }
    if (found >= 0) {
      into[p] = into[found];
    } else {
      into[p] = p;
      const key = hash(i, j, k);
      const bucket = cells.get(key);
      if (bucket) bucket.push(p);
      else cells.set(key, [p]);
    }
  }
  return into;
}

/** Volume, area and first moment of the welded mesh, or `null` when some shell is open or cannot be wound consistently. */
function measureWelded({ points, corners: raw }: WeldedPoints, tolerance: number) {

  // Triangles on the welded corners. A triangle with a repeated corner encloses
  // and bounds nothing. A triangle the file repeats counts once, and two that
  // coincide facing opposite ways -- the shared face of two parts stacked on
  // each other -- cancel, which leaves the two parts' union.
  const vertexCount = points.length / 3;
  // Keyed by the two lowest corners; each entry lists [highest corner, net winding] pairs.
  const tally = new Map<number, number[]>();
  for (let t = 0; t < raw.length; t += 3) {
    if (raw[t] < 0 || raw[t + 1] < 0 || raw[t + 2] < 0) continue;
    const a = raw[t], b = raw[t + 1], c = raw[t + 2];
    if (a === b || b === c || a === c) continue;
    // Rotate the smallest corner first; the other two then read ascending or not.
    const [p, q, r] = a < b && a < c ? [a, b, c] : b < c ? [b, c, a] : [c, a, b];
    const ascending = q < r;
    const key = p * vertexCount + (ascending ? q : r);
    const high = ascending ? r : q;
    const entry = tally.get(key);
    if (!entry) { tally.set(key, [high, ascending ? 1 : -1]); continue; }
    let at = 0;
    while (at < entry.length && entry[at] !== high) at += 2;
    if (at === entry.length) entry.push(high, ascending ? 1 : -1);
    else entry[at + 1] += ascending ? 1 : -1;
  }
  const cornerList: number[] = [];
  for (const [key, entry] of tally) {
    const p = Math.floor(key / vertexCount), low = key - p * vertexCount;
    for (let at = 0; at < entry.length; at += 2) {
      if (entry[at + 1] > 0) cornerList.push(p, low, entry[at]);
      else if (entry[at + 1] < 0) cornerList.push(p, entry[at], low);
    }
  }
  const corners = Int32Array.from(cornerList);
  const triangleCount = corners.length / 3;
  if (!triangleCount) return null;
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
        } else if (flipped[other] !== otherFlip) {
          return null; // Not orientable.
        }
      }
    }
    shells.push(members);
  }

  // Every shell closed on its own: in its own winding, each edge it uses is
  // crossed as often one way as the other. Checked before anything else, so an
  // open mesh -- which can fall into one shell per triangle -- costs one pass.
  for (const [key, sharing] of edgeTriangles) {
    const a = Math.floor(key / vertexCount), b = key - a * vertexCount;
    // [shell, net, shell, net, ...]: an edge rarely has more than one shell on it.
    const nets: number[] = [];
    for (const t of sharing) {
      const direction = (runsForward(t, a, b) ? 1 : -1) * (flipped[t] ? -1 : 1);
      let at = 0;
      while (at < nets.length && nets[at] !== shellOf[t]) at += 2;
      if (at === nets.length) nets.push(shellOf[t], direction);
      else nets[at + 1] += direction;
    }
    for (let at = 1; at < nets.length; at += 2) if (nets[at] !== 0) return null;
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

  // How many other shells enclose this one. Only a shell whose bounds hold all
  // of this one's can, which rules out every pair that merely sits side by side
  // or touches; for the rest, cast a ray from this shell's extreme corner along
  // RAY, which leaves the shell itself at once, and count the crossings.
  //
  // Comparing every pair of shells' bounds would cost the square of the shell
  // count, so shells are first entered in a coarse grid over every cell their
  // bounds overlap. Any shell enclosing this one overlaps the cell this one's
  // lowest corner is in, so only that cell's shells need comparing.
  const slack = tolerance * 10;
  const perAxis = Math.max(1, Math.min(64, Math.ceil(Math.cbrt(shells.length))));
  const lows = [Infinity, Infinity, Infinity], highs = [-Infinity, -Infinity, -Infinity];
  for (let b = 0; b < shellBounds.length; b += 6) {
    for (let axis = 0; axis < 3; axis += 1) {
      lows[axis] = Math.min(lows[axis], shellBounds[b + axis]);
      highs[axis] = Math.max(highs[axis], shellBounds[b + 3 + axis]);
    }
  }
  const cellAlong = (axis: number, value: number) => {
    const span = highs[axis] - lows[axis];
    if (!(span > 0)) return 0;
    return Math.max(0, Math.min(perAxis - 1, Math.floor(((value - lows[axis]) / span) * perAxis)));
  };
  const grid = new Map<number, number[]>();
  if (shells.length > 1) {
    for (let shell = 0; shell < shells.length; shell += 1) {
      const b = 6 * shell;
      const i0 = cellAlong(0, shellBounds[b] - slack), i1 = cellAlong(0, shellBounds[b + 3] + slack);
      const j0 = cellAlong(1, shellBounds[b + 1] - slack), j1 = cellAlong(1, shellBounds[b + 4] + slack);
      const k0 = cellAlong(2, shellBounds[b + 2] - slack), k1 = cellAlong(2, shellBounds[b + 5] + slack);
      for (let i = i0; i <= i1; i += 1) {
        for (let j = j0; j <= j1; j += 1) {
          for (let k = k0; k <= k1; k += 1) {
            const key = i + perAxis * (j + perAxis * k);
            const cell = grid.get(key);
            if (cell) cell.push(shell);
            else grid.set(key, [shell]);
          }
        }
      }
    }
  }
  const enclosingCount = (shell: number) => {
    const s = 6 * shell;
    let best = -Infinity, px = 0, py = 0, pz = 0;
    let depth = 0;
    const candidates = grid.get(cellAlong(0, shellBounds[s]) + perAxis * (cellAlong(1, shellBounds[s + 1]) + perAxis * cellAlong(2, shellBounds[s + 2]))) ?? [];
    for (const other of candidates) {
      if (other === shell) continue;
      const b = 6 * other;
      if (shellBounds[s] < shellBounds[b] - slack || shellBounds[s + 1] < shellBounds[b + 1] - slack || shellBounds[s + 2] < shellBounds[b + 2] - slack) continue;
      if (shellBounds[s + 3] > shellBounds[b + 3] + slack || shellBounds[s + 4] > shellBounds[b + 4] + slack || shellBounds[s + 5] > shellBounds[b + 5] + slack) continue;
      if (best === -Infinity) {
        for (const t of shells[shell]) {
          for (let k = 0; k < 3; k += 1) {
            const i = 3 * corners[3 * t + k];
            const reach = points[i] * RAY[0] + points[i + 1] * RAY[1] + points[i + 2] * RAY[2];
            if (reach > best) { best = reach; px = points[i]; py = points[i + 1]; pz = points[i + 2]; }
          }
        }
      }
      let crossings = 0;
      for (const t of shells[other]) {
        if (rayHitsTriangle(px, py, pz, points, corners, t, slack)) crossings += 1;
      }
      if (crossings % 2 === 1) depth += 1;
    }
    return depth;
  };

  let volume = 0;
  const moment = [0, 0, 0];
  // Nesting depth per shell, -1 for a shell that encloses nothing, and the
  // signed volume each adds to the whole.
  const depth = new Int32Array(shells.length).fill(-1);
  const contribution = new Float64Array(shells.length);
  for (let shell = 0; shell < shells.length; shell += 1) {
    const own = shellVolume[shell];
    if (own === 0) continue;
    depth[shell] = shells.length > 1 ? enclosingCount(shell) : 0;
    const wanted = depth[shell] % 2 === 1 ? -1 : 1;
    const sign = Math.sign(own) === wanted ? 1 : -1;
    contribution[shell] = sign * own;
    volume += sign * own;
    moment[0] += sign * shellMoment[3 * shell];
    moment[1] += sign * shellMoment[3 * shell + 1];
    moment[2] += sign * shellMoment[3 * shell + 2];
  }
  if (!(volume > 0)) return null;
  return { volume, area, moment, shells, depth, contribution, corners };
}

/** Möller-Trumbore: whether the ray from (px, py, pz) along RAY crosses triangle `t` beyond `minDistance`. */
function rayHitsTriangle(px: number, py: number, pz: number, points: Float64Array, corners: Int32Array, t: number, minDistance: number) {
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
