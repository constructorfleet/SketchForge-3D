import type { SketchPoint, SketchProfile, SketchSegment } from "./domain/sketchforge.js";
import { LocalizedError } from "./support/i18n/LocalizedError.js";

export type OrderedCadSketchStep = { segment: SketchSegment; from: SketchPoint; to: SketchPoint };
export type OrderedCadSketchPath = { id: string; points: SketchPoint[]; steps: OrderedCadSketchStep[]; closed: boolean };
export type CadSketchRegion = { outer: OrderedCadSketchPath; holes: OrderedCadSketchPath[] };

export function orderedCadSketchPaths(profile: SketchProfile): OrderedCadSketchPath[] {
  const pointById = new Map(profile.points.map((point) => [point.id, point]));
  const adjacency = new Map<string, Array<{ pointId: string; segment: SketchSegment }>>();
  profile.points.forEach((point) => adjacency.set(point.id, []));
  const valid = profile.segments.filter((segment) => {
    if (segment.startId === segment.endId || !pointById.has(segment.startId) || !pointById.has(segment.endId)) return false;
    adjacency.get(segment.startId)?.push({ pointId: segment.endId, segment });
    adjacency.get(segment.endId)?.push({ pointId: segment.startId, segment });
    return true;
  });
  const unvisited = new Set(valid.map((segment) => segment.id));
  const paths: OrderedCadSketchPath[] = [];

  while (unvisited.size > 0) {
    const seedId = unvisited.values().next().value as string;
    const seed = valid.find((segment) => segment.id === seedId);
    if (!seed) break;
    const component = new Set<string>();
    const queue = [seed.startId, seed.endId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id || component.has(id)) continue;
      component.add(id);
      adjacency.get(id)?.forEach((edge) => queue.push(edge.pointId));
    }
    const startId = [...component].find((id) => (adjacency.get(id)?.filter((edge) => unvisited.has(edge.segment.id)).length ?? 0) === 1) ?? seed.startId;
    const first = pointById.get(startId);
    if (!first) {
      unvisited.delete(seed.id);
      continue;
    }
    const points = [first];
    const steps: OrderedCadSketchStep[] = [];
    let currentId = startId;
    for (let guard = 0; guard <= valid.length; guard += 1) {
      const edge = adjacency.get(currentId)?.find((candidate) => unvisited.has(candidate.segment.id));
      if (!edge) break;
      const from = pointById.get(currentId);
      const to = pointById.get(edge.pointId);
      if (!from || !to) break;
      unvisited.delete(edge.segment.id);
      steps.push({ segment: edge.segment, from, to });
      currentId = to.id;
      if (currentId === startId) break;
      points.push(to);
    }
    paths.push({ id: seed.id, points, steps, closed: currentId === startId && steps.length >= 3 });
  }
  return paths;
}

function sampledPath(path: OrderedCadSketchPath) {
  const samples: Array<{ x: number; z: number }> = [];
  path.steps.forEach(({ segment, from, to }, stepIndex) => {
    if (stepIndex === 0) samples.push({ x: from.x, z: from.z });
    const forward = segment.startId === from.id;
    const first = forward ? from.handleOut : from.handleIn;
    const second = forward ? to.handleIn : to.handleOut;
    if (segment.kind === "line" || !first || !second) {
      samples.push({ x: to.x, z: to.z });
      return;
    }
    for (let index = 1; index <= 16; index += 1) {
      const amount = index / 16;
      const inverse = 1 - amount;
      samples.push({
        x: inverse ** 3 * from.x + 3 * inverse ** 2 * amount * first.x + 3 * inverse * amount ** 2 * second.x + amount ** 3 * to.x,
        z: inverse ** 3 * from.z + 3 * inverse ** 2 * amount * first.z + 3 * inverse * amount ** 2 * second.z + amount ** 3 * to.z,
      });
    }
  });
  return samples;
}

function signedArea(points: Array<{ x: number; z: number }>) {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.z - next.x * point.z;
  }, 0) / 2;
}

function pointInPolygon(point: { x: number; z: number }, polygon: Array<{ x: number; z: number }>) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const before = polygon[previous];
    if ((current.z > point.z) !== (before.z > point.z)
      && point.x < ((before.x - current.x) * (point.z - current.z)) / (before.z - current.z) + current.x) inside = !inside;
  }
  return inside;
}

export function cadSketchRegions(profile: SketchProfile): CadSketchRegion[] {
  const allPaths = orderedCadSketchPaths(profile);
  const openCount = allPaths.filter((path) => !path.closed).length;
  const records = allPaths
    .filter((path) => path.closed)
    .map((path) => {
      const polygon = sampledPath(path);
      return { path, polygon, area: Math.abs(signedArea(polygon)) };
    })
    .filter((record) => record.polygon.length >= 3 && record.area > 1e-8)
    .sort((a, b) => b.area - a.area);

  // Compute nesting depth: count how many larger closed paths contain each record.
  // Even depth = solid (outer boundary), odd depth = hole.
  const depths = records.map((record, index) => {
    let depth = 0;
    for (let i = 0; i < records.length; i++) {
      if (i === index) continue;
      if (records[i].area > record.area && pointInPolygon(record.polygon[0], records[i].polygon)) {
        depth++;
      }
    }
    return depth;
  });

  const regions: CadSketchRegion[] = [];
  records.forEach((record, index) => {
    const depth = depths[index];
    if (depth % 2 === 0) {
      regions.push({ outer: record.path, holes: [] });
    } else {
      // Odd depth: find the nearest even-depth ancestor (smallest containing solid)
      let bestParent: (typeof records)[number] | null = null;
      for (let i = 0; i < records.length; i++) {
        if (i === index) continue;
        if (depths[i] % 2 === 0 && depths[i] < depth && records[i].area > record.area && pointInPolygon(record.polygon[0], records[i].polygon)) {
          if (!bestParent || records[i].area < bestParent.area) {
            bestParent = records[i];
          }
        }
      }
      if (bestParent) {
        const region = regions.find((r) => r.outer === bestParent!.path);
        if (region) region.holes.push(record.path);
      }
    }
  });

  if (regions.length === 0 && openCount > 0 && allPaths.length > 0) {
    throw new LocalizedError("errors.sketch.allPathsOpen");
  }
  return regions;
}

/** Whether segment `a`-`b` and segment `c`-`d` share any point. */
function segmentsTouch(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }) {
  const cross = (o: { x: number; z: number }, p: { x: number; z: number }, q: { x: number; z: number }) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const scale = Math.max(1, ...[a, b, c, d].flatMap(({ x, z }) => [Math.abs(x), Math.abs(z)]));
  const epsilon = 1e-9 * scale * scale;
  const side = (value: number) => (Math.abs(value) <= epsilon ? 0 : Math.sign(value));
  const within = (o: { x: number; z: number }, p: { x: number; z: number }, q: { x: number; z: number }) =>
    Math.min(o.x, p.x) - epsilon <= q.x && q.x <= Math.max(o.x, p.x) + epsilon
    && Math.min(o.z, p.z) - epsilon <= q.z && q.z <= Math.max(o.z, p.z) + epsilon;
  const d1 = side(cross(c, d, a));
  const d2 = side(cross(c, d, b));
  const d3 = side(cross(a, b, c));
  const d4 = side(cross(a, b, d));
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b))
    || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

/** Whether a closed straight loop touches or crosses itself anywhere but at its own corners. */
function loopCrossesItself(points: Array<{ x: number; z: number }>) {
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (j === i + 1 || (i === 0 && j === count - 1)) continue;
      if (segmentsTouch(points[i]!, points[(i + 1) % count]!, points[j]!, points[(j + 1) % count]!)) return true;
    }
  }
  return false;
}

/** Whether the extrusion draws this step as a cubic, by the same rule as `sampledPath`. */
function stepIsCurved({ segment, from, to }: OrderedCadSketchStep) {
  const forward = segment.startId === from.id;
  const first = forward ? from.handleOut : from.handleIn;
  const second = forward ? to.handleIn : to.handleOut;
  return segment.kind !== "line" && Boolean(first && second);
}

/**
 * The one closed straight-sided loop a prism draft is built from, or why the
 * profile has none.
 *
 * The loop comes from `cadSketchRegions`, as the extrusion it drafts does, so
 * the order and direction segments were drawn in do not matter (#349). The
 * REST draft and the editor's local Draft prism builder both use it, so they
 * accept and refuse the same profiles with the same reasons.
 */
export function draftPrismLoop(profile: SketchProfile): Array<{ x: number; z: number }> | string {
  if (profile.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.z))) {
    return "Draft prism requires a sketch profile whose points all have finite coordinates.";
  }
  // A closing point repeated under its own id is the same point; at another
  // position it is two points the sketch cannot tell apart.
  const positionById = new Map<string, { x: number; z: number }>();
  for (const point of profile.points) {
    const known = positionById.get(point.id);
    if (known && (known.x !== point.x || known.z !== point.z)) {
      return `Draft prism requires each sketch point to have its own id, and two points at different positions share the id "${point.id}".`;
    }
    positionById.set(point.id, point);
  }
  let regions: CadSketchRegion[];
  try {
    regions = cadSketchRegions(profile);
  } catch {
    regions = [];
  }
  if (regions.length === 0) {
    // Say why a loop that does close was not taken as a region.
    const closed = orderedCadSketchPaths(profile).filter((path) => path.closed);
    const straightLoops = closed.filter((path) => !path.steps.some(stepIsCurved)).map((path) => path.points);
    if (straightLoops.some(loopCrossesItself)) return "Draft prism requires an outline that does not cross itself, and this profile's outline crosses itself.";
    if (closed.length > 0) return "Draft prism requires a closed outline that encloses an area, and this profile's closed outline encloses no area.";
    return "Draft prism requires a closed sketch profile, and this profile has no closed outline.";
  }
  if (regions.length > 1) {
    return `Draft prism requires one closed sketch profile, and this profile has ${regions.length} separate closed regions.`;
  }
  const [region] = regions;
  if (region.holes.length > 0) {
    return "Draft prism does not support profiles with holes yet; this profile's closed region contains "
      + `${region.holes.length === 1 ? "a hole" : `${region.holes.length} holes`}.`;
  }
  if (region.outer.steps.some(stepIsCurved)) return "Draft prism requires straight segments, and this profile's outline is curved.";
  if (loopCrossesItself(region.outer.points)) {
    return "Draft prism requires an outline that does not cross itself, and this profile's outline crosses itself.";
  }
  // The draft is built about the centre of every point's bounds
  // (`draftPrismProfileOffset`), so a stray point or construction line would
  // move it off the outline it drafts. Such profiles are refused, as they
  // always were; only the order of the outline's own segments is free. A
  // repeated point and a zero-length segment from a point to itself add
  // nothing to the outline or its bounds, so they are not counted.
  const outlineIds = new Set(region.outer.points.map(({ id }) => id));
  const outlineSegmentIds = new Set(region.outer.steps.map(({ segment }) => segment.id));
  const strayPoints = [...positionById.keys()].filter((id) => !outlineIds.has(id)).length;
  const straySegments = profile.segments.filter((segment) => !outlineSegmentIds.has(segment.id)
    && !(segment.startId === segment.endId && outlineIds.has(segment.startId))).length;
  const outside = strayPoints + straySegments;
  if (outside > 0) {
    return "Draft prism requires every sketch point and segment to belong to one closed outline, and this profile has "
      + `${outside === 1 ? "one point or segment" : `${outside} points or segments`} outside its closed outline.`;
  }
  return region.outer.steps.map(({ from }) => from);
}

export function cadSketchSweepPaths(profile: SketchProfile): { sections: CadSketchRegion[]; spine: OrderedCadSketchPath } {
  const paths = orderedCadSketchPaths(profile);
  const closedPaths = paths.filter((path) => path.closed);
  const sectionPointIds = new Set(closedPaths.flatMap((path) => path.points.map((point) => point.id)));
  const sectionProfile: SketchProfile = {
    points: profile.points.filter((point) => sectionPointIds.has(point.id)),
    segments: profile.segments.filter((segment) => sectionPointIds.has(segment.startId) && sectionPointIds.has(segment.endId)),
  };
  const sections = cadSketchRegions(sectionProfile);
  const spines = paths.filter((path) => !path.closed);
  if (sections.length === 0 || spines.length !== 1 || paths.length !== sections.reduce((count, region) => count + 1 + region.holes.length, 0) + 1) {
    throw new LocalizedError("errors.sketch.sweepNeedsSectionAndSpine");
  }
  return { sections, spine: spines[0] };
}
