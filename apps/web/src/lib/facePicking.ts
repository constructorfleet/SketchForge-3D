/** How far the pointer may travel between press and release for a face pick to count as a click. */
export const FACE_PICK_CLICK_TOLERANCE_PX = 4;

type PointerAt = { pointerId: number; clientX: number; clientY: number };

/**
 * Whether a press on a face and its release choose that face in the Faces
 * panel: the same pointer was released, not cancelled, close to where it was
 * pressed, and the press did not move any shape. A short press can still
 * carry a shape across a snap step; that is a move, recorded as one, and it
 * must not also change the chosen face.
 */
export function isFacePickClick(press: PointerAt | null, release: PointerAt & { type: string }, movedShapes: boolean) {
  return Boolean(
    press
    && !movedShapes
    && release.type === "pointerup"
    && release.pointerId === press.pointerId
    && Math.hypot(release.clientX - press.clientX, release.clientY - press.clientY) <= FACE_PICK_CLICK_TOLERANCE_PX,
  );
}
