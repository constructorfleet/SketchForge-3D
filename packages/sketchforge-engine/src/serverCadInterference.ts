/**
 * Exact, bounded interference checks between positioned project solids.
 *
 * The analysis itself lives in `cadAnalysis`, which the editor's CAD worker
 * shares; this places the stored shapes and runs it on the server's kernel.
 */

import { withCadKernel } from "./serverCadKernel.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import { hasExactRevolveSolid } from "./serverCadOperations.js";
import { interferenceBetweenSolids, interferenceRequestRefusal, type InterferenceResult } from "./cadAnalysis.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export {
  INTERFERENCE_METHOD,
  MAX_INTERFERENCE_CANDIDATES,
  MAX_INTERFERENCE_SHAPES,
  type InterferencePair,
  type InterferenceRefusal,
  type InterferenceReport,
} from "./cadAnalysis.js";

export type InterferenceRequest = { ids?: readonly string[]; clearance?: number };

/**
 * Check all selected visible non-cutter solids. Work is bounded before OCCT
 * distance calculations; exceeding either cap refuses the entire request.
 */
export async function checkInterference(shapes: readonly WorkplaneShape[], request: InterferenceRequest = {}): Promise<InterferenceResult> {
  const clearance = request.clearance ?? 0;
  const ids = request.ids ? new Set(request.ids) : null;
  const selected = shapes.filter((shape) => !shape.hidden && !shape.hole && (!ids || ids.has(shape.id)));
  // Refuse before the kernel is even reached: an oversized request costs nothing.
  const refusal = interferenceRequestRefusal(selected.length, clearance);
  if (refusal) return { ok: false, refusal };

  return withCadKernel((cad) => interferenceBetweenSolids(
    cad,
    selected.map((shape) => ({ id: shape.id, name: shape.name, tessellated: (shape.importedMesh?.positions?.length ?? 0) >= 9 && !hasExactRevolveSolid(shape), shape })),
    (operand) => placedSolidForShape(cad, operand.shape),
    clearance,
  ));
}
