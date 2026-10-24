import type { WorkplaneShape } from "@/types/sketchforge";
import { shapeHasExactBooleanSolid } from "@/lib/engine/exactBooleanParts";

/** The colour the viewport paints the face chosen in the inspector's face tools. */
export const FACE_HIGHLIGHT_COLOR = "#ffb400";

/** Whether the shape has exact B-rep faces that can be coloured or drafted. */
export function shapeHasExactFaces(shape: WorkplaneShape) {
  return Boolean(shape.cadBrep || shape.importedMesh?.brepStep);
}

/**
 * Whether "Enable face editing" can turn this shape into exact geometry: a
 * solid built from its own parameters by a kernel primitive, not yet exact.
 */
export function faceEditingCanBeEnabled(shape: WorkplaneShape) {
  // An imported picture is a box carrying the image, which the rebuild would drop.
  // A tilted shape's exact solid is turned about its base, not its centre, so
  // the rebuilt shape would move (#420).
  return !shape.hole && !shape.imagePlate && !shape.rotationX && !shape.rotationZ
    && !shapeHasExactFaces(shape) && !shape.importedMesh && shapeHasExactBooleanSolid(shape);
}

/** How many faces the shape has, from its stable face IDs or else its mesh's face groups; 0 when unknown. */
export function shapeFaceCount(shape: WorkplaneShape) {
  if (shape.faceIds?.length) return shape.faceIds.length;
  const groups = shape.importedMesh?.faceGroups;
  let count = 0;
  for (let group = 2; groups && group < groups.length; group += 3) count = Math.max(count, groups[group]! + 1);
  return count;
}

/** The key a face's colour is stored under: its stable ID when there is one, else its index. */
export function shapeFaceKey(shape: WorkplaneShape, faceIndex: number) {
  return shape.faceIds?.[faceIndex] ?? String(faceIndex);
}

/**
 * The shape's face colours with one face set to `color`, or cleared for null.
 * The colour goes under the face's stable ID, and any colour stored under its
 * number (which the API keeps when a request used numbers) is removed, so the
 * face never ends up with two entries or a colour "Clear" cannot reach.
 */
export function faceColorsWith(shape: WorkplaneShape, faceIndex: number, color: string | null): Record<string, string> {
  const next = { ...(shape.faceColors ?? {}) };
  delete next[String(faceIndex)];
  const key = shapeFaceKey(shape, faceIndex);
  if (color === null) delete next[key];
  else next[key] = color;
  return next;
}

/**
 * A display-only copy of the shape with one uncoloured face painted in the
 * highlight colour. It is only ever handed to the viewport's renderer, never
 * stored.
 */
export function withFaceHighlight(shape: WorkplaneShape, faceIndex: number): WorkplaneShape {
  if (!shape.importedMesh?.faceGroups?.length) return shape;
  const key = shapeFaceKey(shape, faceIndex);
  // A coloured face is already marked by its colour, and the person choosing it
  // wants to see that colour, not the highlight over it.
  if (shape.faceColors?.[key] ?? shape.faceColors?.[String(faceIndex)]) return shape;
  return { ...shape, faceColors: { ...(shape.faceColors ?? {}), [key]: FACE_HIGHLIGHT_COLOR } };
}
