/** Exact, bounded interference checks between positioned project solids. */

import { withCadKernel } from "./serverCadKernel.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export const MAX_INTERFERENCE_SHAPES = 128;
export const MAX_INTERFERENCE_CANDIDATES = 512;
const CONTACT_EPSILON_MM = 1e-7;

export type InterferenceRequest = { ids?: readonly string[]; clearance?: number };
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
  method: "OCCT exact distance and common volume; AABB candidate prefilter";
  pairs: InterferencePair[];
};
export type InterferenceRefusal =
  | { reason: "invalid_clearance" }
  | { reason: "too_many_shapes"; limit: number; given: number }
  | { reason: "too_many_candidates"; limit: number; given: number };

type InterferenceResult = { ok: true; value: InterferenceReport } | { ok: false; refusal: InterferenceRefusal };

function overlapsWithinClearance(a: { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number }, b: typeof a, clearance: number) {
  const dx = Math.max(0, b.xmin - a.xmax, a.xmin - b.xmax);
  const dy = Math.max(0, b.ymin - a.ymax, a.ymin - b.ymax);
  const dz = Math.max(0, b.zmin - a.zmax, a.zmin - b.zmax);
  return Math.hypot(dx, dy, dz) <= clearance;
}

/**
 * Check all selected visible non-cutter solids. Work is bounded before OCCT
 * distance calculations; exceeding either cap refuses the entire request.
 */
export async function checkInterference(shapes: readonly WorkplaneShape[], request: InterferenceRequest = {}): Promise<InterferenceResult> {
  const clearance = request.clearance ?? 0;
  if (!Number.isFinite(clearance) || clearance < 0) return { ok: false, refusal: { reason: "invalid_clearance" } };
  const ids = request.ids ? new Set(request.ids) : null;
  const selected = shapes.filter((shape) => !shape.hidden && !shape.hole && (!ids || ids.has(shape.id)));
  if (selected.length > MAX_INTERFERENCE_SHAPES) return { ok: false, refusal: { reason: "too_many_shapes", limit: MAX_INTERFERENCE_SHAPES, given: selected.length } };

  return withCadKernel(async (cad) => {
    const solids = selected.map((shape) => placedSolidForShape(cad, shape));
    const queries = await cad.queryBatch(solids);
    const candidates: Array<[number, number]> = [];
    for (let i = 0; i < selected.length; i += 1) for (let j = i + 1; j < selected.length; j += 1) {
      const a = queries[i]; const b = queries[j];
      if (a && b && overlapsWithinClearance(a.bbox, b.bbox, clearance)) candidates.push([i, j]);
      if (candidates.length > MAX_INTERFERENCE_CANDIDATES) {
        return { ok: false as const, refusal: { reason: "too_many_candidates" as const, limit: MAX_INTERFERENCE_CANDIDATES, given: candidates.length } };
      }
    }
    const pairs: InterferencePair[] = [];
    for (const [i, j] of candidates) {
      const gap = await cad.distanceBetween(solids[i]!, solids[j]!);
      if (gap > clearance + CONTACT_EPSILON_MM) continue;
      const overlapVolume = gap <= CONTACT_EPSILON_MM
        ? Math.max(0, await cad.getVolume(await cad.common(solids[i]!, solids[j]!)))
        : 0;
      const hasMeshInput = [selected[i]!, selected[j]!].some((shape) => (shape.importedMesh?.positions?.length ?? 0) >= 9);
      pairs.push({ a: { id: selected[i]!.id, name: selected[i]!.name }, b: { id: selected[j]!.id, name: selected[j]!.name }, gap, overlapVolume, precision: hasMeshInput ? "tessellated" : "exact" });
    }
    pairs.sort((a, b) => a.gap - b.gap || b.overlapVolume - a.overlapVolume || a.a.id.localeCompare(b.a.id));
    return { ok: true as const, value: { shapesChecked: selected.length, candidatePairsChecked: candidates.length, clearance, method: "OCCT exact distance and common volume; AABB candidate prefilter", pairs } };
  });
}
