/**
 * Bringing a selection onto one line.
 *
 * Distribute spaces objects along an axis; this puts an edge or a centre of
 * each on the same coordinate. The editor has done it since there was an
 * Alignment button, but the arithmetic lived inside `SketchForgeEditor.tsx`
 * with the overlay that drives it, so neither the API nor a macro could reach
 * it -- which is why this file exists and why it is shaped like
 * `distributeShapes`: pure, and in terms of extents rather than shapes, so the
 * editor can feed it mesh bounds and a test can feed it numbers.
 *
 * Two things do not move. An anchor is the object the caller nominated as the
 * reference, and a locked object is one that cannot move at all -- so a locked
 * object in the selection becomes the anchor whatever the caller asked for,
 * which is what the editor does and the only reading under which a selection
 * holding one can be aligned at all.
 */

export type AlignAxis = "x" | "y" | "z";
export type AlignTarget = "min" | "center" | "max";

export type AlignEntry = {
  id: string;
  /** Lowest coordinate of the object along the axis being aligned. */
  min: number;
  /** Highest coordinate along that axis. */
  max: number;
  /** An object that cannot move: it anchors the alignment instead. */
  locked?: boolean;
};

export type AlignShift = {
  id: string;
  /** How far this object moves along the axis. */
  delta: number;
};

/**
 * Half a thousandth of a millimetre, the editor's own alignment tolerance.
 *
 * Coordinates are stored rounded to four decimals, so anything smaller than
 * this cannot be represented in the project and a shift of it would be written
 * as no shift at all.
 */
export const ALIGN_EPSILON = 0.0005;

/** The coordinate an entry's chosen edge or centre sits at. */
export function alignCoordinate(entry: Pick<AlignEntry, "min" | "max">, target: AlignTarget) {
  if (target === "min") return entry.min;
  if (target === "max") return entry.max;
  return (entry.min + entry.max) / 2;
}

/**
 * The entry everything else lines up against, or null for the selection's own box.
 *
 * A locked object wins over the requested anchor, and over a second locked one
 * the first in the selection wins -- an arbitrary choice, but the alternative
 * is refusing a selection with two locked objects in it, and aligning the rest
 * to one of them is the more useful answer and the one the editor gives. A
 * requested anchor that is not in the selection is ignored rather than
 * refused, because the selection is what the caller is aligning.
 */
export function effectiveAlignAnchorId(entries: readonly AlignEntry[], requestedAnchorId?: string | null) {
  const locked = entries.find((entry) => entry.locked);
  if (locked) return locked.id;
  return requestedAnchorId && entries.some((entry) => entry.id === requestedAnchorId) ? requestedAnchorId : null;
}

/**
 * How far each object should move to be aligned, in the order given.
 *
 * Objects already in place are left out rather than returned with a zero
 * delta, so a caller can tell whether anything actually happened -- the same
 * promise `distributeShifts` makes, and what lets an unchanged selection
 * record no undo step.
 *
 * Fewer than two objects has nothing to align *to*: one object is already
 * flush with itself.
 */
export function alignShifts(
  entries: readonly AlignEntry[],
  target: AlignTarget,
  anchorId?: string | null,
): AlignShift[] {
  if (entries.length < 2) return [];

  const anchor = anchorId ? entries.find((entry) => entry.id === anchorId) ?? null : null;
  const reference = anchor ?? {
    min: Math.min(...entries.map((entry) => entry.min)),
    max: Math.max(...entries.map((entry) => entry.max)),
  };
  const targetValue = alignCoordinate(reference, target);

  const shifts: AlignShift[] = [];
  entries.forEach((entry) => {
    if (entry.locked || entry.id === anchorId) return;
    const delta = targetValue - alignCoordinate(entry, target);
    if (Math.abs(delta) <= ALIGN_EPSILON) return;
    shifts.push({ id: entry.id, delta });
  });
  return shifts;
}
