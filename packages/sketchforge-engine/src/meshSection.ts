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
 * its faces. That cut is taken just below the plane, so it misses a face lying
 * on the plane and facing down -- the underside of a ledge. When any vertex is
 * on the plane the mesh is cut again with them counted as below, which is the
 * cut just above, and the loops that cut adds are kept too. Between them they
 * draw every edge of every face on the plane, as the exact kernel does.
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

/**
 * Where a segment crosses an edge, and what identifies that point in either
 * cut: the vertex, when it lies on the plane, or else the edge itself.
 */
type Crossing = { u: number; v: number; point: string };

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
  let touches = false;
  for (let base = 0; base + 8 < positions.length; base += 9) {
    let above = 0;
    for (let k = 0; k < 3; k += 1) {
      corner[k] = base + k * 3;
      distance[k] = positions[corner[k] + normal] - offset;
      if (distance[k] === 0) touches = true;
      if (distance[k] > 0 || (onPlaneIsAbove && distance[k] === 0)) above |= 1 << k;
    }
    if (above === 0 || above === 7) continue;
    const ends: string[] = [];
    for (let k = 0; k < 3; k += 1) {
      const next = (k + 1) % 3;
      if (((above >> k) & 1) === ((above >> next) & 1)) continue;
      const from = vertexKey(positions, corner[k]);
      const to = vertexKey(positions, corner[next]);
      const key = edgeKey(from, to);
      if (!crossings.has(key)) {
        const t = distance[k] / (distance[k] - distance[next]);
        const a = corner[k];
        const b = corner[next];
        crossings.set(key, {
          u: positions[a + u] + (positions[b + u] - positions[a + u]) * t,
          v: positions[a + v] + (positions[b + v] - positions[a + v]) * t,
          point: distance[k] === 0 ? from : distance[next] === 0 ? to : key,
        });
      }
      ends.push(key);
    }
    if (ends.length === 2 && ends[0] !== ends[1]) segments.push({ from: ends[0], to: ends[1] });
  }
  return { segments, crossings, touches };
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
  const contours: { contour: number[]; points: string }[] = [];
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
    const points = new Set<string>();
    for (const key of keys) {
      const point = crossings.get(key)!;
      points.add(point.point);
      const last = contour.length;
      // A crossing at a vertex on the plane repeats its neighbour's point.
      if (last >= 2 && Math.abs(contour[last - 2] - point.u) <= WELD && Math.abs(contour[last - 1] - point.v) <= WELD) continue;
      contour.push(point.u, point.v);
    }
    if (contour.length >= 4) contours.push({ contour, points: [...points].sort().join(";") });
  }
  return contours;
}

/**
 * The polylines where a plane cuts a triangle soup, as [u0, v0, u1, v1, ...].
 *
 * `positions` holds three vertices per triangle. Where vertices lie on the
 * plane, the cuts just below and just above it are both taken, and a loop the
 * second adds through the same points as one the first found is dropped. So a
 * plane along a solid's end face draws its outline, and a plane along a face
 * inside it -- the top of a post, the underside of a ledge -- draws that
 * face's edges as well as the walls it crosses.
 */
export function sectionTriangleSoup(positions: ArrayLike<number>, options: MeshSectionOptions): number[][] {
  const below = sectionSegments(positions, options, true);
  const loops = joinSegments(below.segments, below.crossings);
  if (below.touches) {
    const seen = new Set(loops.map((loop) => loop.points));
    const above = sectionSegments(positions, options, false);
    for (const loop of joinSegments(above.segments, above.crossings)) {
      if (!seen.has(loop.points)) loops.push(loop);
    }
  }
  return loops.map((loop) => loop.contour);
}
