import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { LocalizedError } from "@/i18n/LocalizedError";
import type { CadModifierMeshPart } from "./cadModifierTypes";
import { exactCutFromParts, meshedExactCut } from "./engine/exactBooleanSolids";

export function cadShapeIsValid(cad: OcctKernel, shape: ShapeHandle) {
  const validator = (cad as { isValid?: unknown }).isValid;
  if (typeof validator !== "function") throw new Error("isValid is not a function");
  try {
    return Boolean(validator.call(cad, shape));
  } catch {
    return false;
  }
}

/** An exact cut returns serialized geometry; none of its handles are retained. */
export function cadModifierBoolean(
  cad: OcctKernel,
  parts: CadModifierMeshPart[],
  solidFor: (part: CadModifierMeshPart) => ShapeHandle,
) {
  const mark = cad.checkpoint();
  try {
    const exact = exactCutFromParts(cad, parts, solidFor);
    if (!cadShapeIsValid(cad, exact.cut)) throw new LocalizedError("errors.cadModifier.invalidResult");
    return { ...meshedExactCut(cad, exact.cut), fusedVolume: exact.fusedVolume, cutVolume: exact.cutVolume };
  } finally {
    // Includes reconstruction, subshape enumeration and BREP recentering;
    // handles retained by an existing edge-modifier session precede the mark.
    cad.releaseSince(mark);
  }
}
