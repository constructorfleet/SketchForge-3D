import type { WorkplaneShape } from "@/types/sketchforge";
import { cadBrepTransformForShape } from "@/lib/engine/cadBakeMetadata";
import { createLocalId } from "@/lib/engine/localIds";
import { projectShapesFingerprint } from "@/lib/engine/editorHistory";

export const DRAFT_FACE_PULL_AXES = ["x", "y", "z"] as const;
export type DraftFacePullAxis = typeof DRAFT_FACE_PULL_AXES[number];

export function isDraftFaceAngle(angle: number) {
  return Number.isFinite(angle) && angle !== 0 && Math.abs(angle) < 45;
}

export function draftFaceRequestForShape(
  shape: WorkplaneShape,
  faceIndex: number,
  angle: number,
  pullDirection: "x" | "y" | "z",
) {
  const brep = shape.cadBrep ?? shape.importedMesh?.brepStep;
  if (!brep || !Number.isInteger(faceIndex) || faceIndex < 0 || !isDraftFaceAngle(angle)) return null;
  const faceIds = shape.faceIds?.length ? shape.faceIds : Array.from({ length: faceIndex + 1 }, (_, i) => `${shape.id}-face-index-${i}`);
  const faceId = faceIds[faceIndex];
  if (!faceId || new Set(faceIds).size !== faceIds.length) return null;
  const transform = cadBrepTransformForShape(shape);
  return {
    brep,
    faceIds,
    faceId,
    angle,
    pullDirection,
    ...(transform ? { brepTransform: transform } : {}),
  };
}

export async function applyDraftFaceSelection(
  shape: WorkplaneShape,
  faceIndex: number,
  angle: number,
  pullDirection: DraftFacePullAxis,
  onApply: (faceIndex: number, angle: number, pullDirection: DraftFacePullAxis) => Promise<void> | void,
) {
  if (!draftFaceRequestForShape(shape, faceIndex, angle, pullDirection)) return false;
  await onApply(faceIndex, angle, pullDirection);
  return true;
}

export function draftFaceResultMetadata(shapeId: string, faceCount: number) {
  if (!Number.isInteger(faceCount) || faceCount < 1) return null;
  return {
    faceIds: Array.from({ length: faceCount }, () => createLocalId(`${shapeId}-face`)),
    faceColors: undefined,
    edgeTreatments: undefined,
    edgeTreatmentHistory: undefined,
    cadDisplayEdges: undefined,
    cadDisplayEdgesVersion: undefined,
  };
}

export function faceDraftSourceIsCurrent(
  source: WorkplaneShape,
  current: WorkplaneShape | undefined,
  sourceProjectId: string | null,
  currentProjectId: string | null,
  sourceFingerprint: string,
) {
  return Boolean(current && current.id === source.id
    && currentProjectId === sourceProjectId
    && projectShapesFingerprint([current]) === sourceFingerprint);
}
