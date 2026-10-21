import type { SketchConstraint, SketchPoint, SketchProfile } from "@/types/sketchforge";

const CONSTRAINT_TOLERANCE_MM = 1e-5;
const PROJECTION_PASSES = 32;
const DEGENERATE_DISTANCE_DIRECTION = { x: 1, z: 0 };

export type SketchConstraintSolveResult = {
  profile: SketchProfile;
  unsatisfiedConstraintIds: string[];
};

export function addSketchConstraint(profile: SketchProfile, constraint: SketchConstraint): SketchProfile {
  if (profile.constraints?.some((existing) => existing.id === constraint.id)) return profile;
  return { ...profile, constraints: [...(profile.constraints ?? []), constraint] };
}

export function removeSketchConstraint(profile: SketchProfile, constraintId: string): SketchProfile {
  const constraints = (profile.constraints ?? []).filter((constraint) => constraint.id !== constraintId);
  return constraints.length === (profile.constraints?.length ?? 0) ? profile : { ...profile, constraints };
}

function movePoint(point: SketchPoint, x: number, z: number): SketchPoint {
  const dx = x - point.x;
  const dz = z - point.z;
  return {
    ...point,
    x,
    z,
    ...(point.handleIn ? { handleIn: { x: point.handleIn.x + dx, z: point.handleIn.z + dz } } : {}),
    ...(point.handleOut ? { handleOut: { x: point.handleOut.x + dx, z: point.handleOut.z + dz } } : {}),
  };
}

function distance(a: SketchPoint, b: SketchPoint) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function pointPair(constraint: Extract<SketchConstraint, { pointIds: [string, string] }>, points: Map<string, SketchPoint>) {
  const first = points.get(constraint.pointIds[0]);
  const second = points.get(constraint.pointIds[1]);
  return first && second ? [first, second] as const : null;
}

function projectCoincident(constraint: Extract<SketchConstraint, { kind: "coincident" }>, points: Map<string, SketchPoint>, anchors: Set<string>) {
  const pair = pointPair(constraint, points);
  if (!pair) return;
  const [first, second] = pair;
  const firstAnchored = anchors.has(first.id);
  const secondAnchored = anchors.has(second.id);
  if (firstAnchored && secondAnchored) return;
  const x = firstAnchored ? first.x : secondAnchored ? second.x : (first.x + second.x) / 2;
  const z = firstAnchored ? first.z : secondAnchored ? second.z : (first.z + second.z) / 2;
  if (!firstAnchored) points.set(first.id, movePoint(first, x, z));
  if (!secondAnchored) points.set(second.id, movePoint(second, x, z));
}

function projectAxis(constraint: Extract<SketchConstraint, { kind: "horizontal" | "vertical" }>, profile: SketchProfile, points: Map<string, SketchPoint>, anchors: Set<string>) {
  const segment = profile.segments.find((candidate) => candidate.id === constraint.segmentId);
  if (!segment) return;
  const first = points.get(segment.startId);
  const second = points.get(segment.endId);
  if (!first || !second) return;
  const axis = constraint.kind === "horizontal" ? "z" : "x";
  const firstAnchored = anchors.has(first.id);
  const secondAnchored = anchors.has(second.id);
  if (firstAnchored && secondAnchored) return;
  const target = firstAnchored ? first[axis] : secondAnchored ? second[axis] : (first[axis] + second[axis]) / 2;
  if (!firstAnchored) points.set(first.id, movePoint(first, axis === "x" ? target : first.x, axis === "z" ? target : first.z));
  if (!secondAnchored) points.set(second.id, movePoint(second, axis === "x" ? target : second.x, axis === "z" ? target : second.z));
}

function projectDistance(constraint: Extract<SketchConstraint, { kind: "distance" }>, points: Map<string, SketchPoint>, anchors: Set<string>) {
  const pair = pointPair(constraint, points);
  if (!pair) return;
  const [first, second] = pair;
  const firstAnchored = anchors.has(first.id);
  const secondAnchored = anchors.has(second.id);
  if (firstAnchored && secondAnchored) return;

  let dx = second.x - first.x;
  let dz = second.z - first.z;
  let current = Math.hypot(dx, dz);
  if (current <= CONSTRAINT_TOLERANCE_MM) {
    dx = DEGENERATE_DISTANCE_DIRECTION.x;
    dz = DEGENERATE_DISTANCE_DIRECTION.z;
    current = 1;
  }
  const ux = dx / current;
  const uz = dz / current;
  if (firstAnchored) {
    points.set(second.id, movePoint(second, first.x + ux * constraint.valueMm, first.z + uz * constraint.valueMm));
  } else if (secondAnchored) {
    points.set(first.id, movePoint(first, second.x - ux * constraint.valueMm, second.z - uz * constraint.valueMm));
  } else {
    const centerX = (first.x + second.x) / 2;
    const centerZ = (first.z + second.z) / 2;
    points.set(first.id, movePoint(first, centerX - ux * constraint.valueMm / 2, centerZ - uz * constraint.valueMm / 2));
    points.set(second.id, movePoint(second, centerX + ux * constraint.valueMm / 2, centerZ + uz * constraint.valueMm / 2));
  }
}

function residual(constraint: SketchConstraint, profile: SketchProfile, points: Map<string, SketchPoint>) {
  if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
    const segment = profile.segments.find((candidate) => candidate.id === constraint.segmentId);
    const first = segment && points.get(segment.startId);
    const second = segment && points.get(segment.endId);
    return first && second ? Math.abs(constraint.kind === "horizontal" ? first.z - second.z : first.x - second.x) : Number.POSITIVE_INFINITY;
  }
  const pair = pointPair(constraint, points);
  if (!pair) return Number.POSITIVE_INFINITY;
  const [first, second] = pair;
  return constraint.kind === "coincident" ? distance(first, second) : Math.abs(distance(first, second) - constraint.valueMm);
}

/** Project positional constraints in stable list order while keeping dragged points fixed. */
export function solveSketchConstraints(profile: SketchProfile, anchoredPointIds: readonly string[] = []): SketchConstraintSolveResult {
  const constraints = profile.constraints ?? [];
  if (!constraints.length) return { profile, unsatisfiedConstraintIds: [] };
  const points = new Map(profile.points.map((point) => [point.id, point]));
  const anchors = new Set(anchoredPointIds);

  for (let pass = 0; pass < PROJECTION_PASSES; pass += 1) {
    for (const constraint of constraints) {
      if (constraint.kind === "coincident") projectCoincident(constraint, points, anchors);
      else if (constraint.kind === "horizontal" || constraint.kind === "vertical") projectAxis(constraint, profile, points, anchors);
      else projectDistance(constraint, points, anchors);
    }
  }

  const solved = { ...profile, points: profile.points.map((point) => points.get(point.id) ?? point) };
  const unsatisfiedConstraintIds = constraints
    .filter((constraint) => residual(constraint, solved, points) > CONSTRAINT_TOLERANCE_MM)
    .map((constraint) => constraint.id);
  return { profile: solved, unsatisfiedConstraintIds };
}

export function sketchConstraintsForProfile(profile: SketchProfile) {
  const pointIds = new Set(profile.points.map((point) => point.id));
  const segmentIds = new Set(profile.segments.map((segment) => segment.id));
  return (profile.constraints ?? []).filter((constraint) => constraint.kind === "horizontal" || constraint.kind === "vertical"
    ? segmentIds.has(constraint.segmentId)
    : pointIds.has(constraint.pointIds[0]) && pointIds.has(constraint.pointIds[1]));
}
