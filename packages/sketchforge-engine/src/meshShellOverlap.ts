/**
 * How the closed shells of a mesh sit relative to one another (#529).
 *
 * A mesh measured shell by shell -- bodies added, voids subtracted -- is only
 * right when its shells nest: every pair is either apart or one wholly inside
 * the other. Two bodies that overlap without either enclosing the other, as an
 * imported STL nobody unioned can hold, would have the overlap counted twice.
 *
 * Only shells whose surfaces meet need any work. Two closed surfaces that do
 * not meet are apart or nested, and ray parity from one of them says which.
 * Where they do meet, one shell overlaps the other without nesting exactly when
 * its surface has area strictly inside the other *and* area strictly outside
 * it: a surface wholly inside (or on) another's closure is enclosed by it, and
 * one wholly outside (or on) it is apart from it or encloses it.
 *
 * - Two faces crossing each other transversally prove both at once.
 * - Shells that only touch -- along a face they share without sharing its
 *   triangles, an edge, or a corner -- have no area strictly on the far side,
 *   so they are apart or nested, and their volumes add or subtract exactly:
 *   what they share has no volume. Which of the two they are is read here from
 *   their surfaces, not from ray parity, because a ray cast from a point where
 *   two shells touch cannot tell inside from outside.
 * - Bodies that overlap with no face crossing another -- side by side over a
 *   shared slab, every face of the overlap coplanar with one of theirs -- show
 *   it in their surfaces' sides: the touching triangles are sampled, and every
 *   connected patch of the rest is classified once.
 *
 * Shells whose surfaces never come within `slack` are left to the caller.
 *
 * A uniform grid finds which triangles of different shells come within `slack`
 * of each other, and each shell that has to be classified against gets a grid
 * of triangle columns along the ray, so neither step compares every triangle
 * with every other. A shell is classified against another only where their
 * bounds meet, so a plate with hundreds of parts resting on it costs each part
 * its own neighbourhood, not the whole plate. Pure arithmetic, no kernel.
 */

/**
 * Thrown by the mesh measures when two closed bodies overlap without one
 * enclosing the other. Callers on the server turn it into the exact path's
 * refusal; it carries no kernel type so this module stays kernel-free.
 */
export class MeshShellsOverlapError extends Error {
  constructor() {
    super("The mesh has closed bodies that overlap without one enclosing the other.");
    this.name = "MeshShellsOverlapError";
  }
}

/** A mesh's closed shells, on welded points. */
export type ClosedShells = {
  /** x, y, z of each point. */
  points: Float64Array;
  /** Three points per triangle. */
  corners: Int32Array;
  /** The triangles of each shell. */
  shells: readonly (readonly number[])[];
  /** The shell each triangle belongs to. */
  shellOf: Int32Array;
  /** Per triangle, the triangle across its edge from corner k to corner k + 1, or -1. */
  neighbours: Int32Array;
  /** xmin, ymin, zmin, xmax, ymax, zmax per shell. */
  bounds: Float64Array;
};

/** How two shells whose surfaces meet sit. "first" is the lower-numbered shell. */
export type ShellRelation = "apart" | "first-inside" | "second-inside" | "overlap";

export type TouchingShells = {
  /** A pair of shells that overlap without nesting, or `null` when every touching pair nests or sits apart. */
  overlapping: readonly [number, number] | null;
  /** The relation of every pair whose surfaces meet, keyed by `shellPairKey`. */
  relations: Map<number, ShellRelation>;
};

/** The key `relateTouchingShells` files a pair of shells under. */
export function shellPairKey(a: number, b: number, shellCount: number) {
  return a < b ? a * shellCount + b : b * shellCount + a;
}

/** A direction no axis-aligned or 45-degree feature lines up with. */
const RAY = (() => {
  const d = [0.5773502691896258 + 0.0731, 0.5773502691896258 - 0.1123, 0.5773502691896258 + 0.0417];
  const length = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / length, d[1] / length, d[2] / length] as const;
})();

/** Two axes perpendicular to RAY, for projecting along it. */
const ACROSS = (() => {
  const [dx, dy, dz] = RAY;
  let ux = dy * 0 - dz * 1, uy = dz * 0 - dx * 0, uz = dx * 1 - dy * 0; // RAY x (0, 1, 0)
  const length = Math.hypot(ux, uy, uz);
  ux /= length; uy /= length; uz /= length;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  return [[ux, uy, uz], [vx, vy, vz]] as const;
})();

/**
 * Barycentric sample points of a touching triangle: the centroids of the 16
 * triangles its edges split into quarters make, so a sample lands in any part
 * of it that is more than a sliver.
 */
const SAMPLES = (() => {
  const n = 4;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; i + j < n; j += 1) {
      out.push([(i + 1 / 3) / n, (j + 1 / 3) / n]);
      if (i + j < n - 1) out.push([(i + 2 / 3) / n, (j + 2 / 3) / n]);
    }
  }
  // The centroid first: it settles most triangles in one query.
  out.unshift([1 / 3, 1 / 3]);
  return out;
})();

/** Bounds per axis may grow to this many grid cells, so a few huge triangles among tiny ones stay cheap. */
const MAX_CELLS_PER_AXIS = 128;

/**
 * The relation of every pair of shells whose surfaces come within `slack` of
 * each other, stopping at the first pair that overlaps without nesting.
 */
export function relateTouchingShells(input: ClosedShells, slack: number): TouchingShells {
  const relations = new Map<number, ShellRelation>();
  const shellCount = input.shells.length;
  const partners = candidatePairs(input.bounds, shellCount, slack);
  if (!partners.size) return { overlapping: null, relations };

  const grid = triangleGrid(input, partners, slack);
  const contacts = new Map<number, { first: Set<number>; second: Set<number> }>();
  const tested = new Set<number>();
  const triangleCount = input.shellOf.length;

  // Every pair of triangles from different shells sharing a cell. Each cell's
  // triangles are grouped by shell first, so a fine shell filling a cell is
  // never paired with itself.
  const byShell = new Map<number, number[]>();
  for (const cell of grid.cells.values()) {
    byShell.clear();
    for (const t of cell) {
      const shell = input.shellOf[t];
      const list = byShell.get(shell);
      if (list) list.push(t);
      else byShell.set(shell, [t]);
    }
    if (byShell.size < 2) continue;
    // Ascending by shell, so the first of each pair is the lower-numbered shell.
    const groups = [...byShell].sort((one, two) => one[0] - two[0]);
    for (let x = 0; x < groups.length; x += 1) {
      for (let y = x + 1; y < groups.length; y += 1) {
        const [first, firstTriangles] = groups[x], [second, secondTriangles] = groups[y];
        if (!partners.get(first)?.has(second)) continue;
        const key = first * shellCount + second;
        for (const s of firstTriangles) {
          for (const t of secondTriangles) {
            const pairKey = s * triangleCount + t;
            if (tested.has(pairKey)) continue;
            tested.add(pairKey);
            const contact = triangleContact(input, s, t, slack);
            if (contact === "none") continue;
            // Faces crossing each other: each shell has area on both sides of the other.
            if (contact === "cross") return { overlapping: [first, second], relations };
            const entry = contacts.get(key) ?? { first: new Set<number>(), second: new Set<number>() };
            entry.first.add(s);
            entry.second.add(t);
            contacts.set(key, entry);
          }
        }
      }
    }
  }

  const classifier = new SideClassifier(input, grid, slack);
  for (const [key, { first: firstContacts, second: secondContacts }] of contacts) {
    const first = Math.floor(key / shellCount), second = key - first * shellCount;
    const firstSides = classifier.sides(first, second, firstContacts);
    const secondSides = classifier.sides(second, first, secondContacts);
    const relation = relationFrom(firstSides, secondSides);
    relations.set(key, relation);
    if (relation === "overlap") return { overlapping: [first, second], relations };
  }
  return { overlapping: null, relations };
}

type Sides = { inside: boolean; outside: boolean };

function relationFrom(first: Sides, second: Sides): ShellRelation {
  if ((first.inside && first.outside) || (second.inside && second.outside)) return "overlap";
  // A shell with no area off the other's surface -- the same body twice, in
  // different triangles -- or two shells each inside the other: nothing honest
  // to say, so the pair is not passed as nested.
  if ((!first.inside && !first.outside) || (!second.inside && !second.outside)) return "overlap";
  if (first.inside && second.inside) return "overlap";
  if (first.inside) return "first-inside";
  if (second.inside) return "second-inside";
  return "apart";
}

/** For each shell, the shells whose bounds come within `slack` of its own: sweep and prune along x. */
function candidatePairs(bounds: Float64Array, shellCount: number, slack: number) {
  const partners = new Map<number, Set<number>>();
  if (shellCount < 2) return partners;
  const order = Array.from({ length: shellCount }, (_, shell) => shell).sort((p, q) => bounds[6 * p] - bounds[6 * q]);
  for (let at = 0; at < order.length; at += 1) {
    const a = order[at], ba = 6 * a;
    for (let next = at + 1; next < order.length; next += 1) {
      const b = order[next], bb = 6 * b;
      if (bounds[bb] > bounds[ba + 3] + slack) break;
      if (bounds[bb + 1] > bounds[ba + 4] + slack || bounds[ba + 1] > bounds[bb + 4] + slack) continue;
      if (bounds[bb + 2] > bounds[ba + 5] + slack || bounds[ba + 2] > bounds[bb + 5] + slack) continue;
      if (bounds[bb + 3] < bounds[ba] - slack) continue;
      (partners.get(a) ?? partners.set(a, new Set()).get(a)!).add(b);
      (partners.get(b) ?? partners.set(b, new Set()).get(b)!).add(a);
    }
  }
  return partners;
}

type TriangleGrid = {
  origin: [number, number, number];
  size: [number, number, number];
  count: [number, number, number];
  cells: Map<number, number[]>;
};

/**
 * Triangles of shells with a partner, each entered in every cell it passes
 * within `slack` of. A triangle outside every partner's bounds cannot touch a
 * partner, so it is left out.
 */
function triangleGrid({ points, corners, shells, bounds }: ClosedShells, partners: Map<number, Set<number>>, slack: number): TriangleGrid {
  const entered: number[] = [];
  const box = new Float64Array(6);
  let extent = 0;
  const lows = [Infinity, Infinity, Infinity], highs = [-Infinity, -Infinity, -Infinity];
  for (const [shell, others] of partners) {
    const nearby = partnerBins(bounds, shell, others, slack);
    for (const t of shells[shell]) {
      triangleBox(points, corners, t, box);
      let near = false;
      for (const other of nearby.around(box)) {
        const o = 6 * other;
        if (box[0] <= bounds[o + 3] + slack && box[3] >= bounds[o] - slack
          && box[1] <= bounds[o + 4] + slack && box[4] >= bounds[o + 1] - slack
          && box[2] <= bounds[o + 5] + slack && box[5] >= bounds[o + 2] - slack) { near = true; break; }
      }
      if (!near) continue;
      entered.push(t);
      extent += Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
      for (let axis = 0; axis < 3; axis += 1) {
        lows[axis] = Math.min(lows[axis], box[axis] - slack);
        highs[axis] = Math.max(highs[axis], box[axis + 3] + slack);
      }
    }
  }
  const origin: [number, number, number] = [lows[0], lows[1], lows[2]];
  const size: [number, number, number] = [1, 1, 1];
  const count: [number, number, number] = [1, 1, 1];
  const cells = new Map<number, number[]>();
  if (!entered.length) return { origin, size, count, cells };
  // Cells about as wide as an average triangle: each triangle lands in a few,
  // and each cell holds a few.
  const wanted = Math.max(extent / entered.length, slack * 4, Number.MIN_VALUE);
  for (let axis = 0; axis < 3; axis += 1) {
    const span = Math.max(highs[axis] - lows[axis], slack);
    count[axis] = Math.max(1, Math.min(MAX_CELLS_PER_AXIS, Math.ceil(span / wanted)));
    size[axis] = span / count[axis];
  }
  const half = [size[0] / 2, size[1] / 2, size[2] / 2];
  for (const t of entered) {
    triangleBox(points, corners, t, box);
    const i0 = cellIndex(origin, size, count, 0, box[0] - slack), i1 = cellIndex(origin, size, count, 0, box[3] + slack);
    const j0 = cellIndex(origin, size, count, 1, box[1] - slack), j1 = cellIndex(origin, size, count, 1, box[4] + slack);
    const k0 = cellIndex(origin, size, count, 2, box[2] - slack), k1 = cellIndex(origin, size, count, 2, box[5] + slack);
    const many = (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 8;
    const plane = many ? trianglePlane(points, corners, t) : null;
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        for (let k = k0; k <= k1; k += 1) {
          if (plane) {
            // A large triangle passes through only a sheet of the cells its bounds cover.
            const cx = origin[0] + (i + 0.5) * size[0], cy = origin[1] + (j + 0.5) * size[1], cz = origin[2] + (k + 0.5) * size[2];
            const [nx, ny, nz, d] = plane;
            const reach = Math.abs(nx) * half[0] + Math.abs(ny) * half[1] + Math.abs(nz) * half[2] + slack;
            if (Math.abs(nx * cx + ny * cy + nz * cz - d) > reach) continue;
          }
          const key = i + count[0] * (j + count[1] * k);
          const cell = cells.get(key);
          if (cell) cell.push(t);
          else cells.set(key, [t]);
        }
      }
    }
  }
  return { origin, size, count, cells };
}

/**
 * A shell's partners binned over its own bounds, so each of its triangles is
 * compared with the few partners near it rather than all of them: a plate
 * with hundreds of parts resting on it would otherwise cost its triangle count
 * times theirs.
 */
function partnerBins(bounds: Float64Array, shell: number, others: Set<number>, slack: number) {
  const list = [...others];
  const s = 6 * shell;
  const perAxis = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(list.length))));
  const low = [bounds[s] - slack, bounds[s + 1] - slack, bounds[s + 2] - slack];
  const span = [0, 1, 2].map((axis) => Math.max(bounds[s + 3 + axis] + slack - low[axis], Number.MIN_VALUE));
  const bin = (axis: number, value: number) => Math.max(0, Math.min(perAxis - 1, Math.floor(((value - low[axis]) / span[axis]) * perAxis)));
  const cells = new Map<number, number[]>();
  if (list.length > 4) {
    for (const other of list) {
      const o = 6 * other;
      for (let i = bin(0, bounds[o] - slack); i <= bin(0, bounds[o + 3] + slack); i += 1) {
        for (let j = bin(1, bounds[o + 1] - slack); j <= bin(1, bounds[o + 4] + slack); j += 1) {
          for (let k = bin(2, bounds[o + 2] - slack); k <= bin(2, bounds[o + 5] + slack); k += 1) {
            const key = i + perAxis * (j + perAxis * k);
            const cell = cells.get(key);
            if (cell) cell.push(other);
            else cells.set(key, [other]);
          }
        }
      }
    }
  }
  return {
    /** Partners whose bounds may meet `box`; a partner can be listed twice. */
    around(box: Float64Array): number[] {
      if (list.length <= 4) return list;
      const found: number[] = [];
      for (let i = bin(0, box[0]); i <= bin(0, box[3]); i += 1) {
        for (let j = bin(1, box[1]); j <= bin(1, box[4]); j += 1) {
          for (let k = bin(2, box[2]); k <= bin(2, box[5]); k += 1) {
            const cell = cells.get(i + perAxis * (j + perAxis * k));
            if (cell) found.push(...cell);
          }
        }
      }
      return found;
    },
  };
}

function cellIndex(origin: number[], size: number[], count: number[], axis: number, value: number) {
  return Math.max(0, Math.min(count[axis] - 1, Math.floor((value - origin[axis]) / size[axis])));
}

function triangleBox(points: Float64Array, corners: Int32Array, t: number, out: Float64Array) {
  out[0] = out[1] = out[2] = Infinity;
  out[3] = out[4] = out[5] = -Infinity;
  for (let k = 0; k < 3; k += 1) {
    const p = 3 * corners[3 * t + k];
    for (let axis = 0; axis < 3; axis += 1) {
      out[axis] = Math.min(out[axis], points[p + axis]);
      out[axis + 3] = Math.max(out[axis + 3], points[p + axis]);
    }
  }
}

/** Unit normal and offset of a triangle's plane, or `null` for a sliver. */
function trianglePlane(points: Float64Array, corners: Int32Array, t: number): [number, number, number, number] | null {
  const a = 3 * corners[3 * t], b = 3 * corners[3 * t + 1], c = 3 * corners[3 * t + 2];
  const ux = points[b] - points[a], uy = points[b + 1] - points[a + 1], uz = points[b + 2] - points[a + 2];
  const vx = points[c] - points[a], vy = points[c + 1] - points[a + 1], vz = points[c + 2] - points[a + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0)) return null;
  nx /= length; ny /= length; nz /= length;
  return [nx, ny, nz, nx * points[a] + ny * points[a + 1] + nz * points[a + 2]];
}

type Vec = [number, number, number];

function corner(points: Float64Array, corners: Int32Array, t: number, k: number): Vec {
  const p = 3 * corners[3 * t + k];
  return [points[p], points[p + 1], points[p + 2]];
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Whether two triangles of different shells cross, merely touch (come within
 * `slack`), or stay apart.
 */
function triangleContact({ points, corners }: ClosedShells, s: number, t: number, slack: number): "none" | "touch" | "cross" {
  const p = [corner(points, corners, s, 0), corner(points, corners, s, 1), corner(points, corners, s, 2)];
  const q = [corner(points, corners, t, 0), corner(points, corners, t, 1), corner(points, corners, t, 2)];
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.min(p[0][axis], p[1][axis], p[2][axis]) > Math.max(q[0][axis], q[1][axis], q[2][axis]) + slack) return "none";
    if (Math.min(q[0][axis], q[1][axis], q[2][axis]) > Math.max(p[0][axis], p[1][axis], p[2][axis]) + slack) return "none";
  }
  for (let k = 0; k < 3; k += 1) {
    if (edgeCrossesFace(p[k], p[(k + 1) % 3], q, slack) || edgeCrossesFace(q[k], q[(k + 1) % 3], p, slack)) return "cross";
  }
  const reach = slack * slack;
  for (let k = 0; k < 3; k += 1) {
    if (pointTriangleDistanceSq(p[k], q) <= reach || pointTriangleDistanceSq(q[k], p) <= reach) return "touch";
    for (let m = 0; m < 3; m += 1) {
      if (segmentDistanceSq(p[k], p[(k + 1) % 3], q[m], q[(m + 1) % 3]) <= reach) return "touch";
    }
  }
  for (let k = 0; k < 3; k += 1) {
    if (segmentMeetsTriangle(p[k], p[(k + 1) % 3], q) || segmentMeetsTriangle(q[k], q[(k + 1) % 3], p)) return "touch";
  }
  return "none";
}

/**
 * Whether the edge from `e0` to `e1` passes through the face of `tri`
 * transversally: its ends more than `slack` either side of the face's plane,
 * and the point where it passes more than `slack` inside every edge of the
 * face, where the face is flat. A surface crossing another there has area on
 * both sides of it.
 */
function edgeCrossesFace(e0: Vec, e1: Vec, tri: Vec[], slack: number) {
  const u = sub(tri[1], tri[0]), v = sub(tri[2], tri[0]);
  const normal = cross(u, v);
  const length = Math.hypot(...normal);
  if (!(length > 0)) return false;
  const n: Vec = [normal[0] / length, normal[1] / length, normal[2] / length];
  const d0 = dot(n, sub(e0, tri[0])), d1 = dot(n, sub(e1, tri[0]));
  if (!((d0 < -slack && d1 > slack) || (d0 > slack && d1 < -slack))) return false;
  const f = d0 / (d0 - d1);
  const at: Vec = [e0[0] + (e1[0] - e0[0]) * f, e0[1] + (e1[1] - e0[1]) * f, e0[2] + (e1[2] - e0[2]) * f];
  for (let k = 0; k < 3; k += 1) {
    const a = tri[k], b = tri[(k + 1) % 3];
    const edge = sub(b, a);
    const edgeLength = Math.hypot(...edge);
    if (!(edgeLength > 0)) return false;
    if (dot(cross(edge, sub(at, a)), n) / edgeLength <= slack) return false;
  }
  return true;
}

/** Whether the segment touches the triangle at all, by Möller-Trumbore over its length. */
function segmentMeetsTriangle(s0: Vec, s1: Vec, tri: Vec[]) {
  const direction = sub(s1, s0);
  const e1 = sub(tri[1], tri[0]), e2 = sub(tri[2], tri[0]);
  const h = cross(direction, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-300) return false;
  const inv = 1 / det;
  const s = sub(s0, tri[0]);
  const u = dot(s, h) * inv;
  if (u < 0 || u > 1) return false;
  const q = cross(s, e1);
  const v = dot(direction, q) * inv;
  if (v < 0 || u + v > 1) return false;
  const along = dot(e2, q) * inv;
  return along >= 0 && along <= 1;
}

/** Squared distance from a point to a triangle (Ericson, Real-Time Collision Detection, 5.1.5). */
function pointTriangleDistanceSq(p: Vec, [a, b, c]: Vec[]) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let closest: Vec;
  if (d1 <= 0 && d2 <= 0) closest = a;
  else {
    const bp = sub(p, b);
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) closest = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const w = d1 / (d1 - d3);
        closest = [a[0] + w * ab[0], a[1] + w * ab[1], a[2] + w * ab[2]];
      } else {
        const cp = sub(p, c);
        const d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) closest = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            closest = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              closest = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              closest = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
            }
          }
        }
      }
    }
  }
  const d = sub(p, closest);
  return dot(d, d);
}

/** Squared distance between two segments (Ericson, 5.1.9). */
function segmentDistanceSq(p1: Vec, q1: Vec, p2: Vec, q2: Vec) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 0 && e <= 0) { s = 0; t = 0; }
  else if (a <= 0) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= 0) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1: Vec = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: Vec = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const d = sub(c1, c2);
  return dot(d, d);
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

type ColumnGrid = { lowU: number; lowV: number; size: number; count: number; cells: Map<number, number[]> };

/** Which side of a shell's surface points of another shell lie on. */
class SideClassifier {
  private readonly columns = new Map<number, ColumnGrid>();
  private readonly visited: Int32Array;
  private stamp = 0;

  constructor(private readonly input: ClosedShells, private readonly grid: TriangleGrid, private readonly slack: number) {
    this.visited = new Int32Array(input.shellOf.length);
  }

  /**
   * Whether `shell`'s surface has area strictly inside `other`, and strictly
   * outside it. `touching` are its triangles that come within `slack` of
   * `other`: each is sampled, and each connected patch of the rest -- which
   * cannot pass from one side to the other without touching -- is classified
   * from one of its triangles.
   */
  sides(shell: number, other: number, touching: Set<number>): Sides {
    const sides: Sides = { inside: false, outside: false };
    const { points, corners, neighbours } = this.input;
    const note = (inside: boolean | null) => {
      if (inside === true) sides.inside = true;
      else if (inside === false) sides.outside = true;
      return sides.inside && sides.outside;
    };
    for (const t of touching) {
      const a = corner(points, corners, t, 0), b = corner(points, corners, t, 1), c = corner(points, corners, t, 2);
      for (const [u, v] of SAMPLES) {
        const w = 1 - u - v;
        const p: Vec = [w * a[0] + u * b[0] + v * c[0], w * a[1] + u * b[1] + v * c[1], w * a[2] + u * b[2] + v * c[2]];
        if (this.beyondBounds(p, other)) {
          if (note(false)) return sides;
          continue;
        }
        if (this.nearSurface(p, other)) continue;
        if (note(this.inside(p, other))) return sides;
      }
    }
    // Only the part of this shell within the other's bounds can be inside it.
    // A corner beyond those bounds is outside, and so is every patch that
    // reaches one; flooding stops there instead of crossing the whole shell,
    // which made a plate with hundreds of parts resting on it quadratic.
    const { bounds } = this.input;
    const s = 6 * shell, o = 6 * other, slack = this.slack;
    for (let axis = 0; axis < 3; axis += 1) {
      if (bounds[s + axis] < bounds[o + axis] - slack || bounds[s + 3 + axis] > bounds[o + 3 + axis] + slack) {
        if (note(false)) return sides;
        break;
      }
    }
    const region = this.trianglesNear(shell, other);
    const regionStamp = this.stamp;
    this.stamp += 1;
    for (const seed of region) {
      if (touching.has(seed) || this.visited[seed] === this.stamp) continue;
      const patch = [seed];
      this.visited[seed] = this.stamp;
      let leavesRegion = false;
      for (let at = 0; at < patch.length && !leavesRegion; at += 1) {
        for (let k = 0; k < 3; k += 1) {
          const next = neighbours[3 * patch[at] + k];
          if (next < 0 || touching.has(next) || this.visited[next] === this.stamp) continue;
          if (this.visited[next] !== regionStamp) { leavesRegion = true; break; }
          this.visited[next] = this.stamp;
          patch.push(next);
        }
      }
      if (leavesRegion) {
        if (note(false)) return sides;
        continue;
      }
      // One clean ray settles the patch; a ray grazing an edge is retried from another triangle.
      for (const t of patch) {
        const a = corner(points, corners, t, 0), b = corner(points, corners, t, 1), c = corner(points, corners, t, 2);
        const inside = this.inside([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], other);
        if (inside === null) continue;
        if (note(inside)) return sides;
        break;
      }
    }
    return sides;
  }

  /**
   * The triangles of `shell` whose bounds meet `other`'s, found through the
   * grid cells both shells' bounds share, and marked with a fresh stamp.
   */
  private trianglesNear(shell: number, other: number) {
    const { origin, size, count, cells } = this.grid;
    const { points, corners, shellOf, bounds } = this.input;
    const slack = this.slack, s = 6 * shell, o = 6 * other;
    const low = [0, 1, 2].map((axis) => Math.max(bounds[s + axis], bounds[o + axis]) - slack);
    const high = [0, 1, 2].map((axis) => Math.min(bounds[s + 3 + axis], bounds[o + 3 + axis]) + slack);
    this.stamp += 1;
    const found: number[] = [];
    if (low[0] > high[0] || low[1] > high[1] || low[2] > high[2]) return found;
    const box = new Float64Array(6);
    const i0 = cellIndex(origin, size, count, 0, low[0]), i1 = cellIndex(origin, size, count, 0, high[0]);
    const j0 = cellIndex(origin, size, count, 1, low[1]), j1 = cellIndex(origin, size, count, 1, high[1]);
    const k0 = cellIndex(origin, size, count, 2, low[2]), k1 = cellIndex(origin, size, count, 2, high[2]);
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        for (let k = k0; k <= k1; k += 1) {
          for (const t of cells.get(i + count[0] * (j + count[1] * k)) ?? []) {
            if (shellOf[t] !== shell || this.visited[t] === this.stamp) continue;
            triangleBox(points, corners, t, box);
            if (box[0] > high[0] || box[1] > high[1] || box[2] > high[2] || box[3] < low[0] || box[4] < low[1] || box[5] < low[2]) continue;
            this.visited[t] = this.stamp;
            found.push(t);
          }
        }
      }
    }
    return found;
  }

  /** Whether `p` lies more than `slack` outside `shell`'s bounds, and so outside it. */
  private beyondBounds(p: Vec, shell: number) {
    const b = 6 * shell, bounds = this.input.bounds, slack = this.slack;
    for (let axis = 0; axis < 3; axis += 1) {
      if (p[axis] < bounds[b + axis] - slack || p[axis] > bounds[b + 3 + axis] + slack) return true;
    }
    return false;
  }

  /** Whether `p` lies within `slack` of `shell`'s surface. */
  private nearSurface(p: Vec, shell: number) {
    const { origin, size, count, cells } = this.grid;
    const { points, corners, shellOf } = this.input;
    const reach = this.slack * this.slack;
    const i0 = cellIndex(origin, size, count, 0, p[0] - this.slack), i1 = cellIndex(origin, size, count, 0, p[0] + this.slack);
    const j0 = cellIndex(origin, size, count, 1, p[1] - this.slack), j1 = cellIndex(origin, size, count, 1, p[1] + this.slack);
    const k0 = cellIndex(origin, size, count, 2, p[2] - this.slack), k1 = cellIndex(origin, size, count, 2, p[2] + this.slack);
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        for (let k = k0; k <= k1; k += 1) {
          for (const t of cells.get(i + count[0] * (j + count[1] * k)) ?? []) {
            if (shellOf[t] !== shell) continue;
            const tri = [corner(points, corners, t, 0), corner(points, corners, t, 1), corner(points, corners, t, 2)];
            if (pointTriangleDistanceSq(p, tri) <= reach) return true;
          }
        }
      }
    }
    return false;
  }

  /** Ray parity of `p` against `shell`, or `null` when the ray grazes an edge and settles nothing. */
  private inside(p: Vec, shell: number): boolean | null {
    // Beyond the shell's bounds is outside it, with no ray to cast.
    const b = 6 * shell, bounds = this.input.bounds;
    for (let axis = 0; axis < 3; axis += 1) {
      if (p[axis] < bounds[b + axis] || p[axis] > bounds[b + 3 + axis]) return false;
    }
    const column = this.columnsOf(shell);
    const u = dot(p, ACROSS[0] as Vec), v = dot(p, ACROSS[1] as Vec);
    const i = Math.floor((u - column.lowU) / column.size), j = Math.floor((v - column.lowV) / column.size);
    if (i < 0 || j < 0 || i >= column.count || j >= column.count) return false;
    let crossings = 0;
    for (const t of column.cells.get(i + column.count * j) ?? []) {
      const hit = rayHit(p, this.input.points, this.input.corners, t);
      if (hit === null) return null;
      if (hit) crossings += 1;
    }
    return crossings % 2 === 1;
  }

  /** The shell's triangles binned by where they fall seen along RAY, built once per shell. */
  private columnsOf(shell: number): ColumnGrid {
    const known = this.columns.get(shell);
    if (known) return known;
    const { points, corners } = this.input;
    const triangles = this.input.shells[shell];
    const projected = new Float64Array(triangles.length * 4);
    let lowU = Infinity, lowV = Infinity, highU = -Infinity, highV = -Infinity;
    triangles.forEach((t, index) => {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (let k = 0; k < 3; k += 1) {
        const c = corner(points, corners, t, k);
        const u = dot(c, ACROSS[0] as Vec), v = dot(c, ACROSS[1] as Vec);
        u0 = Math.min(u0, u); u1 = Math.max(u1, u);
        v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      projected.set([u0, v0, u1, v1], 4 * index);
      lowU = Math.min(lowU, u0); highU = Math.max(highU, u1);
      lowV = Math.min(lowV, v0); highV = Math.max(highV, v1);
    });
    const count = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(triangles.length))));
    const size = Math.max(highU - lowU, highV - lowV, Number.MIN_VALUE) / count * (1 + 1e-9);
    const cells = new Map<number, number[]>();
    triangles.forEach((t, index) => {
      const i0 = Math.floor((projected[4 * index] - lowU) / size), i1 = Math.min(count - 1, Math.floor((projected[4 * index + 2] - lowU) / size));
      const j0 = Math.floor((projected[4 * index + 1] - lowV) / size), j1 = Math.min(count - 1, Math.floor((projected[4 * index + 3] - lowV) / size));
      for (let i = i0; i <= i1; i += 1) {
        for (let j = j0; j <= j1; j += 1) {
          const key = i + count * j;
          const cell = cells.get(key);
          if (cell) cell.push(t);
          else cells.set(key, [t]);
        }
      }
    });
    const grid = { lowU, lowV, size, count, cells };
    this.columns.set(shell, grid);
    return grid;
  }
}

/** Relative margin inside which a ray is taken to graze a triangle's edge. */
const GRAZE = 1e-9;

/** Möller-Trumbore along RAY from `p`: a hit ahead of `p`, a miss, or `null` for a ray through an edge or corner. */
function rayHit(p: Vec, points: Float64Array, corners: Int32Array, t: number): boolean | null {
  const a = corner(points, corners, t, 0);
  const e1 = sub(corner(points, corners, t, 1), a), e2 = sub(corner(points, corners, t, 2), a);
  const h = cross(RAY as unknown as Vec, e2);
  const det = dot(e1, h);
  // Seen edge-on: a ray from off the surface cannot pass through it.
  if (Math.abs(det) <= 1e-12 * Math.hypot(...e1) * Math.hypot(...e2)) return false;
  const inv = 1 / det;
  const s = sub(p, a);
  const u = dot(s, h) * inv;
  const q = cross(s, e1);
  const v = dot(RAY as unknown as Vec, q) * inv;
  if (u < -GRAZE || v < -GRAZE || u + v > 1 + GRAZE) return false;
  const distance = dot(e2, q) * inv;
  if (distance <= 0) return false;
  if (u < GRAZE || v < GRAZE || u + v > 1 - GRAZE) return null;
  return true;
}
