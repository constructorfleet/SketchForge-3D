import type { WorkplaneShape } from "./domain/sketchforge.js";
import { loadOcctKernel } from "./support/lib/brepKernel.js";
import { importedShapeFromStepWithKernel } from "./stepImportCommon.js";

const STEP_EXTENSIONS = new Set(["step", "stp"]);

export function isStepFile(fileName: string): boolean {
  return STEP_EXTENSIONS.has(fileName.split(".").pop()?.toLowerCase() ?? "");
}

/** Import STEP geometry in the browser kernel and keep available component colors. */
export async function importedShapeFromStep(fileName: string, buffer: ArrayBuffer): Promise<WorkplaneShape> {
  const stepText = new TextDecoder().decode(buffer);
  const kernel = await loadOcctKernel();
  return (await importedShapeFromStepWithKernel(kernel, fileName, stepText)).shape;
}
