/**
 * A 2D drawing of a triangle mesh by its feature edges (issue #506).
 *
 * A mesh has no curves and no faces bigger than a triangle, so handing it to
 * OCCT's hidden-line removal draws every triangle edge: a 57.6k-triangle part
 * came out as a 9.4 MB SVG after 161 s, its flat faces a dense wireframe and
 * its curved ones solid black. A mesh viewer draws the same mesh with a
 * "crease angle" instead, and so does this:
 *
 * - a **feature edge** is one whose two triangles meet at more than
 *   `featureAngle` degrees, so the triangulation of a flat or gently curved
 *   face disappears and a real corner stays;
 * - a **boundary** edge (one triangle) or a non-manifold one (three or more)
 *   is always drawn;
 * - a **silhouette** edge is a smooth edge where one triangle faces the camera
 *   and the other faces away; it is found per view, which is what gives a
 *   faceted cylinder its outline without its seams.
 *
 * Which of those edges a camera can see is answered by a depth buffer of the
 * whole scene's triangles, sampled along each edge, rather than by the kernel.
 * Everything here is arithmetic on arrays: no kernel, no DOM, testable alone.
 * `serverCadProjection.ts` combines it with the exact solids' drawing.
 */

import { viewUp, type DrawingPolyline, type ViewBasis } from "./cadProjection.js";

/** Below this, the triangulation of a gently curved surface is not drawn. */
export const DEFAULT_FEATURE_ANGLE = 30;

/** Corners of triangles as a flat `[x, y, z, ...]` list, nine numbers per triangle. */
export type TriangleSoup = ArrayLike<number>;

/**
 * A mesh's drawable edges, independent of any view.
 *
 * `always` holds feature, boundary and non-manifold edges; `smooth` holds the
 * rest, with the two triangles' normals oriented consistently, because only a
 * view can tell which of them are silhouettes.
 */
export type MeshEdgeSet = {
  /** Six numbers per edge: both ends. */
  always: Float64Array;
  /** Six numbers per edge: both ends. */
  smooth: Float64Array;
  /** Six numbers per smooth edge: the two adjacent triangles' unit normals. */
  smoothNormals: Float64Array;
  /** Three numbers per always-drawn edge: a normal of a triangle on it, for its depth slope. */
  alwaysNormals: Float64Array;
};

/**
 * Whether a crease angle is one this drawing accepts: a finite number of
 * degrees from 0 (every edge) to 180 (only boundaries and silhouettes).
 */
export function isFeatureAngle(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 180;
}

function soupDiagonal(soup: TriangleSoup) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index + 2 < soup.length; index += 3) {
    const x = soup[index], y = soup[index + 1], z = soup[index + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0;
}

/**
 * The edges of a triangle soup worth drawing at `featureAngle` degrees.
 *
 * Corners are welded on a grid a ten-millionth of the mesh's diagonal wide,
 * which joins the copies of a vertex an STL repeats per triangle without
 * joining two vertices a real model keeps apart. Degenerate triangles carry no
 * normal and contribute no edges.
 */
export function meshEdgeSet(soup: TriangleSoup, featureAngle: number = DEFAULT_FEATURE_ANGLE): MeshEdgeSet {
  const triangleCount = Math.floor(soup.length / 9);
  const quantum = Math.max(soupDiagonal(soup) * 1e-7, 1e-12);
  const vertexIds = new Map<string, number>();
  const vertices: number[] = [];
  const corner = new Int32Array(triangleCount * 3);
  for (let index = 0; index < triangleCount * 3; index += 1) {
    const x = soup[index * 3], y = soup[index * 3 + 1], z = soup[index * 3 + 2];
    const key = `${Math.round(x / quantum)},${Math.round(y / quantum)},${Math.round(z / quantum)}`;
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = vertices.length / 3;
      vertexIds.set(key, id);
      vertices.push(x, y, z);
    }
    corner[index] = id;
  }

  const normals = new Float64Array(triangleCount * 3);
  const valid = new Uint8Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const [a, b, c] = [corner[triangle * 3], corner[triangle * 3 + 1], corner[triangle * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    const ux = vertices[b * 3] - vertices[a * 3], uy = vertices[b * 3 + 1] - vertices[a * 3 + 1], uz = vertices[b * 3 + 2] - vertices[a * 3 + 2];
    const vx = vertices[c * 3] - vertices[a * 3], vy = vertices[c * 3 + 1] - vertices[a * 3 + 1], vz = vertices[c * 3 + 2] - vertices[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) continue;
    normals[triangle * 3] = nx / length;
    normals[triangle * 3 + 1] = ny / length;
    normals[triangle * 3 + 2] = nz / length;
    valid[triangle] = 1;
  }

  // Each undirected edge, with the triangles on it and the direction each one
  // walks it in: consistently wound neighbours walk a shared edge oppositely.
  const vertexCount = vertices.length / 3;
  const edges = new Map<number, { from: number; to: number; triangles: number[]; forward: boolean[] }>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (!valid[triangle]) continue;
    for (let side = 0; side < 3; side += 1) {
      const from = corner[triangle * 3 + side];
      const to = corner[triangle * 3 + ((side + 1) % 3)];
      const low = Math.min(from, to), high = Math.max(from, to);
      const key = low * vertexCount + high;
      let edge = edges.get(key);
      if (!edge) {
        edge = { from: low, to: high, triangles: [], forward: [] };
        edges.set(key, edge);
      }
      edge.triangles.push(triangle);
      edge.forward.push(from === low);
    }
  }

  const cosine = Math.cos((featureAngle * Math.PI) / 180);
  const always: number[] = [];
  const alwaysNormals: number[] = [];
  const smooth: number[] = [];
  const smoothNormals: number[] = [];
  const ends = (edge: { from: number; to: number }) => [
    vertices[edge.from * 3], vertices[edge.from * 3 + 1], vertices[edge.from * 3 + 2],
    vertices[edge.to * 3], vertices[edge.to * 3 + 1], vertices[edge.to * 3 + 2],
  ];
  for (const edge of edges.values()) {
    const first = edge.triangles[0];
    const n1 = [normals[first * 3], normals[first * 3 + 1], normals[first * 3 + 2]];
    if (edge.triangles.length !== 2) {
      always.push(...ends(edge));
      alwaysNormals.push(...n1);
      continue;
    }
    const second = edge.triangles[1];
    // A neighbour wound the same way round the edge is wound inconsistently;
    // turning its normal over is what makes a flat face read as flat.
    const flip = edge.forward[0] === edge.forward[1] ? -1 : 1;
    const n2 = [normals[second * 3] * flip, normals[second * 3 + 1] * flip, normals[second * 3 + 2] * flip];
    const alignment = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    // Strictly greater than the angle, so at 0 degrees every edge that is not
    // exactly flat is drawn.
    if (alignment < cosine - 1e-12) {
      always.push(...ends(edge));
      alwaysNormals.push(...n1);
    } else {
      smooth.push(...ends(edge));
      smoothNormals.push(...n1, ...n2);
    }
  }
  return {
    always: Float64Array.from(always),
    alwaysNormals: Float64Array.from(alwaysNormals),
    smooth: Float64Array.from(smooth),
    smoothNormals: Float64Array.from(smoothNormals),
  };
}

// --- the view ----------------------------------------------------------------

/** The pixel grid a view's depth buffers share. */
export type ViewRaster = {
  basis: ViewBasis;
  minU: number;
  minV: number;
  /** Model units per pixel. */
  pixel: number;
  width: number;
  height: number;
  /** How far in front an occluder must be, in model units, before it hides anything. */
  tolerance: number;
};

/**
 * Per pixel, the nearest surface's distance toward the camera, or -Infinity
 * where nothing is drawn.
 */
export type DepthBuffer = { raster: ViewRaster; closeness: Float32Array };

const RASTER_RESOLUTION = 1024;
const MAX_SLOPE = 20;

function projector(basis: ViewBasis) {
  const up = viewUp(basis);
  const { right, toward } = basis;
  return (x: number, y: number, z: number) => [
    x * right.x + y * right.y + z * right.z,
    x * up.x + y * up.y + z * up.z,
    x * toward.x + y * toward.y + z * toward.z,
  ] as const;
}

/**
 * The pixel grid covering every soup and every extra 2D point in the view,
 * a thousand and twenty-four pixels across its longer side.
 */
export function viewRaster(basis: ViewBasis, soups: readonly TriangleSoup[], points: readonly DrawingPolyline[] = []): ViewRaster {
  const project = projector(basis);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, diagonal = 0;
  for (const soup of soups) {
    diagonal = Math.max(diagonal, soupDiagonal(soup));
    for (let index = 0; index + 2 < soup.length; index += 3) {
      const [u, v] = project(soup[index], soup[index + 1], soup[index + 2]);
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  for (const line of points) {
    for (let index = 0; index + 1 < line.length; index += 2) {
      if (line[index] < minU) minU = line[index]; if (line[index] > maxU) maxU = line[index];
      if (line[index + 1] < minV) minV = line[index + 1]; if (line[index + 1] > maxV) maxV = line[index + 1];
    }
  }
  if (!Number.isFinite(minU)) { minU = maxU = minV = maxV = 0; }
  const range = Math.max(maxU - minU, maxV - minV, 1e-9);
  const pixel = range / RASTER_RESOLUTION;
  const margin = 2 * pixel;
  diagonal = Math.max(diagonal, range);
  return {
    basis,
    minU: minU - margin,
    minV: minV - margin,
    pixel,
    width: Math.ceil((maxU - minU) / pixel) + 5,
    height: Math.ceil((maxV - minV) / pixel) + 5,
    tolerance: diagonal * 0.002 + pixel,
  };
}

/** The soups rasterised into one depth buffer on `raster`. */
export function depthBuffer(raster: ViewRaster, soups: readonly TriangleSoup[]): DepthBuffer {
  const { width, height, minU, minV, pixel } = raster;
  const closeness = new Float32Array(width * height).fill(-Infinity);
  const project = projector(raster.basis);
  for (const soup of soups) {
    for (let index = 0; index + 8 < soup.length; index += 9) {
      const a = project(soup[index], soup[index + 1], soup[index + 2]);
      const b = project(soup[index + 3], soup[index + 4], soup[index + 5]);
      const c = project(soup[index + 6], soup[index + 7], soup[index + 8]);
      // Into pixel coordinates, pixel centres at half-integers.
      const ax = (a[0] - minU) / pixel, ay = (a[1] - minV) / pixel;
      const bx = (b[0] - minU) / pixel, by = (b[1] - minV) / pixel;
      const cx = (c[0] - minU) / pixel, cy = (c[1] - minV) / pixel;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y += 1) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x += 1) {
          const px = x + 0.5;
          const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
          const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
          const wc = 1 - wa - wb;
          if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
          const depth = wa * a[2] + wb * b[2] + wc * c[2];
          const at = y * width + x;
          if (depth > closeness[at]) closeness[at] = depth;
        }
      }
    }
  }
  return { raster, closeness };
}

/**
 * The surface a point would have to be behind to be hidden: the farthest of
 * the covered pixels around it, or nothing when the pixel itself is empty.
 *
 * Taking the farthest neighbour is what keeps an edge from being hidden by
 * the very faces it bounds -- a pixel centre beside a steep face, or across a
 * silhouette, reads nearer than the edge itself.
 */
function occluderAt(buffer: DepthBuffer, u: number, v: number) {
  const { raster, closeness } = buffer;
  const x = Math.floor((u - raster.minU) / raster.pixel);
  const y = Math.floor((v - raster.minV) / raster.pixel);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return -Infinity;
  if (closeness[y * raster.width + x] === -Infinity) return -Infinity;
  let farthest = Infinity;
  for (let dy = -1; dy <= 1; dy += 1) {
    const row = y + dy;
    if (row < 0 || row >= raster.height) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      const column = x + dx;
      if (column < 0 || column >= raster.width) continue;
      const value = closeness[row * raster.width + column];
      if (value !== -Infinity && value < farthest) farthest = value;
    }
  }
  return farthest;
}

/** The nearest covered surface around a point, or -Infinity when none is. */
function nearestAt(buffer: DepthBuffer, u: number, v: number) {
  const { raster, closeness } = buffer;
  const x = Math.floor((u - raster.minU) / raster.pixel);
  const y = Math.floor((v - raster.minV) / raster.pixel);
  let nearest = -Infinity;
  for (let dy = -1; dy <= 1; dy += 1) {
    const row = y + dy;
    if (row < 0 || row >= raster.height) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      const column = x + dx;
      if (column < 0 || column >= raster.width) continue;
      const value = closeness[row * raster.width + column];
      if (value > nearest) nearest = value;
    }
  }
  return nearest;
}

/** Runs shorter than this many samples (pixels of a 1024-pixel view) take their neighbours' visibility. */
const MIN_RUN = 6;

/**
 * A segment split into visible and hidden straight runs by `hiddenAt`, which
 * answers for a parameter along it. Specks shorter than a few pixels -- where
 * an edge passes within the tolerance of a surface, as a hidden edge does at
 * the silhouette vertex it runs into -- join the run beside them.
 */
function splitSegment(
  u0: number, v0: number, u1: number, v1: number,
  pixel: number,
  hiddenAt: (t: number) => boolean,
  visible: DrawingPolyline[],
  hidden: DrawingPolyline[],
) {
  const samples = Math.min(4096, Math.max(2, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / pixel) + 1));
  const states: boolean[] = [];
  for (let index = 0; index < samples; index += 1) states.push(hiddenAt(index / (samples - 1)));
  // Run-length encode, then fold specks into the run before them (or after,
  // for a speck at the start).
  const runs: Array<{ hidden: boolean; start: number; end: number }> = [];
  for (let index = 0; index < samples; index += 1) {
    const last = runs[runs.length - 1];
    if (last && last.hidden === states[index]) last.end = index;
    else runs.push({ hidden: states[index], start: index, end: index });
  }
  for (let changed = true; changed && runs.length > 1;) {
    changed = false;
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      if (run.end - run.start + 1 >= MIN_RUN) continue;
      const neighbour = index > 0 ? runs[index - 1] : runs[index + 1];
      neighbour.start = Math.min(neighbour.start, run.start);
      neighbour.end = Math.max(neighbour.end, run.end);
      runs.splice(index, 1);
      // Two runs of one kind that now touch become one.
      for (let merge = 1; merge < runs.length; merge += 1) {
        if (runs[merge].hidden === runs[merge - 1].hidden) {
          runs[merge - 1].end = runs[merge].end;
          runs.splice(merge, 1);
          merge -= 1;
        }
      }
      changed = true;
      break;
    }
  }
  for (const run of runs) {
    const t0 = run.start / (samples - 1);
    const t1 = run.end / (samples - 1);
    if (t1 <= t0) continue;
    const line = [u0 + (u1 - u0) * t0, v0 + (v1 - v0) * t0, u0 + (u1 - u0) * t1, v0 + (v1 - v0) * t1];
    (run.hidden ? hidden : visible).push(line);
  }
}

/**
 * How steeply a surface with this normal recedes per model unit across the
 * screen, capped: an edge-on face would otherwise ask for infinite tolerance.
 */
function slopeOf(project: ReturnType<typeof projector>, nx: number, ny: number, nz: number) {
  const [nu, nv, nc] = project(nx, ny, nz);
  if (Math.abs(nc) < 1 / MAX_SLOPE) return MAX_SLOPE;
  return Math.min(MAX_SLOPE, Math.hypot(nu, nv) / Math.abs(nc));
}

/**
 * The mesh's edges as this view draws them, split into what the camera sees
 * and what the scene in `occluders` hides.
 */
export function drawMeshEdges(edgeSet: MeshEdgeSet, occluders: readonly DepthBuffer[], raster: ViewRaster) {
  const project = projector(raster.basis);
  const { toward } = raster.basis;
  const visible: DrawingPolyline[] = [];
  const hidden: DrawingPolyline[] = [];
  const draw = (ends: Float64Array, offset: number, slope: number) => {
    const [u0, v0, c0] = project(ends[offset], ends[offset + 1], ends[offset + 2]);
    const [u1, v1, c1] = project(ends[offset + 3], ends[offset + 4], ends[offset + 5]);
    // Seen end on, an edge is a point and draws nothing.
    if (Math.hypot(u1 - u0, v1 - v0) < raster.pixel * 1e-3) return;
    const tolerance = raster.tolerance + 2 * raster.pixel * slope;
    splitSegment(u0, v0, u1, v1, raster.pixel, (t) => {
      const u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t, c = c0 + (c1 - c0) * t;
      return occluders.some((buffer) => occluderAt(buffer, u, v) > c + tolerance);
    }, visible, hidden);
  };
  for (let edge = 0; edge * 6 < edgeSet.always.length; edge += 1) {
    const n = edgeSet.alwaysNormals;
    draw(edgeSet.always, edge * 6, slopeOf(project, n[edge * 3], n[edge * 3 + 1], n[edge * 3 + 2]));
  }
  for (let edge = 0; edge * 6 < edgeSet.smooth.length; edge += 1) {
    const n = edgeSet.smoothNormals;
    const first = n[edge * 6] * toward.x + n[edge * 6 + 1] * toward.y + n[edge * 6 + 2] * toward.z;
    const second = n[edge * 6 + 3] * toward.x + n[edge * 6 + 4] * toward.y + n[edge * 6 + 5] * toward.z;
    if ((first > 0) === (second > 0)) continue;
    draw(edgeSet.smooth, edge * 6, MAX_SLOPE);
  }
  return { visible, hidden };
}

/**
 * Exact-solid edges the kernel drew as visible, with the stretches a mesh
 * stands in front of moved to `hidden`.
 *
 * The kernel's hidden-line removal never saw the meshes, and its 2D output
 * has no depth, so a point's depth is read back off the exact solids' own
 * buffer: a visible edge lies on the nearest exact surface at that point.
 */
export function occludeByMeshes(
  lines: readonly DrawingPolyline[],
  own: DepthBuffer,
  meshes: DepthBuffer,
  visible: DrawingPolyline[],
  hidden: DrawingPolyline[],
) {
  const { raster } = own;
  const tolerance = raster.tolerance + 2 * raster.pixel;
  for (const line of lines) {
    const seen: DrawingPolyline[] = [];
    const behind: DrawingPolyline[] = [];
    for (let index = 0; index + 3 < line.length; index += 2) {
      const u0 = line[index], v0 = line[index + 1], u1 = line[index + 2], v1 = line[index + 3];
      splitSegment(u0, v0, u1, v1, raster.pixel, (t) => {
        const u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
        const depth = nearestAt(own, u, v);
        return depth !== -Infinity && occluderAt(meshes, u, v) > depth + tolerance;
      }, seen, behind);
    }
    // A line nothing hides keeps its own vertices rather than one stroke per segment.
    if (!behind.length) visible.push(line);
    else { visible.push(...seen); hidden.push(...behind); }
  }
}
