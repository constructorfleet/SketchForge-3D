/**
 * Interference and wall-thickness analysis over kernel solids (#380).
 *
 * Kernel-agnostic on purpose, like `exactBooleanSolids`: the REST API runs it
 * under Node on solids placed from the stored project, and the editor's CAD
 * worker runs it in the browser on solids rebuilt from the parts it sends. Both
 * then give the same answer, refuse the same oversized requests, and disclose
 * the same method, because there is only one implementation of each.
 *
 * Neither function changes anything: they read solids and return numbers.
 */

import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";

export const MAX_INTERFERENCE_SHAPES = 128;
export const MAX_INTERFERENCE_CANDIDATES = 512;
export const INTERFERENCE_METHOD = "OCCT exact distance and common volume; AABB candidate prefilter" as const;
const CONTACT_EPSILON_MM = 1e-7;

export type InterferencePair = {
  a: { id: string; name: string };
  b: { id: string; name: string };
  /** Exact OCCT minimum surface distance in mm. */
  gap: number;
  /** Exact common volume in mm^3; zero when separated or touching. */
  overlapVolume: number;
  /** Imported triangle meshes remain tessellated inputs to the exact kernel solver. */
  precision: "exact" | "tessellated";
};
export type InterferenceReport = {
  shapesChecked: number;
  candidatePairsChecked: number;
  clearance: number;
  method: typeof INTERFERENCE_METHOD;
  pairs: InterferencePair[];
};
export type InterferenceRefusal =
  | { reason: "invalid_clearance" }
  | { reason: "too_many_shapes"; limit: number; given: number }
  | { reason: "too_many_candidates"; limit: number; given: number };
export type InterferenceResult = { ok: true; value: InterferenceReport } | { ok: false; refusal: InterferenceRefusal };

/** One shape to check: who it is, and whether its solid was sewn from triangles. */
export type InterferenceOperand = { id: string; name: string; tessellated: boolean };

type Bounds = { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };

function boundsWithinClearance(a: Bounds, b: Bounds, clearance: number) {
  const dx = Math.max(0, b.xmin - a.xmax, a.xmin - b.xmax);
  const dy = Math.max(0, b.ymin - a.ymax, a.ymin - b.ymax);
  const dz = Math.max(0, b.zmin - a.zmax, a.zmin - b.zmax);
  return Math.hypot(dx, dy, dz) <= clearance;
}

/** Why a request is refused before any solid is built, or null when it may run. */
export function interferenceRequestRefusal(count: number, clearance: number): InterferenceRefusal | null {
  if (!Number.isFinite(clearance) || clearance < 0) return { reason: "invalid_clearance" };
  if (count > MAX_INTERFERENCE_SHAPES) return { reason: "too_many_shapes", limit: MAX_INTERFERENCE_SHAPES, given: count };
  return null;
}

/**
 * Exact gaps and overlap volumes between every pair of operands within
 * `clearance`. Axis-aligned bounds only discard pairs that cannot be that
 * close; every pair left is measured by OCCT. Exceeding either limit refuses
 * the request whole -- half a report would read as "nothing else collides".
 *
 * `solidFor` builds an operand's solid where it stands in the project.
 */
export function interferenceBetweenSolids<T extends InterferenceOperand>(
  cad: OcctKernel,
  operands: readonly T[],
  solidFor: (operand: T) => ShapeHandle,
  clearance = 0,
): InterferenceResult {
  const refusal = interferenceRequestRefusal(operands.length, clearance);
  if (refusal) return { ok: false, refusal };

  const solids = operands.map(solidFor);
  const queries = cad.queryBatch(solids);
  const candidates: Array<[number, number]> = [];
  for (let i = 0; i < operands.length; i += 1) for (let j = i + 1; j < operands.length; j += 1) {
    const a = queries[i]; const b = queries[j];
    if (a && b && boundsWithinClearance(a.bbox, b.bbox, clearance)) candidates.push([i, j]);
    if (candidates.length > MAX_INTERFERENCE_CANDIDATES) {
      return { ok: false, refusal: { reason: "too_many_candidates", limit: MAX_INTERFERENCE_CANDIDATES, given: candidates.length } };
    }
  }

  const pairs: InterferencePair[] = [];
  for (const [i, j] of candidates) {
    const gap = cad.distanceBetween(solids[i]!, solids[j]!);
    if (gap > clearance + CONTACT_EPSILON_MM) continue;
    const overlapVolume = gap <= CONTACT_EPSILON_MM
      ? Math.max(0, cad.getVolume(cad.common(solids[i]!, solids[j]!)))
      : 0;
    const a = operands[i]!; const b = operands[j]!;
    pairs.push({
      a: { id: a.id, name: a.name },
      b: { id: b.id, name: b.name },
      gap,
      overlapVolume,
      precision: a.tessellated || b.tessellated ? "tessellated" : "exact",
    });
  }
  pairs.sort((a, b) => a.gap - b.gap || b.overlapVolume - a.overlapVolume || a.a.id.localeCompare(b.a.id));
  return { ok: true, value: { shapesChecked: operands.length, candidatePairsChecked: candidates.length, clearance, method: INTERFERENCE_METHOD, pairs } };
}

export const WALL_THICKNESS_MAX_FACES = 256;
/** Samples per face are a GRID x GRID lattice over the face's parameter range. */
const WALL_THICKNESS_GRID = 5;

export type WallThicknessResult = {
  minimum: number | null;
  unit: "mm";
  method: "sampled-opposing-surface-distance";
  samplesPerFace: number;
  facesChecked: number;
};

/** Why a solid cannot be sampled at all. */
export class WallThicknessRefusal extends Error {
  constructor(readonly reason: "no_faces" | "too_many_faces", readonly limit?: number) {
    super(reason === "no_faces"
      ? "The shape has no faces to analyze."
      : `Wall-thickness analysis supports at most ${limit} faces.`);
    this.name = "WallThicknessRefusal";
  }
}

function faceSamples(cad: OcctKernel, face: ShapeHandle) {
  const uv = cad.uvBounds(face);
  const points: Array<{ point: Vec3; normal: Vec3 }> = [];
  for (let i = 0; i < WALL_THICKNESS_GRID; i += 1) for (let j = 0; j < WALL_THICKNESS_GRID; j += 1) {
    const u = uv.uMin + (uv.uMax - uv.uMin) * (i + 0.5) / WALL_THICKNESS_GRID;
    const v = uv.vMin + (uv.vMax - uv.vMin) * (j + 0.5) / WALL_THICKNESS_GRID;
    if (cad.classifyPointOnFace(face, u, v) !== "out") {
      points.push({ point: cad.pointOnSurface(face, u, v), normal: cad.surfaceNormal(face, u, v) });
    }
  }
  return points;
}

/**
 * The smallest sampled distance between opposing faces of `solid`. This is a
 * screening estimate, not a medial-axis or certified minimum-thickness result:
 * a wall thinner between two sample points than at any of them is missed.
 */
export function sampledWallThickness(cad: OcctKernel, solid: ShapeHandle): WallThicknessResult {
  const faces = cad.getSubShapes(solid, "face");
  if (!faces.length) throw new WallThicknessRefusal("no_faces");
  if (faces.length > WALL_THICKNESS_MAX_FACES) throw new WallThicknessRefusal("too_many_faces", WALL_THICKNESS_MAX_FACES);
  const sampled = faces.map((face) => faceSamples(cad, face));
  let minimum = Infinity;
  for (let i = 0; i < faces.length; i += 1) for (let j = i + 1; j < faces.length; j += 1) {
    for (const source of sampled[i]!) {
      for (const target of sampled[j]!) {
        const dot = source.normal.x * target.normal.x + source.normal.y * target.normal.y + source.normal.z * target.normal.z;
        if (dot > -0.5) continue;
        const uv = cad.uvFromPoint(faces[j]!, source.point);
        if (cad.classifyPointOnFace(faces[j]!, uv.u, uv.v) === "out") continue;
        const projected = cad.pointOnSurface(faces[j]!, uv.u, uv.v);
        const distance = Math.hypot(source.point.x - projected.x, source.point.y - projected.y, source.point.z - projected.z);
        if (distance > 1e-7 && distance < minimum) minimum = distance;
      }
    }
  }
  return {
    minimum: Number.isFinite(minimum) ? minimum : null,
    unit: "mm",
    method: "sampled-opposing-surface-distance",
    samplesPerFace: WALL_THICKNESS_GRID * WALL_THICKNESS_GRID,
    facesChecked: faces.length,
  };
}
