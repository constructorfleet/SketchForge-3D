// Imported by the CAD modifier worker: use only "@/i18n/LocalizedError" here, never "@/i18n".
/**
 * How the CAD modifier worker rebuilds the parts it is sent as one OCCT
 * solid: a box primitive, an exact part, a stored B-rep placed by its
 * transform, or a mesh. Out of the worker so a test can build exactly the
 * solid the worker numbers edges on (#540).
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { LocalizedError } from "@/i18n/LocalizedError";
import type { CadModifierMeshPart, CadModifierPrimitivePart } from "@/lib/cadModifierTypes";
import { cadTransformRequiresGeneralTransform } from "@/lib/cadModifierRuntime";
import { exactPartSolid } from "@/lib/engine/exactBooleanSolids";
import { cadShapeIsValid } from "@/lib/cadModifierBoolean";
import { meshPartSolid } from "@/lib/cadModifierMeshSolid";

function isCadTransform(transform: number[] | undefined): transform is number[] {
  return Boolean(transform?.length === 12 && transform.every(Number.isFinite));
}

function isIdentityCadTransform(transform: number[]) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  return transform.every((value, index) => Math.abs(value - identity[index]) < 1e-9);
}

function applyCadTransform(cad: OcctKernel, shape: ShapeHandle, transform: number[] | undefined) {
  if (!isCadTransform(transform) || isIdentityCadTransform(transform)) return shape;
  if (cadTransformRequiresGeneralTransform(transform)) {
    return cad.generalTransform(shape, transform);
  }
  try {
    return cad.transform(shape, transform);
  } catch {
    return cad.generalTransform(shape, transform);
  }
}

function reconstructPrimitiveSolid(cad: OcctKernel, primitive: CadModifierPrimitivePart) {
  if (primitive.kind !== "box") {
    throw new Error(`Unsupported CAD primitive: ${primitive.kind}`);
  }
  const width = primitive.width;
  const depth = primitive.depth;
  const height = primitive.height;
  if (![width, depth, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new LocalizedError("errors.cadModifier.invalidPrimitiveDimensions");
  }
  const solid = cad.makeBoxFromCorners(
    { x: -width / 2, y: 0, z: -depth / 2 },
    { x: width / 2, y: height, z: depth / 2 },
  );
  const transformed = applyCadTransform(cad, solid, primitive.transform);
  if (!cad.isSolid(transformed) || !cadShapeIsValid(cad, transformed)) {
    throw new LocalizedError("errors.cadModifier.primitiveNotSolid");
  }
  return transformed;
}

export function reconstructSolid(cad: OcctKernel, part: CadModifierMeshPart) {
  if (part.primitive) {
    return reconstructPrimitiveSolid(cad, part.primitive);
  }
  if (part.exact) {
    // Built from the shape's own parameters, so the operand carries true
    // surfaces into the boolean rather than a tessellation of them.
    return exactPartSolid(cad, part.exact);
  }
  if (part.brep) {
    let exact = cad.fromBREP(part.brep);
    if (part.brepTransform?.length === 12) exact = cad.generalTransform(exact, part.brepTransform);
    const restoredSolids = cad.getSubShapes(exact, "solid");
    if (cadShapeIsValid(cad, exact) && (cad.isSolid(exact) || restoredSolids.length > 0)) {
      return restoredSolids.length === 1 ? restoredSolids[0] : exact;
    }
    exact = cad.fixShape(exact);
    exact = cad.fixFaceOrientations(exact);
    if (cad.isSolid(exact)) exact = cad.healSolid(exact, 1e-5);
    const healedSolids = cad.getSubShapes(exact, "solid");
    if (cadShapeIsValid(cad, exact) && (cad.isSolid(exact) || healedSolids.length > 0)) {
      return healedSolids.length === 1 ? healedSolids[0] : exact;
    }
    throw new LocalizedError("errors.cadModifier.storedFeatureInvalid");
  }
  return meshPartSolid(cad, part);
}

export function reconstructParts(cad: OcctKernel, parts: CadModifierMeshPart[]) {
  const solids = parts.filter((part) => !part.hole).map((part) => reconstructSolid(cad, part));
  const holes = parts.filter((part) => part.hole).map((part) => reconstructSolid(cad, part));
  if (solids.length === 0) throw new LocalizedError("errors.cadModifier.noSolidBody");
  let result = solids[0];
  for (let index = 1; index < solids.length; index += 1) {
    result = cad.fuse(result, solids[index]);
    result = cad.simplify(result);
    result = cad.unifySameDomain(result);
  }
  for (const hole of holes) {
    result = cad.cut(result, hole);
    result = cad.simplify(result);
    result = cad.unifySameDomain(result);
  }
  result = cad.fixShape(result);
  result = cad.simplify(result);
  result = cad.unifySameDomain(result);
  if (!cadShapeIsValid(cad, result)) throw new LocalizedError("errors.cadModifier.groupRepairFailed");
  return result;
}
