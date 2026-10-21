/** STEP import on the OCCT kernel directly, rather than through brepjs. */
import { withCadKernel } from "./serverCadKernel.js";
import { importedShapeFromStepWithKernel } from "./stepImportCommon.js";
import type { StepImportSummary } from "./stepImportCommon.js";

export type { StepImportSummary } from "./stepImportCommon.js";

export function importedShapeFromStepOnKernel(fileName: string, stepText: string): Promise<StepImportSummary> {
  return withCadKernel((cad) => importedShapeFromStepWithKernel(cad, fileName, stepText));
}
