/**
 * Exact, bounded interference checks between positioned project solids.
 *
 * The analysis itself lives in `cadAnalysis`, which the editor's CAD worker
 * shares; this places the stored shapes and runs it on the server's kernel.
 */

import { recoverLegacyRevolveShapes } from "./serverRevolveRecovery.js";
import { withCadKernel } from "./serverCadKernel.js";
import { placedSolid } from "./serverShapeBooleans.js";
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
  let selected = shapes.filter((shape) => !shape.hidden && !shape.hole && (!ids || ids.has(shape.id)));
  // Refuse before the kernel is even reached: an oversized request costs nothing.
  const refusal = interferenceRequestRefusal(selected.length, clearance);
  if (refusal) return { ok: false, refusal };
  selected = await recoverLegacyRevolveShapes(selected);

  return withCadKernel((cad) => interferenceBetweenSolids(
    cad,
    selected.map((shape) => {
      // Built here rather than in `solidFor`, because which representation a
      // solid came from is only known once it has been built: whether a
      // boolean result's B-rep passed its check (#541), or a group record's
      // members fell back to their triangles. The pair's precision says so.
      const { solid, provenance } = placedSolid(cad, shape);
      return { id: shape.id, name: shape.name, tessellated: provenance.precision === "tessellated", solid };
    }),
    (operand) => operand.solid,
    clearance,
  ));
}
