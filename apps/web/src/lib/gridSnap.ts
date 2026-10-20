import type { WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

const MIN_VISIBLE_GRID_STEP = 1;
const MAX_VISIBLE_GRID_STEP = 200;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cleanCoordinate(value: number) {
  const rounded = Number(value.toFixed(6));
  return Math.abs(rounded) < 1e-6 ? 0 : rounded;
}

export function visibleGridStep(workspace: WorkplaneWorkspaceSettings) {
  return clamp(workspace.gridBlockSize, MIN_VISIBLE_GRID_STEP, MAX_VISIBLE_GRID_STEP);
}

export type GridFootprintBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/**
 * Move a shape so its footprint sits on the grid.
 *
 * Upstream issue #117: this used to be two kinds of local.
 *
 * The lattice was anchored on the near edge of the workplane (`-width/2` on X,
 * `-depth/2` on Z), so a plate whose span was not a whole number of grid blocks
 * snapped onto lines that passed through neither the world origin nor the lines
 * a pointer drag or an arrow key snap to — and, because width and depth are set
 * separately, the X and Z lattices could be offset differently from one another,
 * which skews a square shape off square with the grid. The lattice now runs
 * through the world origin at multiples of the step, the same lattice
 * `snapToGrid` gives everything else and the same lines the workplane draws.
 *
 * The *reference point* was local too: whichever of the footprint's two edges
 * happened to lie nearest a line was the one placed on it. Which edge that is
 * depends on the shape's size, so two shapes of different sizes came to rest on
 * two different lattices and would not line up with each other. One edge now
 * always decides it — the near corner, `(minX, minZ)` — moved to its *nearest*
 * line, so a snap still never shifts a shape by more than half a block.
 *
 * `bounds` is the shape's world-space, axis-aligned footprint as the caller
 * measures it, so a rotated shape is snapped by its rotated bounding box rather
 * than by any one of its corners, and a footprint that is not centred on the
 * shape's origin is snapped by the footprint rather than by the origin.
 */
export function snapShapeFootprintToVisibleGrid(
  shape: WorkplaneShape,
  bounds: GridFootprintBounds,
  workspace: WorkplaneWorkspaceSettings,
) {
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minZ)) return shape;
  const step = visibleGridStep(workspace);
  return {
    ...shape,
    x: cleanCoordinate(shape.x + gridAlignedDelta(bounds.minX, 0, step)),
    z: cleanCoordinate(shape.z + gridAlignedDelta(bounds.minZ, 0, step)),
  };
}

/** Nearest multiple of the snap grid. A step of 0 (grid off) leaves the value alone. */
export function snapToGrid(value: number, step: number) {
  return step > 0 ? Math.round(value / step) * step : value;
}

/**
 * Snap a dimension — a width, depth or height — onto the grid.
 *
 * The *size* is snapped, not the change in size, so dragging a handle lands on
 * a multiple of the grid whatever the shape started at. A grid coarser than the
 * minimum raises the floor to one full step, so a snapped dimension is never
 * rounded down to something off-grid.
 */
export function snapDimension(value: number, step: number, min = 0.01, max = 220) {
  const snapped = snapToGrid(value, step);
  const effectiveMin = step > 0 ? Math.max(min, Math.min(step, max)) : min;
  return clamp(snapped, effectiveMin, max);
}

/**
 * The movement to apply so that a value which starts at `start` lands on the
 * grid after moving by `rawDelta`.
 *
 * Snapping the movement itself only works when the starting value is already on
 * the grid: an object sitting at 1mm moved by a 5mm grid would land on 6mm,
 * never on the lattice the grid draws. Snapping the destination instead means
 * the object ends up where the grid says, which is what makes a grid global.
 */
export function gridAlignedDelta(start: number, rawDelta: number, step: number) {
  if (!(step > 0)) return rawDelta;
  return snapToGrid(start + rawDelta, step) - start;
}
