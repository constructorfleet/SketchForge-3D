import type { SketchConstraint, SketchPoint, SketchProfile } from "@/types/sketchforge";

const CONSTRAINT_TOLERANCE_MM = 1e-5;
const PROJECTION_PASSES = 32;
const DEGENERATE_DISTANCE_DIRECTION = { x: 1, z: 0 };

export type SketchConstraintSolveResult = {
  profile: SketchProfile;
  unsatisfiedConstraintIds: string[];
};

export type SketchConstraintDegreesOfFreedomReport = {
  parameterCount: number;
  equationCount: number;
  rank: number | null;
  degreesOfFreedom: number | null;
  status: "estimated" | "indeterminate";
  reason?: "degenerate-distance";
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

/**
 * Estimates local parameter freedom from the rank of the supported constraint
 * equations at the profile's current coordinates. This is not a solver or a
 * proof of global constraint satisfaction. Bezier handles and sweep depths are
 * counted as free parameters because the supported constraints do not constrain
 * them.
 */
export function sketchConstraintDegreesOfFreedom(profile: SketchProfile): SketchConstraintDegreesOfFreedomReport {
  const constraints = sketchConstraintsForProfile(profile);
  const pointIndex = new Map(profile.points.map((point, index) => [point.id, index * 2]));
  const parameterCount = profile.points.reduce((count, point) => count + 2
    + (point.handleIn ? 2 : 0) + (point.handleOut ? 2 : 0) + (point.sweepDepth !== undefined ? 1 : 0), 0);
  const equationCount = constraints.reduce((count, constraint) => count + (constraint.kind === "coincident" ? 2 : 1), 0);
  const rows: number[][] = [];

  for (const constraint of constraints) {
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const segment = profile.segments.find(({ id }) => id === constraint.segmentId)!;
      const start = pointIndex.get(segment.startId)!;
      const end = pointIndex.get(segment.endId)!;
      const row = Array(parameterCount).fill(0) as number[];
      const coordinate = constraint.kind === "horizontal" ? 1 : 0;
      row[start + coordinate] = (row[start + coordinate] ?? 0) + 1;
      row[end + coordinate] = (row[end + coordinate] ?? 0) - 1;
      rows.push(row);
      continue;
    }
    const [firstId, secondId] = constraint.pointIds;
    const firstIndex = pointIndex.get(firstId)!;
    const secondIndex = pointIndex.get(secondId)!;
    if (constraint.kind === "coincident") {
      for (const coordinate of [0, 1]) {
        const row = Array(parameterCount).fill(0) as number[];
        row[firstIndex + coordinate] = (row[firstIndex + coordinate] ?? 0) + 1;
        row[secondIndex + coordinate] = (row[secondIndex + coordinate] ?? 0) - 1;
        rows.push(row);
      }
      continue;
    }
    const first = profile.points.find(({ id }) => id === firstId)!;
    const second = profile.points.find(({ id }) => id === secondId)!;
    const dx = second.x - first.x;
    const dz = second.z - first.z;
    const length = Math.hypot(dx, dz);
    if (length <= CONSTRAINT_TOLERANCE_MM) {
      return { parameterCount, equationCount, rank: null, degreesOfFreedom: null, status: "indeterminate", reason: "degenerate-distance" };
    }
    const row = Array(parameterCount).fill(0) as number[];
    row[firstIndex] = -dx / length;
    row[firstIndex + 1] = -dz / length;
    row[secondIndex] = dx / length;
    row[secondIndex + 1] = dz / length;
    rows.push(row);
  }

  // Row reduction with partial pivoting gives the local constraint rank, so
  // duplicate and dependent equations only remove freedom once.
  let rank = 0;
  const matrix = rows.map((row) => [...row]);
  for (let column = 0; column < parameterCount && rank < matrix.length; column += 1) {
    let pivot = rank;
    for (let row = rank + 1; row < matrix.length; row += 1) {
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(matrix[pivot]?.[column] ?? 0) < 1e-8) continue;
    [matrix[rank], matrix[pivot]] = [matrix[pivot]!, matrix[rank]!];
    const divisor = matrix[rank]![column]!;
    for (let index = column; index < parameterCount; index += 1) matrix[rank]![index] /= divisor;
    for (let row = 0; row < matrix.length; row += 1) {
      if (row === rank) continue;
      const factor = matrix[row]![column]!;
      for (let index = column; index < parameterCount; index += 1) matrix[row]![index] -= factor * matrix[rank]![index]!;
    }
    rank += 1;
  }

  return { parameterCount, equationCount, rank, degreesOfFreedom: parameterCount - rank, status: "estimated" };
}
