import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";
import { LocalizedError } from "@/i18n/LocalizedError";
import { meshShapeWithFaceGroups } from "@/lib/engine/cadFaceMesh";

export type DraftFaceRequest = {
  brep: string;
  faceIds: string[];
  faceId: string;
  angle: number;
  pullDirection: "x" | "y" | "z" | "-x" | "-y" | "-z";
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
  /** Triangle start, triangle count and B-rep face index triples, for face colours. */
  faceGroups: number[];
};

const AXIS: Record<DraftFaceRequest["pullDirection"], Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
  "-x": { x: -1, y: 0, z: 0 },
  "-y": { x: 0, y: -1, z: 0 },
  "-z": { x: 0, y: 0, z: -1 },
};

function canonicalDraftRotation(direction: DraftFaceRequest["pullDirection"]) {
  switch (direction) {
    case "x": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: -Math.PI / 2 };
    case "-x": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angle: Math.PI / 2 };
    case "y": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, angle: Math.PI / 2 };
    case "-y": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, angle: -Math.PI / 2 };
    case "z": return null;
    case "-z": return { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, angle: Math.PI };
  }
}

function rotatePoint(point: Vec3, axis: Vec3, angle: number): Vec3 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dot = axis.x * point.x + axis.y * point.y + axis.z * point.z;
  const cross = {
    x: axis.y * point.z - axis.z * point.y,
    y: axis.z * point.x - axis.x * point.z,
    z: axis.x * point.y - axis.y * point.x,
  };
  return {
    x: point.x * cosine + cross.x * sine + axis.x * dot * (1 - cosine),
    y: point.y * cosine + cross.y * sine + axis.y * dot * (1 - cosine),
    z: point.z * cosine + cross.z * sine + axis.z * dot * (1 - cosine),
  };
}

function draftInCanonicalFrame(
  cad: OcctKernel,
  solid: ShapeHandle,
  face: ShapeHandle,
  angle: number,
  direction: DraftFaceRequest["pullDirection"],
): ShapeHandle {
  const rotation = canonicalDraftRotation(direction);
  if (!rotation) throw new Error("The canonical draft direction is unavailable");
  const rotatedSolid = cad.rotate(solid, rotation.axis, rotation.angle);
  const center = rotatePoint(cad.getSurfaceCenterOfMass(face), rotation.axis.direction, rotation.angle);
  const area = cad.getSurfaceArea(face);
  const bounds = cad.getBoundingBox(solid, false);
  const scale = Math.max(1, Math.hypot(
    bounds.xmax - bounds.xmin,
    bounds.ymax - bounds.ymin,
    bounds.zmax - bounds.zmin,
  ));
  const matches = cad.getSubShapes(rotatedSolid, "face").filter((candidate) => {
    const candidateCenter = cad.getSurfaceCenterOfMass(candidate);
    return Math.abs(cad.getSurfaceArea(candidate) - area) <= Math.max(1e-7, area * 1e-8)
      && Math.hypot(candidateCenter.x - center.x, candidateCenter.y - center.y, candidateCenter.z - center.z) <= scale * 1e-8;
  });
  if (matches.length !== 1) throw new Error("Could not identify the selected face after rotating the solid");
  const drafted = cad.draft(rotatedSolid, matches[0]!, angle, { x: 0, y: 0, z: 1 });
  return cad.rotate(drafted, rotation.axis, -rotation.angle);
}

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
    try {
      drafted = draftInCanonicalFrame(cad, solid, face, request.angle * Math.PI / 180, request.pullDirection);
    } catch {
      throw new LocalizedError("errors.cadModifier.draftFaceIncompatible");
    }
  }
  if (request.brepTransform?.length === 12) drafted = cad.generalTransform(drafted, request.brepTransform);
  if (!cad.isValid(drafted) || !cad.isSolid(drafted)) throw new LocalizedError("errors.cadModifier.draftFaceInvalid");
  const mesh = meshShapeWithFaceGroups(cad, drafted, { linearDeflection: 0.035, angularDeflection: 0.16 });
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    faceGroups: mesh.faceGroups,
    faceCount: cad.getSubShapes(drafted, "face").length,
    volume: cad.getVolume(drafted),
    brep: cad.toBREP(drafted),
  };
}
