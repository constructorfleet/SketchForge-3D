import type { SketchConstraint, SketchPoint, SketchProfile } from "@/types/sketchforge";

const CONSTRAINT_TOLERANCE_MM = 1e-5;
const DEGENERATE_DISTANCE_DIRECTION = { x: 1, z: 0 };
const MAX_GLOBAL_ITERATIONS = 40;
const MAX_CG_ITERATIONS = 48;
const INITIAL_DAMPING = 1e-3;
const SOLVER_CONVERGENCE_TOLERANCE_MM = 1e-8;

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
  reason?: "degenerate-distance" | "degenerate-segment";
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

function segmentPair(segmentIds: [string, string], profile: SketchProfile) {
  const first = profile.segments.find(({ id }) => id === segmentIds[0]);
  const second = profile.segments.find(({ id }) => id === segmentIds[1]);
  return first && second ? [first, second] as const : null;
}

function tangentInfo(segmentIds: [string, string], profile: SketchProfile, points: Map<string, SketchPoint>) {
  const pair = segmentPair(segmentIds, profile);
  if (!pair) return null;
  const isLine = (segment: typeof pair[0]) => !segment.kind || segment.kind === "line";
  const isBezier = (segment: typeof pair[0]) => segment.kind === "bezier" || segment.kind === "smooth";
  const line = isLine(pair[0]) && isBezier(pair[1]) ? pair[0] : isLine(pair[1]) && isBezier(pair[0]) ? pair[1] : null;
  const curve = line === pair[0] ? pair[1] : line === pair[1] ? pair[0] : null;
  if (!line || !curve) return null;
  const sharedIds = [line.startId, line.endId].filter((id) => id === curve.startId || id === curve.endId);
  if (sharedIds.length !== 1) return null;
  const sharedId = sharedIds[0]!;
  const shared = points.get(sharedId);
  const lineStart = points.get(line.startId);
  const lineEnd = points.get(line.endId);
  if (!shared || !lineStart || !lineEnd) return null;
  const handle = curve.startId === sharedId ? shared.handleOut : shared.handleIn;
  if (!handle) return null;
  const curveX = curve.startId === sharedId ? handle.x - shared.x : shared.x - handle.x;
  const curveZ = curve.startId === sharedId ? handle.z - shared.z : shared.z - handle.z;
  return { line, lineStart, lineEnd, curveX, curveZ };
}

export function isSketchTangentPair(segmentIds: [string, string], profile: SketchProfile) {
  return Boolean(tangentInfo(segmentIds, profile, new Map(profile.points.map((point) => [point.id, point]))));
}

function pointPair(constraint: Extract<SketchConstraint, { pointIds: [string, string] }>, points: Map<string, SketchPoint>) {
  const first = points.get(constraint.pointIds[0]);
  const second = points.get(constraint.pointIds[1]);
  return first && second ? [first, second] as const : null;
}

function residual(constraint: SketchConstraint, profile: SketchProfile, points: Map<string, SketchPoint>) {
  if (constraint.kind === "fixed") {
    const point = points.get(constraint.pointId);
    return point ? Math.max(Math.abs(point.x - constraint.xMm), Math.abs(point.z - constraint.zMm)) : Number.POSITIVE_INFINITY;
  }
  if (constraint.kind === "perpendicular") {
    const pair = segmentPair(constraint.segmentIds, profile);
    const first = pair && points.get(pair[0].startId), firstEnd = pair && points.get(pair[0].endId);
    const second = pair && points.get(pair[1].startId), secondEnd = pair && points.get(pair[1].endId);
    if (!first || !firstEnd || !second || !secondEnd) return Number.POSITIVE_INFINITY;
    const ux = firstEnd.x - first.x, uz = firstEnd.z - first.z;
    const vx = secondEnd.x - second.x, vz = secondEnd.z - second.z;
    const lengths = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    return lengths <= CONSTRAINT_TOLERANCE_MM ** 2 ? Number.POSITIVE_INFINITY : Math.abs((ux * vx + uz * vz) / lengths);
  }
  if (constraint.kind === "parallel") {
    const pair = segmentPair(constraint.segmentIds, profile);
    const first = pair && points.get(pair[0].startId), firstEnd = pair && points.get(pair[0].endId);
    const second = pair && points.get(pair[1].startId), secondEnd = pair && points.get(pair[1].endId);
    if (!first || !firstEnd || !second || !secondEnd) return Number.POSITIVE_INFINITY;
    const ux = firstEnd.x - first.x, uz = firstEnd.z - first.z;
    const vx = secondEnd.x - second.x, vz = secondEnd.z - second.z;
    const lengths = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    return lengths <= CONSTRAINT_TOLERANCE_MM ** 2 ? Number.POSITIVE_INFINITY : Math.abs((ux * vz - uz * vx) / lengths);
  }
  if (constraint.kind === "tangent") {
    const info = tangentInfo(constraint.segmentIds, profile, points);
    if (!info) return Number.POSITIVE_INFINITY;
    const lineX = info.lineEnd.x - info.lineStart.x;
    const lineZ = info.lineEnd.z - info.lineStart.z;
    const lineLength = Math.hypot(lineX, lineZ);
    const curveLength = Math.hypot(info.curveX, info.curveZ);
    return lineLength <= CONSTRAINT_TOLERANCE_MM || curveLength <= CONSTRAINT_TOLERANCE_MM
      ? Number.POSITIVE_INFINITY
      : Math.abs((lineX * info.curveZ - lineZ * info.curveX) / (lineLength * curveLength));
  }
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

type JacobianTerm = { index: number; coefficient: number };
type ConstraintEquation = { value: number; terms: JacobianTerm[] };

function equationRows(
  constraints: SketchConstraint[],
  profile: SketchProfile,
  points: Map<string, SketchPoint>,
  variableIndex: Map<string, number>,
): ConstraintEquation[] {
  const equations: ConstraintEquation[] = [];
  const add = (value: number, terms: Array<{ pointId: string; coordinate: 0 | 1; coefficient: number }>) => {
    equations.push({
      value,
      terms: terms.flatMap(({ pointId, coordinate, coefficient }) => {
        const base = variableIndex.get(pointId);
        return base === undefined ? [] : [{ index: base + coordinate, coefficient }];
      }),
    });
  };

  for (const constraint of constraints) {
    if (constraint.kind === "fixed") continue;
    if (constraint.kind === "perpendicular") {
      const pair = segmentPair(constraint.segmentIds, profile);
      const first = pair && points.get(pair[0].startId), firstEnd = pair && points.get(pair[0].endId);
      const second = pair && points.get(pair[1].startId), secondEnd = pair && points.get(pair[1].endId);
      if (!first || !firstEnd || !second || !secondEnd) continue;
      const ux = firstEnd.x - first.x, uz = firstEnd.z - first.z;
      const vx = secondEnd.x - second.x, vz = secondEnd.z - second.z;
      const firstLength = Math.hypot(ux, uz), secondLength = Math.hypot(vx, vz);
      if (firstLength <= CONSTRAINT_TOLERANCE_MM || secondLength <= CONSTRAINT_TOLERANCE_MM) continue;
      const cosine = (ux * vx + uz * vz) / (firstLength * secondLength);
      const gux = vx / (firstLength * secondLength) - cosine * ux / (firstLength * firstLength);
      const guz = vz / (firstLength * secondLength) - cosine * uz / (firstLength * firstLength);
      const gvx = ux / (firstLength * secondLength) - cosine * vx / (secondLength * secondLength);
      const gvz = uz / (firstLength * secondLength) - cosine * vz / (secondLength * secondLength);
      add(cosine, [
        { pointId: first.id, coordinate: 0, coefficient: -gux }, { pointId: first.id, coordinate: 1, coefficient: -guz },
        { pointId: firstEnd.id, coordinate: 0, coefficient: gux }, { pointId: firstEnd.id, coordinate: 1, coefficient: guz },
        { pointId: second.id, coordinate: 0, coefficient: -gvx }, { pointId: second.id, coordinate: 1, coefficient: -gvz },
        { pointId: secondEnd.id, coordinate: 0, coefficient: gvx }, { pointId: secondEnd.id, coordinate: 1, coefficient: gvz },
      ]);
      continue;
    }
    if (constraint.kind === "parallel") {
      const pair = segmentPair(constraint.segmentIds, profile);
      const first = pair && points.get(pair[0].startId), firstEnd = pair && points.get(pair[0].endId);
      const second = pair && points.get(pair[1].startId), secondEnd = pair && points.get(pair[1].endId);
      if (!first || !firstEnd || !second || !secondEnd) continue;
      const ux = firstEnd.x - first.x, uz = firstEnd.z - first.z;
      const vx = secondEnd.x - second.x, vz = secondEnd.z - second.z;
      const firstLength = Math.hypot(ux, uz), secondLength = Math.hypot(vx, vz);
      if (firstLength <= CONSTRAINT_TOLERANCE_MM || secondLength <= CONSTRAINT_TOLERANCE_MM) continue;
      const sine = (ux * vz - uz * vx) / (firstLength * secondLength);
      const gux = vz / (firstLength * secondLength) - sine * ux / (firstLength * firstLength);
      const guz = -vx / (firstLength * secondLength) - sine * uz / (firstLength * firstLength);
      const gvx = -uz / (firstLength * secondLength) - sine * vx / (secondLength * secondLength);
      const gvz = ux / (firstLength * secondLength) - sine * vz / (secondLength * secondLength);
      add(sine, [
        { pointId: first.id, coordinate: 0, coefficient: -gux }, { pointId: first.id, coordinate: 1, coefficient: -guz },
        { pointId: firstEnd.id, coordinate: 0, coefficient: gux }, { pointId: firstEnd.id, coordinate: 1, coefficient: guz },
        { pointId: second.id, coordinate: 0, coefficient: -gvx }, { pointId: second.id, coordinate: 1, coefficient: -gvz },
        { pointId: secondEnd.id, coordinate: 0, coefficient: gvx }, { pointId: secondEnd.id, coordinate: 1, coefficient: gvz },
      ]);
      continue;
    }
    if (constraint.kind === "tangent") {
      const info = tangentInfo(constraint.segmentIds, profile, points);
      if (!info) continue;
      const ux = info.lineEnd.x - info.lineStart.x;
      const uz = info.lineEnd.z - info.lineStart.z;
      const vx = info.curveX;
      const vz = info.curveZ;
      const lineLength = Math.hypot(ux, uz);
      const curveLength = Math.hypot(vx, vz);
      if (lineLength <= CONSTRAINT_TOLERANCE_MM || curveLength <= CONSTRAINT_TOLERANCE_MM) continue;
      const sine = (ux * vz - uz * vx) / (lineLength * curveLength);
      const gux = vz / (lineLength * curveLength) - sine * ux / (lineLength * lineLength);
      const guz = -vx / (lineLength * curveLength) - sine * uz / (lineLength * lineLength);
      add(sine, [
        { pointId: info.lineStart.id, coordinate: 0, coefficient: -gux },
        { pointId: info.lineStart.id, coordinate: 1, coefficient: -guz },
        { pointId: info.lineEnd.id, coordinate: 0, coefficient: gux },
        { pointId: info.lineEnd.id, coordinate: 1, coefficient: guz },
      ]);
      continue;
    }
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const segment = profile.segments.find(({ id }) => id === constraint.segmentId);
      const first = segment && points.get(segment.startId);
      const second = segment && points.get(segment.endId);
      if (!first || !second) continue;
      const coordinate = constraint.kind === "horizontal" ? 1 : 0;
      add(first[coordinate === 1 ? "z" : "x"] - second[coordinate === 1 ? "z" : "x"], [
        { pointId: first.id, coordinate, coefficient: 1 },
        { pointId: second.id, coordinate, coefficient: -1 },
      ]);
      continue;
    }

    const pair = pointPair(constraint, points);
    if (!pair) continue;
    const [first, second] = pair;
    const dx = second.x - first.x;
    const dz = second.z - first.z;
    if (constraint.kind === "coincident") {
      add(first.x - second.x, [
        { pointId: first.id, coordinate: 0, coefficient: 1 },
        { pointId: second.id, coordinate: 0, coefficient: -1 },
      ]);
      add(first.z - second.z, [
        { pointId: first.id, coordinate: 1, coefficient: 1 },
        { pointId: second.id, coordinate: 1, coefficient: -1 },
      ]);
      continue;
    }

    const length = Math.hypot(dx, dz);
    const unitX = length <= CONSTRAINT_TOLERANCE_MM ? DEGENERATE_DISTANCE_DIRECTION.x : dx / length;
    const unitZ = length <= CONSTRAINT_TOLERANCE_MM ? DEGENERATE_DISTANCE_DIRECTION.z : dz / length;
    add(length - constraint.valueMm, [
      { pointId: first.id, coordinate: 0, coefficient: -unitX },
      { pointId: first.id, coordinate: 1, coefficient: -unitZ },
      { pointId: second.id, coordinate: 0, coefficient: unitX },
      { pointId: second.id, coordinate: 1, coefficient: unitZ },
    ]);
  }
  return equations;
}

function objective(equations: ConstraintEquation[]) {
  return equations.reduce((sum, equation) => sum + equation.value * equation.value, 0);
}

function multiplyNormalMatrix(equations: ConstraintEquation[], vector: number[], damping: number) {
  const output = vector.map((value) => damping * value);
  for (const equation of equations) {
    const projection = equation.terms.reduce((sum, term) => sum + term.coefficient * vector[term.index]!, 0);
    for (const term of equation.terms) output[term.index] += term.coefficient * projection;
  }
  return output;
}

function solveNormalSystem(equations: ConstraintEquation[], variableCount: number, damping: number) {
  const right = Array(variableCount).fill(0) as number[];
  for (const equation of equations) {
    for (const term of equation.terms) right[term.index] -= term.coefficient * equation.value;
  }
  const solution = Array(variableCount).fill(0) as number[];
  const residualVector = [...right];
  const direction = [...right];
  let residualSquared = residualVector.reduce((sum, value) => sum + value * value, 0);
  const target = Math.max(1, Math.sqrt(residualSquared)) * 1e-8;

  for (let iteration = 0; iteration < Math.min(MAX_CG_ITERATIONS, Math.max(16, variableCount * 2)) && Math.sqrt(residualSquared) > target; iteration += 1) {
    const product = multiplyNormalMatrix(equations, direction, damping);
    const denominator = direction.reduce((sum, value, index) => sum + value * product[index]!, 0);
    if (!Number.isFinite(denominator) || denominator <= 1e-20) break;
    const step = residualSquared / denominator;
    for (let index = 0; index < variableCount; index += 1) {
      solution[index] += step * direction[index]!;
      residualVector[index] -= step * product[index]!;
    }
    const nextSquared = residualVector.reduce((sum, value) => sum + value * value, 0);
    if (!Number.isFinite(nextSquared)) break;
    const ratio = nextSquared / Math.max(residualSquared, 1e-30);
    for (let index = 0; index < variableCount; index += 1) {
      direction[index] = residualVector[index]! + ratio * direction[index]!;
    }
    residualSquared = nextSquared;
  }
  return solution;
}

function applyStep(points: Map<string, SketchPoint>, variableIndex: Map<string, number>, step: number[]) {
  const result = new Map(points);
  for (const [pointId, base] of variableIndex) {
    const point = result.get(pointId);
    if (!point) continue;
    const dx = Math.max(-1000, Math.min(1000, step[base]!));
    const dz = Math.max(-1000, Math.min(1000, step[base + 1]!));
    result.set(pointId, movePoint(point, point.x + dx, point.z + dz));
  }
  return result;
}

function breakCollinearDistanceDegeneracy(
  constraints: SketchConstraint[],
  profile: SketchProfile,
  points: Map<string, SketchPoint>,
  variableIndex: Map<string, number>,
) {
  const unsatisfiedDistances = constraints.filter((constraint) => constraint.kind === "distance"
    && residual(constraint, profile, points) > CONSTRAINT_TOLERANCE_MM);
  if (!unsatisfiedDistances.length) return null;

  const neighbors = new Map<string, Set<string>>();
  const connect = (firstId: string, secondId: string) => {
    if (!neighbors.has(firstId)) neighbors.set(firstId, new Set());
    if (!neighbors.has(secondId)) neighbors.set(secondId, new Set());
    neighbors.get(firstId)!.add(secondId);
    neighbors.get(secondId)!.add(firstId);
  };
  for (const constraint of constraints) {
    if (constraint.kind === "perpendicular") {
      const pair = segmentPair(constraint.segmentIds, profile);
      if (pair) {
        const first = profile.segments.find(({ id }) => id === pair[0].id)!;
        const second = profile.segments.find(({ id }) => id === pair[1].id)!;
        connect(first.startId, first.endId);
        connect(second.startId, second.endId);
      }
    } else if (constraint.kind === "parallel") {
      const pair = segmentPair(constraint.segmentIds, profile);
      if (pair) {
        connect(pair[0].startId, pair[0].endId);
        connect(pair[1].startId, pair[1].endId);
      }
    } else if (constraint.kind === "tangent") {
      const info = tangentInfo(constraint.segmentIds, profile, points);
      if (info) connect(info.line.startId, info.line.endId);
    } else if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const segment = profile.segments.find(({ id }) => id === constraint.segmentId);
      if (segment) connect(segment.startId, segment.endId);
    } else if (constraint.kind !== "fixed") {
      connect(constraint.pointIds[0], constraint.pointIds[1]);
    }
  }
  const componentIds = new Set<string>();
  const pending = unsatisfiedDistances.flatMap((constraint) => constraint.kind === "distance" ? [...constraint.pointIds] : []);
  while (pending.length) {
    const pointId = pending.pop()!;
    if (componentIds.has(pointId)) continue;
    componentIds.add(pointId);
    pending.push(...(neighbors.get(pointId) ?? []));
  }
  const componentPoints = profile.points.filter(({ id }) => componentIds.has(id));
  if (componentPoints.length < 3) return null;

  let farthestPair: [SketchPoint, SketchPoint] | null = null;
  let largestDistance = 0;
  for (let firstIndex = 0; firstIndex < componentPoints.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < componentPoints.length; secondIndex += 1) {
      const first = points.get(componentPoints[firstIndex]!.id)!;
      const second = points.get(componentPoints[secondIndex]!.id)!;
      const length = distance(first, second);
      if (length > largestDistance) {
        largestDistance = length;
        farthestPair = [first, second];
      }
    }
  }
  if (!farthestPair) return null;
  const [axisStart, axisEnd] = farthestPair;
  const axisX = (axisEnd.x - axisStart.x) / largestDistance;
  const axisZ = (axisEnd.z - axisStart.z) / largestDistance;
  const maxDeviation = componentPoints.reduce((max, point) => {
    const current = points.get(point.id)!;
    const cross = Math.abs((current.x - axisStart.x) * axisZ - (current.z - axisStart.z) * axisX);
    return Math.max(max, cross);
  }, 0);
  if (maxDeviation > Math.max(1, largestDistance) * 1e-10) return null;

  const pointToPerturb = [...componentPoints].reverse().find((point) => variableIndex.has(point.id));
  if (!pointToPerturb) return null;
  const current = points.get(pointToPerturb.id)!;
  const epsilon = Math.max(1e-3, largestDistance * 1e-4);
  const next = new Map(points);
  next.set(pointToPerturb.id, movePoint(current, current.x - axisZ * epsilon, current.z + axisX * epsilon));
  return next;
}

/** Solve supported positional constraints together with a bounded damped least-squares iteration. */
export function solveSketchConstraints(profile: SketchProfile, anchoredPointIds: readonly string[] = []): SketchConstraintSolveResult {
  const constraints = profile.constraints ?? [];
  if (!constraints.length) return { profile, unsatisfiedConstraintIds: [] };
  const fixedPointConstraints = constraints.filter((constraint) => constraint.kind === "fixed");
  const anchors = new Set([...anchoredPointIds, ...fixedPointConstraints.map((constraint) => constraint.pointId)]);
  const constrainedPointIds = new Set(constraints.flatMap((constraint) => {
    if (constraint.kind === "fixed") return [constraint.pointId];
    if (constraint.kind === "perpendicular" || constraint.kind === "parallel") return constraint.segmentIds.flatMap((id) => {
      const segment = profile.segments.find(({ id: candidate }) => candidate === id);
      return segment ? [segment.startId, segment.endId] : [];
    });
    if (constraint.kind === "tangent") {
      const info = tangentInfo(constraint.segmentIds, profile, new Map(profile.points.map((point) => [point.id, point])));
      return info ? [info.line.startId, info.line.endId] : [];
    }
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const segment = profile.segments.find(({ id }) => id === constraint.segmentId);
      return segment ? [segment.startId, segment.endId] : [];
    }
    return constraint.pointIds;
  }));
  const variableIndex = new Map<string, number>();
  for (const point of profile.points) {
    if (!anchors.has(point.id) && constrainedPointIds.has(point.id)) variableIndex.set(point.id, variableIndex.size * 2);
  }
  const variableCount = variableIndex.size * 2;
  let points = new Map(profile.points.map((point) => [point.id, point]));
  const initializedFixedPointIds = new Set<string>();
  for (const constraint of fixedPointConstraints) {
    const point = points.get(constraint.pointId);
    if (point && !initializedFixedPointIds.has(point.id)) {
      points.set(point.id, movePoint(point, constraint.xMm, constraint.zMm));
      initializedFixedPointIds.add(point.id);
    }
  }
  let damping = INITIAL_DAMPING;
  let currentEquations = equationRows(constraints, profile, points, variableIndex);
  let currentObjective = objective(currentEquations);
  let bestPoints = points;
  let bestObjective = currentObjective;
  let seededCollinearGeometry = false;

  for (let iteration = 0; iteration < MAX_GLOBAL_ITERATIONS && variableCount > 0; iteration += 1) {
    if (currentEquations.every(({ value }) => Math.abs(value) <= SOLVER_CONVERGENCE_TOLERANCE_MM)) break;
    const step = solveNormalSystem(currentEquations, variableCount, damping);
    const maxStep = Math.max(0, ...step.map(Math.abs));
    if (!Number.isFinite(maxStep) || maxStep < 1e-12) break;

    let accepted: { points: Map<string, SketchPoint>; equations: ConstraintEquation[]; objective: number } | null = null;
    for (const scale of [1, 0.5, 0.25, 0.125, 0.0625]) {
      const candidateStep = step.map((value) => value * scale);
      const candidatePoints = applyStep(points, variableIndex, candidateStep);
      const candidateEquations = equationRows(constraints, profile, candidatePoints, variableIndex);
      const candidateObjective = objective(candidateEquations);
      if (Number.isFinite(candidateObjective) && candidateObjective < currentObjective - Math.max(1e-16, currentObjective * 1e-12)) {
        accepted = { points: candidatePoints, equations: candidateEquations, objective: candidateObjective };
        break;
      }
    }

    if (!accepted) {
      if (!seededCollinearGeometry) {
        const seeded = breakCollinearDistanceDegeneracy(constraints, profile, points, variableIndex);
        if (seeded) {
          points = seeded;
          currentEquations = equationRows(constraints, profile, points, variableIndex);
          currentObjective = objective(currentEquations);
          if (currentObjective < bestObjective) {
            bestPoints = points;
            bestObjective = currentObjective;
          }
          damping = INITIAL_DAMPING;
          seededCollinearGeometry = true;
          continue;
        }
      }
      damping *= 10;
      if (damping > 1e8) break;
      continue;
    }

    const previousObjective = currentObjective;
    points = accepted.points;
    currentEquations = accepted.equations;
    currentObjective = accepted.objective;
    if (currentObjective < bestObjective) {
      bestPoints = points;
      bestObjective = currentObjective;
    }
    damping = Math.max(1e-9, damping * 0.3);

    const residualAboveTolerance = currentEquations.some(({ value }) => Math.abs(value) > CONSTRAINT_TOLERANCE_MM);
    const relativeProgress = (previousObjective - currentObjective) / Math.max(previousObjective, 1e-30);
    if (!seededCollinearGeometry && residualAboveTolerance && relativeProgress < 1e-5) {
      const seeded = breakCollinearDistanceDegeneracy(constraints, profile, points, variableIndex);
      if (seeded) {
        points = seeded;
        currentEquations = equationRows(constraints, profile, points, variableIndex);
        currentObjective = objective(currentEquations);
        if (currentObjective < bestObjective) {
          bestPoints = points;
          bestObjective = currentObjective;
        }
        damping = INITIAL_DAMPING;
        seededCollinearGeometry = true;
      }
    }
  }

  const solved = { ...profile, points: profile.points.map((point) => bestPoints.get(point.id) ?? point) };
  const unsatisfiedConstraintIds = constraints
    .filter((constraint) => {
      const error = residual(constraint, solved, bestPoints);
      return !Number.isFinite(error) || error > CONSTRAINT_TOLERANCE_MM;
    })
    .map((constraint) => constraint.id);
  return { profile: solved, unsatisfiedConstraintIds };
}

export function sketchConstraintsForProfile(profile: SketchProfile) {
  const pointIds = new Set(profile.points.map((point) => point.id));
  const segmentIds = new Set(profile.segments.map((segment) => segment.id));
  return (profile.constraints ?? []).filter((constraint) => constraint.kind === "fixed" ? pointIds.has(constraint.pointId)
    : constraint.kind === "horizontal" || constraint.kind === "vertical"
    ? segmentIds.has(constraint.segmentId)
    : constraint.kind === "perpendicular" || constraint.kind === "parallel" ? constraint.segmentIds.every((id) => segmentIds.has(id))
    : constraint.kind === "tangent" ? isSketchTangentPair(constraint.segmentIds, profile)
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
  const equationCount = constraints.reduce((count, constraint) => count + (constraint.kind === "fixed" || constraint.kind === "coincident" ? 2 : 1), 0);
  const rows: number[][] = [];

  for (const constraint of constraints) {
    if (constraint.kind === "fixed") {
      const anchorIndex = pointIndex.get(constraint.pointId)!;
      const xRow = Array(parameterCount).fill(0) as number[];
      const zRow = Array(parameterCount).fill(0) as number[];
      xRow[anchorIndex] = 1;
      zRow[anchorIndex + 1] = 1;
      rows.push(xRow, zRow);
      continue;
    }
    if (constraint.kind === "perpendicular" || constraint.kind === "parallel") {
      const firstSegment = profile.segments.find(({ id }) => id === constraint.segmentIds[0])!;
      const secondSegment = profile.segments.find(({ id }) => id === constraint.segmentIds[1])!;
      const ids = [firstSegment.startId, firstSegment.endId, secondSegment.startId, secondSegment.endId];
      const points = ids.map((id) => profile.points.find((point) => point.id === id)!);
      const [a, b, c, d] = points;
      const ux = b!.x - a!.x, uz = b!.z - a!.z, vx = d!.x - c!.x, vz = d!.z - c!.z;
      const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
      if (lu <= CONSTRAINT_TOLERANCE_MM || lv <= CONSTRAINT_TOLERANCE_MM) return { parameterCount, equationCount, rank: null, degreesOfFreedom: null, status: "indeterminate", reason: "degenerate-segment" };
      const relation = constraint.kind === "perpendicular" ? (ux * vx + uz * vz) / (lu * lv) : (ux * vz - uz * vx) / (lu * lv);
      const gux = (constraint.kind === "perpendicular" ? vx : vz) / (lu * lv) - relation * ux / (lu * lu);
      const guz = (constraint.kind === "perpendicular" ? vz : -vx) / (lu * lv) - relation * uz / (lu * lu);
      const gvx = (constraint.kind === "perpendicular" ? ux : -uz) / (lu * lv) - relation * vx / (lv * lv);
      const gvz = (constraint.kind === "perpendicular" ? uz : ux) / (lu * lv) - relation * vz / (lv * lv);
      const row = Array(parameterCount).fill(0) as number[];
      const coefficients = [-gux, -guz, gux, guz, -gvx, -gvz, gvx, gvz];
      ids.forEach((id, index) => {
        const base = pointIndex.get(id)!;
        row[base] = (row[base] ?? 0) + coefficients[index * 2]!;
        row[base + 1] = (row[base + 1] ?? 0) + coefficients[index * 2 + 1]!;
      });
      rows.push(row);
      continue;
    }
    if (constraint.kind === "tangent") {
      const info = tangentInfo(constraint.segmentIds, profile, new Map(profile.points.map((point) => [point.id, point])));
      if (!info) return { parameterCount, equationCount, rank: null, degreesOfFreedom: null, status: "indeterminate", reason: "degenerate-segment" };
      const ux = info.lineEnd.x - info.lineStart.x;
      const uz = info.lineEnd.z - info.lineStart.z;
      const vx = info.curveX;
      const vz = info.curveZ;
      const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
      if (lu <= CONSTRAINT_TOLERANCE_MM || lv <= CONSTRAINT_TOLERANCE_MM) return { parameterCount, equationCount, rank: null, degreesOfFreedom: null, status: "indeterminate", reason: "degenerate-segment" };
      const sine = (ux * vz - uz * vx) / (lu * lv);
      const gux = vz / (lu * lv) - sine * ux / (lu * lu);
      const guz = -vx / (lu * lv) - sine * uz / (lu * lu);
      const row = Array(parameterCount).fill(0) as number[];
      const start = pointIndex.get(info.line.startId)!;
      const end = pointIndex.get(info.line.endId)!;
      row[start] = (row[start] ?? 0) - gux;
      row[start + 1] = (row[start + 1] ?? 0) - guz;
      row[end] = (row[end] ?? 0) + gux;
      row[end + 1] = (row[end + 1] ?? 0) + guz;
      rows.push(row);
      continue;
    }
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
