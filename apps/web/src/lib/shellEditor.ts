import type { WorkplaneShape } from "@/types/sketchforge";
import { LocalizedError, type ErrorKey } from "@/i18n/LocalizedError";
import type { CadModifierMeshPart } from "@/lib/cadModifierTypes";
import { cadBrepTransformForShape } from "@/lib/engine/cadBakeMetadata";
import { exactBooleanPlacement, shapeHasExactBooleanSolid } from "@/lib/engine/exactBooleanParts";
import { draftFaceResultMetadata } from "@/lib/draftFaceEditor";
import { CLEARED_RETAINED_DRAFT_FIELDS } from "@/lib/retainedDrafts";

/** The faces a shell can leave open by name, as the REST API names them. */
export const SHELL_FACE_DIRECTIONS = ["top", "bottom", "left", "right", "front", "back"] as const;
export type ShellFaceDirection = typeof SHELL_FACE_DIRECTIONS[number];

/** A face to leave open: a direction, or a 0-based face index of the shape's exact faces. */
export type ShellOpenFace = ShellFaceDirection | number;

export type ShellRequest = {
  part: CadModifierMeshPart;
  thickness: number;
  openFaces: ShellOpenFace[];
};

/** The exact geometry the shape already carries -- a treated, drafted or STEP-imported solid -- if any. */
function exactBrep(shape: WorkplaneShape) {
  const brep = shape.cadBrep ?? shape.importedMesh?.brepStep;
  return brep && shape.cadBrepFrame ? brep : null;
}

/**
 * Why the selected shape cannot be hollowed, or null when it can.
 *
 * The same lines the REST path draws: a shape carrying an edge treatment or a
 * draft is refused, because nothing could replay the shell under it. Beyond
 * that, the shell needs exact surfaces: the shape's own B-rep, or a primitive
 * the kernel can build from its parameters. A mirrored primitive, a group of
 * loose parts and a plain mesh have neither.
 */
export function shellUnavailable(shape: WorkplaneShape): ErrorKey | null {
  if (shape.hole || shape.imagePlate) return "errors.cadModifier.shell.unsupported";
  if (shape.edgeTreatments?.length || shape.edgeTreatmentHistory?.length
    || shape.draftPrismAngle !== undefined || shape.faceDraft) {
    return "errors.cadModifier.shell.treated";
  }
  if (exactBrep(shape)) return null;
  if (!shape.importedMesh && shapeHasExactBooleanSolid(shape)) return null;
  return "errors.cadModifier.shell.unsupported";
}

/**
 * What the inspector sends the CAD worker to hollow `shape`, or null when it
 * cannot be hollowed at that thickness.
 *
 * The solid is built where the shape stands -- its B-rep moved by the shape's
 * own transform, or a primitive placed as an exact boolean operand is -- so the
 * wall is measured in millimetres at the size the shape is drawn, and the
 * directions are the workplane's.
 */
export function shellRequestForShape(shape: WorkplaneShape, thickness: number, openFaces: ReadonlyArray<ShellOpenFace>): ShellRequest | null {
  if (!Number.isFinite(thickness) || thickness <= 0 || shellUnavailable(shape)) return null;
  const brep = exactBrep(shape);
  const transform = brep ? cadBrepTransformForShape(shape) : undefined;
  const part: CadModifierMeshPart = brep
    ? { brep, ...(transform ? { brepTransform: transform } : {}), hole: false }
    : { exact: { shape, transform: exactBooleanPlacement(shape) }, hole: false };
  return { part, thickness, openFaces: [...openFaces] };
}

/**
 * Face numbers as typed into the inspector, 1-based as the Faces card counts
 * them, read as 0-based indexes; null when any entry is not one of the faces.
 */
export function parseShellFaceNumbers(text: string, faceCount: number): number[] | null {
  const entries = text.split(/[\s,;]+/).filter(Boolean);
  const chosen = new Set<number>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) return null;
    const value = Number(entry);
    if (value < 1 || value > faceCount) return null;
    chosen.add(value - 1);
  }
  return [...chosen].sort((left, right) => left - right);
}

/**
 * The fields a hollowed shape takes besides its new mesh and B-rep.
 *
 * The shell is recorded, as on the REST path, so a rebuild from the source
 * sketch is refused instead of quietly returning the solid body. The faces
 * are new, so they get new identities, and what described the old ones --
 * face colours, edge treatments, drafts -- goes.
 */
export function shelledShapeFields(shapeId: string, faceCount: number, request: Pick<ShellRequest, "thickness" | "openFaces">) {
  const faces = draftFaceResultMetadata(shapeId, faceCount);
  if (!faces) throw new LocalizedError("errors.cadModifier.result.shellFaceCount");
  return {
    ...faces,
    ...CLEARED_RETAINED_DRAFT_FIELDS,
    shell: {
      thickness: request.thickness,
      ...(request.openFaces.length ? { openFaces: [...request.openFaces] } : {}),
    },
  } satisfies Partial<WorkplaneShape>;
}
