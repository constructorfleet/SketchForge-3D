/**
 * Spreading a selection out evenly (upstream issue #51).
 *
 * Align puts objects on a line; this spaces them along one. Two spacings are
 * useful and they are not the same thing:
 *
 * - `gaps` leaves the same clear space between neighbours, which is what you
 *   want for parts of different sizes -- bolt bosses of two diameters along a
 *   rail, say.
 * - `centers` puts the centres at equal intervals, which is what you want for
 *   a bolt circle or a row of holes at a fixed pitch, whatever their sizes.
 *
 * The outermost two objects never move. They define the span, so they are the
 * one thing the caller has already decided.
 *
 * Pure, and in terms of extents rather than shapes, so the editor can feed it
 * mesh bounds and the tests can feed it numbers.
 *
 * Under `lib/engine/` because the editor is no longer its only caller: the
 * `Engine` distributes a stored project's shapes with no browser in the
 * picture, and it needs the same arithmetic rather than a second copy of it.
 */

export type DistributeSpacing = "gaps" | "centers";

export type DistributeEntry = {
  id: string;
  /** Lowest coordinate of the object along the axis being distributed. */
  min: number;
  /** Highest coordinate along that axis. */
  max: number;
  /** Objects that cannot move: they keep their place and still take up room. */
  locked?: boolean;
};

export type DistributeShift = {
  id: string;
  /** How far this object moves along the axis. */
  delta: number;
};

const DISTRIBUTE_EPSILON = 1e-4;

function center(entry: DistributeEntry) {
  return (entry.min + entry.max) / 2;
}

function extent(entry: DistributeEntry) {
  return Math.max(0, entry.max - entry.min);
}

/**
 * How far each object should move to be evenly spaced, in the order given.
 *
 * Objects already in place are left out rather than returned with a zero
 * delta, so a caller can tell whether anything actually happened -- and an
 * unchanged selection records no undo step.
 *
 * Fewer than three objects has no middle to space out, and a selection whose
 * locked objects are not the outer two cannot be spaced without moving
 * something that must not move: both return nothing.
 */
export function distributeShifts(entries: DistributeEntry[], spacing: DistributeSpacing): DistributeShift[] {
  if (entries.length < 3) return [];

  const ordered = [...entries].sort((a, b) => center(a) - center(b));
  const movable = ordered.slice(1, -1);
  if (movable.some((entry) => entry.locked)) return [];

  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  const targetCenters = spacing === "centers"
    ? evenCenters(first, last, ordered.length)
    : evenGapCenters(ordered, first, last);
  if (!targetCenters) return [];

  const shifts: DistributeShift[] = [];
  ordered.forEach((entry, index) => {
    if (index === 0 || index === ordered.length - 1) return;
    const delta = targetCenters[index] - center(entry);
    if (Math.abs(delta) <= DISTRIBUTE_EPSILON) return;
    shifts.push({ id: entry.id, delta });
  });
  return shifts;
}

/** Equal centre-to-centre pitch between the two outer objects. */
function evenCenters(first: DistributeEntry, last: DistributeEntry, count: number) {
  const span = center(last) - center(first);
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, index) => center(first) + step * index);
}

/**
 * Equal clear space between neighbours.
 *
 * The gap is whatever is left of the span once every object's own width is
 * taken out, divided between them. A selection too crowded to fit -- the
 * objects already overlap -- gives a negative gap, which would shuffle them
 * into each other rather than spacing them, so it is declined.
 */
function evenGapCenters(ordered: DistributeEntry[], first: DistributeEntry, last: DistributeEntry) {
  const span = last.max - first.min;
  const occupied = ordered.reduce((total, entry) => total + extent(entry), 0);
  const gap = (span - occupied) / (ordered.length - 1);
  if (gap < -DISTRIBUTE_EPSILON) return null;

  const centers: number[] = [];
  let cursor = first.min;
  ordered.forEach((entry) => {
    centers.push(cursor + extent(entry) / 2);
    cursor += extent(entry) + gap;
  });
  return centers;
}

/**
 * The axis a selection should be spread along when the caller does not say.
 *
 * The one it is already most spread out on: a row of objects along X is a row
 * whoever made it meant to be a row.
 */
export function widestDistributeAxis(
  entries: Array<{ x: DistributeEntry; z: DistributeEntry }>,
): "x" | "z" | null {
  if (entries.length < 3) return null;
  const spread = (pick: (entry: { x: DistributeEntry; z: DistributeEntry }) => DistributeEntry) => {
    const centers = entries.map((entry) => center(pick(entry)));
    return Math.max(...centers) - Math.min(...centers);
  };
  const alongX = spread((entry) => entry.x);
  const alongZ = spread((entry) => entry.z);
  if (alongX <= DISTRIBUTE_EPSILON && alongZ <= DISTRIBUTE_EPSILON) return null;
  return alongX >= alongZ ? "x" : "z";
}
