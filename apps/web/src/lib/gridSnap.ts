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

function nearestVisibleGridLine(value: number, workspaceSize: number, step: number) {
  const gridOrigin = -workspaceSize / 2;
  return gridOrigin + Math.round((value - gridOrigin) / step) * step;
}

export function snapShapeFootprintToVisibleGrid(
  shape: WorkplaneShape,
  bounds: GridFootprintBounds,
  workspace: WorkplaneWorkspaceSettings,
) {
  const step = visibleGridStep(workspace);
  const xOffsets = [bounds.minX, bounds.maxX].map((value) => nearestVisibleGridLine(value, workspace.width, step) - value);
  const zOffsets = [bounds.minZ, bounds.maxZ].map((value) => nearestVisibleGridLine(value, workspace.depth, step) - value);
  const deltaX = xOffsets.reduce((best, value) => Math.abs(value) < Math.abs(best) ? value : best);
  const deltaZ = zOffsets.reduce((best, value) => Math.abs(value) < Math.abs(best) ? value : best);
  return {
    ...shape,
    x: cleanCoordinate(shape.x + deltaX),
    z: cleanCoordinate(shape.z + deltaZ),
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
