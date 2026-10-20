import type { ManifoldToplevel } from "manifold-3d";
import { LocalizedError } from "@/i18n/LocalizedError";
import type { SketchPoint, SketchProfile, SketchRevolveSettings, SketchSegment } from "@/types/sketchforge";
import { MAX_HIGH_RESOLUTION_SIDES } from "@/lib/workplaneSettings";

export const DEFAULT_SKETCH_REVOLVE_SETTINGS: SketchRevolveSettings = {
  startAngle: 0,
  sweepAngle: 360,
  sides: 64,
  quality: 6,
  pitch: 0,
  turns: 1,
};

export const MAX_REVOLVE_TURNS = 20;
export const MAX_REVOLVE_PITCH = 200;

/**
 * Most rings a helical sweep may be built from.
 *
 * Rings cost triangles twice over -- once per profile point, once per step --
 * so a 64-sided, 20-turn sweep of a finely sampled profile can reach millions
 * of triangles and take the editor with it. Past this the sweep is built at a
 * coarser angular step rather than refused: a slightly faceted thread is more
 * use than none.
 */
export const MAX_REVOLVE_RINGS = 2400;

type OrderedStep = { segment: SketchSegment; from: SketchPoint; to: SketchPoint };
type OrderedPath = { steps: OrderedStep[]; closed: boolean };
type Point2 = [number, number];
type SampledPoint = { x: number; z: number };

export type SketchRevolveMesh = {
  positions: number[];
  width: number;
  depth: number;
  height: number;
  triangleCount: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeSketchRevolveSettings(settings?: Partial<SketchRevolveSettings>): SketchRevolveSettings {
  const rawSweep = clamp(finiteOr(settings?.sweepAngle, DEFAULT_SKETCH_REVOLVE_SETTINGS.sweepAngle), -360, 360);
  const sweepAngle = Math.abs(rawSweep) < 1 ? (rawSweep < 0 ? -1 : 1) : rawSweep;
  const pitch = clamp(finiteOr(settings?.pitch, DEFAULT_SKETCH_REVOLVE_SETTINGS.pitch), -MAX_REVOLVE_PITCH, MAX_REVOLVE_PITCH);
  return {
    startAngle: ((finiteOr(settings?.startAngle, DEFAULT_SKETCH_REVOLVE_SETTINGS.startAngle) % 360) + 360) % 360,
    sweepAngle,
    sides: Math.round(clamp(finiteOr(settings?.sides, DEFAULT_SKETCH_REVOLVE_SETTINGS.sides), 3, MAX_HIGH_RESOLUTION_SIDES)),
    quality: Math.round(clamp(finiteOr(settings?.quality, DEFAULT_SKETCH_REVOLVE_SETTINGS.quality), 1, 10)),
    // A pitch too small to see is no pitch: it keeps the plain revolve, whose
    // geometry is both exact and cheaper.
    pitch: Math.abs(pitch) < 1e-6 ? 0 : pitch,
    turns: clamp(finiteOr(settings?.turns, DEFAULT_SKETCH_REVOLVE_SETTINGS.turns), 0.1, MAX_REVOLVE_TURNS),
  };
}

/** Whether these settings describe a helical sweep rather than a plain revolve. */
export function isHelicalRevolve(settings: SketchRevolveSettings) {
  return settings.pitch !== 0;
}

/**
 * How many rings a helical sweep will be built from, and the angle between them.
 *
 * `sides` is per full turn, so the ring count follows the number of turns --
 * up to the ceiling, past which the step opens up instead.
 */
export function helicalRevolveSteps(settings: SketchRevolveSettings) {
  const requested = Math.max(2, Math.round(settings.sides * settings.turns));
  return Math.min(requested, MAX_REVOLVE_RINGS);
}

function orderedPaths(profile: SketchProfile): OrderedPath[] {
  const pointById = new Map(profile.points.map((point) => [point.id, point]));
  const adjacency = new Map<string, Array<{ pointId: string; segment: SketchSegment }>>();
  profile.points.forEach((point) => adjacency.set(point.id, []));
  const validSegments = profile.segments.filter((segment) => {
    if (!pointById.has(segment.startId) || !pointById.has(segment.endId)) return false;
    adjacency.get(segment.startId)?.push({ pointId: segment.endId, segment });
    adjacency.get(segment.endId)?.push({ pointId: segment.startId, segment });
    return true;
  });
  const unvisited = new Set(validSegments.map((segment) => segment.id));
  const paths: OrderedPath[] = [];
  while (unvisited.size > 0) {
    const seed = validSegments.find((segment) => unvisited.has(segment.id));
    if (!seed) break;
    const componentIds = new Set<string>();
    const queue = [seed.startId, seed.endId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id || componentIds.has(id)) continue;
      componentIds.add(id);
      adjacency.get(id)?.forEach((entry) => queue.push(entry.pointId));
    }
    const startId = [...componentIds].find((id) => (adjacency.get(id)?.filter((entry) => unvisited.has(entry.segment.id)).length ?? 0) === 1) ?? seed.startId;
    const steps: OrderedStep[] = [];
    let currentId = startId;
    for (let guard = 0; guard <= validSegments.length; guard += 1) {
      const edge = adjacency.get(currentId)?.find((entry) => unvisited.has(entry.segment.id));
      if (!edge) break;
      const from = pointById.get(currentId);
      const to = pointById.get(edge.pointId);
      if (!from || !to) break;
      unvisited.delete(edge.segment.id);
      steps.push({ segment: edge.segment, from, to });
      currentId = to.id;
      if (currentId === startId) break;
    }
    if (steps.length > 0) paths.push({ steps, closed: currentId === startId && steps.length >= 3 });
  }
  return paths;
}

function cubicPoint(start: SketchPoint, first: { x: number; z: number }, second: { x: number; z: number }, end: SketchPoint, amount: number) {
  const inverse = 1 - amount;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * amount * first.x + 3 * inverse * amount ** 2 * second.x + amount ** 3 * end.x,
    z: inverse ** 3 * start.z + 3 * inverse ** 2 * amount * first.z + 3 * inverse * amount ** 2 * second.z + amount ** 3 * end.z,
  };
}

function samplePath(path: OrderedPath, quality: number) {
  const first = path.steps[0]?.from;
  if (!first) return [];
  const sampled = [{ x: first.x, z: first.z }];
  const curveSamples = 4 + quality * 6;
  path.steps.forEach(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const firstControl = forward ? from.handleOut : from.handleIn;
    const secondControl = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && firstControl && secondControl) {
      for (let index = 1; index <= curveSamples; index += 1) {
        sampled.push(cubicPoint(from, firstControl, secondControl, to, index / curveSamples));
      }
    } else {
      sampled.push({ x: to.x, z: to.z });
    }
  });
  if (path.closed && sampled.length > 1) sampled.pop();
  return sampled;
}

function compactSampledPath(points: SampledPoint[]) {
  const compact: SampledPoint[] = [];
  points.forEach((point) => {
    const previous = compact[compact.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.z - previous.z) > 1e-7) compact.push(point);
  });
  if (compact.length > 2) {
    const first = compact[0];
    const last = compact[compact.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) <= 1e-7) compact.pop();
  }
  return compact;
}

function axisIntersection(from: SampledPoint, to: SampledPoint): SampledPoint {
  const deltaX = to.x - from.x;
  const amount = Math.abs(deltaX) <= 1e-12 ? 0 : clamp(-from.x / deltaX, 0, 1);
  return { x: 0, z: from.z + (to.z - from.z) * amount };
}

function clipClosedPathToRevolveSide(points: SampledPoint[]) {
  if (points.length < 3) return [];
  const clipped: SampledPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    const fromInside = from.x <= 0;
    const toInside = to.x <= 0;
    if (fromInside && toInside) {
      clipped.push(to);
    } else if (fromInside) {
      clipped.push(axisIntersection(from, to));
    } else if (toInside) {
      clipped.push(axisIntersection(from, to), to);
    }
  }
  return compactSampledPath(clipped);
}

function distance(a: Point2, b: Point2) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function compactPolygon(points: Point2[]) {
  const compact: Point2[] = [];
  points.forEach((point) => {
    if (!compact.length || distance(compact[compact.length - 1], point) > 1e-7) compact.push(point);
  });
  if (compact.length > 2 && distance(compact[0], compact[compact.length - 1]) <= 1e-7) compact.pop();
  return compact;
}

export function sketchProfileToRevolvePolygons(profile: SketchProfile, settings?: Partial<SketchRevolveSettings>) {
  const normalized = normalizeSketchRevolveSettings(settings);
  const paths = orderedPaths(profile).filter((path) => path.closed).flatMap((path) => {
    const sampled = samplePath(path, normalized.quality);
    const clipped = clipClosedPathToRevolveSide(sampled);
    return clipped.length >= 3 ? [clipped] : [];
  });
  if (paths.length === 0) return [];
  const maxZ = Math.max(...paths.flatMap((points) => points.map((point) => point.z)));
  const toSectionPoint = (point: SampledPoint): Point2 => [-point.x, maxZ - point.z];
  return paths.flatMap((points) => {
    const sectionPoints = compactPolygon(points.map(toSectionPoint));
    return sectionPoints.length >= 3 ? [sectionPoints] : [];
  });
}

function manifoldMeshPositions(mesh: InstanceType<ManifoldToplevel["Mesh"]>) {
  const positions: number[] = [];
  for (let index = 0; index < mesh.triVerts.length; index += 1) {
    const offset = mesh.triVerts[index] * mesh.numProp;
    positions.push(mesh.vertProperties[offset], mesh.vertProperties[offset + 1], mesh.vertProperties[offset + 2]);
  }
  return positions;
}

function dispose(value: unknown) {
  (value as { delete?: () => void } | null)?.delete?.();
}

/**
 * A helical sweep of the section, as a watertight mesh.
 *
 * Manifold can revolve a cross-section but not sweep one along a helix, so the
 * rings are built here: each step turns the section about the axis and lifts it
 * by its share of the pitch. The walls between consecutive rings are quads, and
 * the two ends are closed with manifold's own triangulator -- which, unlike an
 * ear clip written here, handles a section with holes in it.
 *
 * Returned through `Manifold.ofMesh` rather than as raw triangles, so a mesh
 * that does not close reports itself instead of becoming a boolean's problem
 * later.
 */
function helicalRevolveSolid(
  runtime: ManifoldToplevel,
  polygons: Point2[][],
  settings: SketchRevolveSettings,
) {
  const steps = helicalRevolveSteps(settings);
  const sectionPoints = polygons.flat();
  const pointsPerRing = sectionPoints.length;

  const vertProperties = new Float32Array((steps + 1) * pointsPerRing * 3);
  let vertex = 0;
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const angle = ((settings.startAngle + 360 * settings.turns * progress) * Math.PI) / 180;
    const rise = settings.pitch * settings.turns * progress;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const [radius, axial] of sectionPoints) {
      vertProperties[vertex] = radius * cos;
      vertProperties[vertex + 1] = radius * sin;
      vertProperties[vertex + 2] = axial + rise;
      vertex += 3;
    }
  }

  const caps = runtime.triangulate(polygons);
  const triangles = new Uint32Array((steps * pointsPerRing * 2 + caps.length * 2) * 3);
  let index = 0;
  const pushTriangle = (a: number, b: number, c: number) => {
    triangles[index] = a;
    triangles[index + 1] = b;
    triangles[index + 2] = c;
    index += 3;
  };

  let contourBase = 0;
  for (const contour of polygons) {
    for (let step = 0; step < steps; step += 1) {
      const ring = step * pointsPerRing + contourBase;
      for (let point = 0; point < contour.length; point += 1) {
        const a = ring + point;
        const b = ring + ((point + 1) % contour.length);
        pushTriangle(a, a + pointsPerRing, b);
        pushTriangle(b, a + pointsPerRing, b + pointsPerRing);
      }
    }
    contourBase += contour.length;
  }

  // The start cap faces back down the sweep, so its winding is the reverse of
  // the end cap's.
  const lastRing = steps * pointsPerRing;
  for (const [a, b, c] of caps) {
    pushTriangle(a, b, c);
    pushTriangle(lastRing + c, lastRing + b, lastRing + a);
  }

  const mesh = new runtime.Mesh({ numProp: 3, vertProperties, triVerts: triangles });
  return runtime.Manifold.ofMesh(mesh);
}

export function buildSketchRevolveMesh(runtime: ManifoldToplevel, profile: SketchProfile, requestedSettings?: Partial<SketchRevolveSettings>): SketchRevolveMesh {
  const settings = normalizeSketchRevolveSettings(requestedSettings);
  const polygons = sketchProfileToRevolvePolygons(profile, settings);
  if (polygons.length === 0) throw new LocalizedError("errors.revolve.noProfile");
  const disposable: unknown[] = [];
  try {
    const section = new runtime.CrossSection(polygons, "EvenOdd");
    disposable.push(section);
    const scale = polygons.reduce((largest, polygon) => polygon.reduce((current, point) => Math.max(current, Math.abs(point[0]), Math.abs(point[1])), largest), 1);
    const simplified = section.simplify(Math.max(1e-7, scale * 1e-8));
    disposable.push(simplified);
    if (simplified.toPolygons().length === 0) throw new LocalizedError("errors.revolve.noFilledArea");
    // A helical sweep carries its own start angle, so it skips the rotation the
    // plain revolve applies afterwards.
    if (isHelicalRevolve(settings)) {
      const helical = helicalRevolveSolid(runtime, simplified.toPolygons() as Point2[][], settings);
      disposable.push(helical);
      if (helical.status() !== "NoError" || helical.numTri() < 1) throw new LocalizedError("errors.revolve.invalidSolid");
      return meshFromManifold(helical);
    }

    const sweep = Math.abs(settings.sweepAngle);
    const solid = simplified.revolve(settings.sides, sweep);
    disposable.push(solid);
    const rotation = settings.sweepAngle < 0 ? settings.startAngle + settings.sweepAngle : settings.startAngle;
    const revolved = Math.abs(rotation) > 1e-8 ? solid.rotate([0, 0, rotation]) : solid;
    if (revolved !== solid) disposable.push(revolved);
    if (revolved.status() !== "NoError" || revolved.numTri() < 1) throw new LocalizedError("errors.revolve.invalidSolid");

    return meshFromManifold(revolved);
  } finally {
    [...new Set(disposable)].reverse().forEach(dispose);
  }
}

/**
 * A manifold solid as the editor's own mesh: Y up, centred on X and Z, resting
 * on y = 0.
 *
 * Manifold revolves around its Z axis, which is the editor's Y.
 */
function meshFromManifold(solid: InstanceType<ManifoldToplevel["Manifold"]>): SketchRevolveMesh {
    const manifoldPositions = manifoldMeshPositions(solid.getMesh());
    const positions = new Array<number>(manifoldPositions.length);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let index = 0; index + 2 < manifoldPositions.length; index += 3) {
      const x = manifoldPositions[index];
      const y = manifoldPositions[index + 2];
      const z = -manifoldPositions[index + 1];
      positions[index] = x;
      positions[index + 1] = y;
      positions[index + 2] = z;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    for (let index = 0; index + 2 < positions.length; index += 3) {
      positions[index] -= centerX;
      positions[index + 1] -= minY;
      positions[index + 2] -= centerZ;
    }
    return {
      positions,
      width: Math.max(0.01, maxX - minX),
      depth: Math.max(0.01, maxZ - minZ),
      height: Math.max(0.01, maxY - minY),
      triangleCount: Math.floor(positions.length / 9),
    };
}
