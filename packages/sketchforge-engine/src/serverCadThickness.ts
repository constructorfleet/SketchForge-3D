/**
 * Sampled wall-thickness analysis for exact project solids. Node-only.
 *
 * The sampling lives in `cadAnalysis`, which the editor's CAD worker shares;
 * this places the stored shape and runs it on the server's kernel.
 */

import { recoverLegacyRevolveShape } from "./serverRevolveRecovery.js";
import { withCadKernel } from "./serverCadKernel.js";
import { ServerCadError } from "./serverCadOperations.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import { sampledWallThickness, WallThicknessRefusal, type WallThicknessResult } from "./cadAnalysis.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type { WallThicknessResult } from "./cadAnalysis.js";

/**
 * Return the smallest sampled distance between opposing faces. This is a
 * screening estimate, not a medial-axis or certified minimum-thickness result.
 */
export async function wallThickness(shape: WorkplaneShape): Promise<WallThicknessResult> {
  shape = await recoverLegacyRevolveShape(shape);
  return withCadKernel((cad) => {
    try {
      return sampledWallThickness(cad, placedSolidForShape(cad, shape));
    } catch (error) {
      if (error instanceof WallThicknessRefusal) throw new ServerCadError(error.message, error.reason === "too_many_faces" ? 413 : 422);
      throw error;
    }
  });
}
