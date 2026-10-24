/** Split a retained STEP source into positioned, independently editable solids. Node-only. */

import { withCadKernel } from "./serverCadKernel.js";
import { ServerCadError } from "./serverCadOperations.js";
import { assertStepExplodable, explodeStepAssemblyWithKernel, StepExplodeError } from "./stepAssemblyExplode.js";
import type { ProjectAsset, WorkplaneShape } from "./domain/sketchforge.js";

export { MAX_EXPLODE_SOLIDS, MAX_EXPLODE_SOURCE_BYTES } from "./stepAssemblyExplode.js";

function asServerCadError(error: unknown) {
  return error instanceof StepExplodeError ? new ServerCadError(error.message, error.status) : error;
}

/** Turn a STEP-imported mesh shape into one exact mesh/B-rep-backed shape per solid. */
export function explodeStepAssembly(shape: WorkplaneShape, source: ProjectAsset): Promise<WorkplaneShape[]> {
  // Refuse before taking the kernel: a throw inside `withCadKernel` discards it.
  try {
    assertStepExplodable(shape, source);
  } catch (error) {
    return Promise.reject(asServerCadError(error));
  }
  return withCadKernel((cad) => {
    try {
      return explodeStepAssemblyWithKernel(cad, shape, source).shapes;
    } catch (error) {
      throw asServerCadError(error);
    }
  });
}
