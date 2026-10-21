import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";
import { LocalizedError } from "@/i18n/LocalizedError";

export type DraftFaceRequest = {
  brep: string;
  faceIds: string[];
  faceId: string;
  angle: number;
  pullDirection: "x" | "y" | "z";
  brepTransform?: number[];
};

export type DraftFaceResult = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  faceCount: number;
  volume: number;
  brep: string;
};

const AXIS: Record<DraftFaceRequest["pullDirection"], Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

export function buildFaceDraft(cad: OcctKernel, request: DraftFaceRequest): DraftFaceResult {
  if (!request.brep || !Number.isFinite(request.angle) || request.angle === 0 || Math.abs(request.angle) >= 45) {
    throw new LocalizedError("errors.cadModifier.draftFaceInvalid");
  }
  const indices = request.faceIds.flatMap((id, index) => id === request.faceId ? [index] : []);
  if (indices.length !== 1) throw new LocalizedError("errors.cadModifier.draftFaceNotFound");
  const solid = cad.fromBREP(request.brep);
  const face = cad.getSubShapes(solid, "face")[indices[0]!];
  if (!face) throw new LocalizedError("errors.cadModifier.draftFaceNotFound");

  let drafted: ShapeHandle;
  try {
    drafted = cad.draft(solid, face, request.angle * Math.PI / 180, AXIS[request.pullDirection]);
  } catch {
    throw new LocalizedError("errors.cadModifier.draftFaceIncompatible");
  }
  if (request.brepTransform?.length === 12) drafted = cad.generalTransform(drafted, request.brepTransform);
  if (!cad.isValid(drafted) || !cad.isSolid(drafted)) throw new LocalizedError("errors.cadModifier.draftFaceInvalid");
  const mesh = cad.tessellate(drafted, { linearDeflection: 0.035, angularDeflection: 0.16 });
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    faceCount: cad.getSubShapes(drafted, "face").length,
    volume: cad.getVolume(drafted),
    brep: cad.toBREP(drafted),
  };
}
