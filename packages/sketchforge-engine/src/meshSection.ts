/**
 * Section contours of a triangle mesh, cut by one axis-aligned plane, with no
 * kernel in it.
 *
 * A shape described only by its triangles used to be sewn into an OCCT solid
 * and sectioned by the exact kernel. Sewing is the expensive half -- a
 * 50,000-triangle box took most of three minutes -- and buys nothing, because
 * the solid OCCT sews is the same piecewise-flat surface, so its section is the
 * same polyline this computes directly. Here each triangle the plane crosses
 * contributes one segment, and segments are joined into loops through the edge
 * they cross, which two neighbouring triangles share. It is linear in the
 * number of triangles and handles millions of them.
 *
 * A vertex lying exactly on the plane is counted as above it (a symbolic
 * perturbation), so every crossing is on exactly one edge, and a closed mesh
 * gives closed loops even where the plane passes through its vertices or along
 * its faces.
 */

export type MeshSectionAxis = 0 | 1 | 2;

export type MeshSectionOptions = {
  /** Index of the plane's normal axis in each position triple. */
  normal: MeshSectionAxis;
  /** Indexes of the drawing's u and v axes in each position triple. */
  u: MeshSectionAxis;
  v: MeshSectionAxis;
  /** The plane's coordinate on the normal axis. */
  offset: number;
};

/** Grid a coordinate is welded to when matching the vertices of neighbouring triangles, in model units. */
const WELD = 1e-6;

function vertexKey(positions: ArrayLike<number>, index: number) {
  return `${Math.round(positions[index] / WELD)},${Math.round(positions[index + 1] / WELD)},${Math.round(positions[index + 2] / WELD)}`;
}

function edgeKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

type Crossing = { u: number; v: number };

/**
 * Segments of a triangle soup's section, each as the keys of the two edges it
 * joins and the points where it crosses them.
 */
function sectionSegments(positions: ArrayLike<number>, options: MeshSectionOptions, onPlaneIsAbove: boolean) {
  const { normal, u, v, offset } = options;
  const segments: { from: string; to: string }[] = [];
  const crossings = new Map<string, Crossing>();
  const corner = [0, 0, 0];
  const distance = [0, 0, 0];
  for (let base = 0; base + 8 < positions.length; base += 9) {
    let above = 0;
    for (let k = 0; k < 3; k += 1) {
      corner[k] = base + k * 3;
      distance[k] = positions[corner[k] + normal] - offset;
      if (distance[k] > 0 || (onPlaneIsAbove && distance[k] === 0)) above |= 1 << k;
    }
    if (above === 0 || above === 7) continue;
    const ends: string[] = [];
    for (let k = 0; k < 3; k += 1) {
      const next = (k + 1) % 3;
      if (((above >> k) & 1) === ((above >> next) & 1)) continue;
      const key = edgeKey(vertexKey(positions, corner[k]), vertexKey(positions, corner[next]));
      if (!crossings.has(key)) {
        const t = distance[k] / (distance[k] - distance[next]);
        const a = corner[k];
        const b = corner[next];
        crossings.set(key, {
          u: positions[a + u] + (positions[b + u] - positions[a + u]) * t,
          v: positions[a + v] + (positions[b + v] - positions[a + v]) * t,
        });
      }
      ends.push(key);
    }
    if (ends.length === 2 && ends[0] !== ends[1]) segments.push({ from: ends[0], to: ends[1] });
  }
  return { segments, crossings };
}

/** Join segments that share a crossed edge into polylines, closed where the mesh is. */
function joinSegments(segments: readonly { from: string; to: string }[], crossings: ReadonlyMap<string, Crossing>) {
  const neighbours = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const end of [segment.from, segment.to]) {
      const list = neighbours.get(end);
      if (list) list.push(index);
      else neighbours.set(end, [index]);
    }
  });
  const used = new Uint8Array(segments.length);
  const contours: number[][] = [];
  const nextSegment = (key: string) => neighbours.get(key)?.find((index) => !used[index]);

  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue;
    used[start] = 1;
    // Walk forward from `to`, then backward from `from`, so an open chain is
    // collected whole whichever segment it was entered by.
    const forward = [segments[start].from, segments[start].to];
    for (let index = nextSegment(forward[forward.length - 1]); index !== undefined; index = nextSegment(forward[forward.length - 1])) {
      used[index] = 1;
      const segment = segments[index];
      forward.push(segment.from === forward[forward.length - 1] ? segment.to : segment.from);
    }
    const backward: string[] = [];
    let head = forward[0];
    for (let index = nextSegment(head); index !== undefined; index = nextSegment(head)) {
      used[index] = 1;
      const segment = segments[index];
      head = segment.from === head ? segment.to : segment.from;
      backward.push(head);
    }
    const keys = [...backward.reverse(), ...forward];
    const contour: number[] = [];
    for (const key of keys) {
      const point = crossings.get(key)!;
      const last = contour.length;
      // A crossing at a vertex on the plane repeats its neighbour's point.
      if (last >= 2 && Math.abs(contour[last - 2] - point.u) <= WELD && Math.abs(contour[last - 1] - point.v) <= WELD) continue;
      contour.push(point.u, point.v);
    }
    if (contour.length >= 4) contours.push(contour);
  }
  return contours;
}

/**
 * The polylines where a plane cuts a triangle soup, as [u0, v0, u1, v1, ...].
 *
 * `positions` holds three vertices per triangle. A plane that touches the mesh
 * only along its lowest faces, where counting on-plane vertices as above it
 * leaves nothing crossing, is retried with them counted as below, so the
 * section at either end of a solid is its outline, as the exact kernel draws it.
 */
export function sectionTriangleSoup(positions: ArrayLike<number>, options: MeshSectionOptions): number[][] {
  let result = sectionSegments(positions, options, true);
  if (!result.segments.length) result = sectionSegments(positions, options, false);
  return joinSegments(result.segments, result.crossings);
}
