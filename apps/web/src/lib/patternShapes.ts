/**
 * Repeating a selection: linear rows and circular rings.
 *
 * Distribute re-spaces objects that already exist; this makes the copies. It
 * is the difference between placing eight bolt holes by hand and asking for
 * eight -- and once a thread or a hole is a catalog pick, placing a ring of
 * them is the next thing anyone wants.
 *
 * Pure, and in terms of placements rather than shapes: the caller owns what a
 * copy of a shape is (ids, meshes, grouped children), and this owns where the
 * copies go. That keeps the arithmetic testable without a scene.
 */

export type PatternPlacement = {
  /** Which copy this is, counting the original as 0. */
  index: number;
  /** Offset from the original, in workplane coordinates. */
  dx: number;
  dz: number;
  /** Extra turn about the vertical axis, in degrees. */
  rotation: number;
};

export const MIN_PATTERN_COUNT = 2;
export const MAX_PATTERN_COUNT = 200;

function clampCount(count: number) {
  if (!Number.isFinite(count)) return MIN_PATTERN_COUNT;
  return Math.min(MAX_PATTERN_COUNT, Math.max(MIN_PATTERN_COUNT, Math.round(count)));
}

export type LinearPatternRequest = {
  /** Total copies including the original, so 1 would be a no-op. */
  count: number;
  /** Centre-to-centre step along each axis, in mm. */
  stepX?: number;
  stepZ?: number;
};

/**
 * A row, counting the original as the first item.
 *
 * The step is centre to centre rather than a gap, because that is what a hole
 * pitch is: "eight at 20mm" is unambiguous, where "eight with 20mm between
 * them" depends on how wide they are.
 */
export function linearPatternPlacements(request: LinearPatternRequest): PatternPlacement[] {
  const count = clampCount(request.count);
  const stepX = Number.isFinite(request.stepX) ? (request.stepX as number) : 0;
  const stepZ = Number.isFinite(request.stepZ) ? (request.stepZ as number) : 0;
  if (stepX === 0 && stepZ === 0) return [];

  const placements: PatternPlacement[] = [];
  for (let index = 1; index < count; index += 1) {
    placements.push({ index, dx: stepX * index, dz: stepZ * index, rotation: 0 });
  }
  return placements;
}

export type CircularPatternRequest = {
  /** Total copies including the original. */
  count: number;
  /** Centre of the ring, in workplane coordinates. */
  centerX: number;
  centerZ: number;
  /** How far round to spread them; 360 closes the ring. */
  sweepAngle?: number;
  /**
   * Whether each copy turns to face the centre as it goes round.
   *
   * A bolt hole does not care, but a spoke, a tooth or a vane does -- without
   * it they all point the way the original did, which reads as a mistake.
   */
  rotateCopies?: boolean;
};

const FULL_TURN = 360;

/**
 * A ring about a point, counting the original as the first item.
 *
 * A full turn divides by the number of copies, so eight of them land every 45
 * degrees and the last does not sit on the first. A partial sweep divides by
 * the gaps instead, so "three across 90 degrees" puts one at each end and one
 * in the middle -- which is what someone asking for a quarter arc means.
 */
export function circularPatternPlacements(
  request: CircularPatternRequest,
  origin: { x: number; z: number },
): PatternPlacement[] {
  const count = clampCount(request.count);
  const sweep = Number.isFinite(request.sweepAngle) ? (request.sweepAngle as number) : FULL_TURN;
  if (sweep === 0) return [];

  const closed = Math.abs(Math.abs(sweep) - FULL_TURN) < 1e-9;
  const step = sweep / (closed ? count : count - 1);
  const radiusX = origin.x - request.centerX;
  const radiusZ = origin.z - request.centerZ;

  const placements: PatternPlacement[] = [];
  for (let index = 1; index < count; index += 1) {
    const angle = (step * index * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Turned about the ring's centre, so the copy keeps its distance from it.
    const x = request.centerX + radiusX * cos - radiusZ * sin;
    const z = request.centerZ + radiusX * sin + radiusZ * cos;
    placements.push({
      index,
      dx: x - origin.x,
      dz: z - origin.z,
      rotation: request.rotateCopies === false ? 0 : -step * index,
    });
  }
  return placements;
}

/**
 * A step that clears the selection, for a first guess at a row.
 *
 * Offering a step of zero would place every copy on top of the original, which
 * looks like nothing happened; one selection width plus a margin at least puts
 * the copies where they can be seen and dragged.
 */
export function suggestedLinearStep(extent: number) {
  return Math.max(1, Math.round((extent + Math.max(2, extent * 0.2)) * 10) / 10);
}
