/**
 * The arithmetic every parameterised part repeats.
 *
 * A row of holes and a bolt circle are the two things a macro computes before
 * it does anything interesting, and getting the centring or the first angle
 * wrong is the commonest way for a generated part to be subtly unusable.
 */

export type Point2 = { x: number; z: number };

/**
 * `count` positions `spacing` apart, centred on `center`.
 *
 * Centred rather than starting at the origin, because a row of holes is
 * specified relative to the plate it is in, and an odd count should put one
 * hole on the centreline.
 */
export function centeredOffsets(count: number, spacing: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("A row needs a whole count of at least 1.");
  const span = (count - 1) * spacing;
  return Array.from({ length: count }, (_, index) => index * spacing - span / 2);
}

export function row(count: number, spacing: number, center: Point2 = { x: 0, z: 0 }): Point2[] {
  return centeredOffsets(count, spacing).map((offset) => ({ x: center.x + offset, z: center.z }));
}

/** A `columns` by `rows` grid, centred, with its own pitch in each direction. */
export function grid(
  columns: number,
  rows: number,
  spacing: { x: number; z: number },
  center: Point2 = { x: 0, z: 0 },
): Point2[] {
  const across = centeredOffsets(columns, spacing.x);
  const down = centeredOffsets(rows, spacing.z);
  return down.flatMap((line) => across.map((column) => ({ x: center.x + column, z: center.z + line })));
}

/**
 * `count` positions evenly spaced on a circle of `radius`.
 *
 * `startAngle` is in degrees and measured from +x towards +z, so 0 puts the
 * first position at the three o'clock mark of the top view.
 */
export function ring(
  count: number,
  radius: number,
  options: { center?: Point2; startAngle?: number } = {},
): Point2[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("A ring needs a whole count of at least 1.");
  const center = options.center ?? { x: 0, z: 0 };
  const start = ((options.startAngle ?? 0) * Math.PI) / 180;
  return Array.from({ length: count }, (_, index) => {
    const angle = start + (index * 2 * Math.PI) / count;
    return {
      x: center.x + radius * Math.cos(angle),
      z: center.z + radius * Math.sin(angle),
    };
  });
}

/** Rounded to a tenth of a micron, so a computed position reads as a number rather than a float. */
export function mm(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
