import type { PlacementWorkplane } from "@/lib/placementWorkplane";
import { DEFAULT_CAMERA_ORIENTATION, screenAlignedNudge, type CameraOrientation } from "@/lib/screenAlignedNudge";
import { cleanNearZero } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export type KeyboardMovementEvent = Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "shiftKey">;

export function isMovementKey(key: string) {
  return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key);
}

/** The screen direction an arrow points, before any view is taken into account. */
function screenDirectionForKey(key: string) {
  switch (key) {
    case "ArrowLeft": return { right: -1, down: 0 };
    case "ArrowRight": return { right: 1, down: 0 };
    case "ArrowUp": return { right: 0, down: -1 };
    default: return { right: 0, down: 1 };
  }
}

export function moveShapesByKeyboard(
  shapes: WorkplaneShape[], selectedIds: string[], event: KeyboardMovementEvent, workplane: PlacementWorkplane,
  // Distance one press moves, from keyboardNudgeStep: the snap grid, so a
  // nudge lands on the same lattice a pointer drag snaps to. Shift is already
  // folded in by the caller, which is the only place that knows the grid.
  step: number,
  // Where the camera stands, so an arrow moves the selection towards the
  // workplane axis closest to the direction it points on screen. Defaults to
  // the Front view, the fixed mapping these keys had before.
  camera: CameraOrientation = DEFAULT_CAMERA_ORIENTATION,
) {
  if (!isMovementKey(event.key)) return shapes;
  // Ctrl/Cmd + Up/Down changes elevation along the plane normal. That is not a
  // direction on screen, so the view does not enter into it.
  const vertical = (event.ctrlKey || event.metaKey) && (event.key === "ArrowUp" || event.key === "ArrowDown");
  const selected = new Set(selectedIds);
  let translation: { x: number; y: number; z: number };
  if (vertical) {
    const delta = step * (event.key === "ArrowUp" ? 1 : -1);
    translation = { x: workplane.normal.x * delta, y: workplane.normal.y * delta, z: workplane.normal.z * delta };
  } else {
    const screen = screenDirectionForKey(event.key);
    const aligned = screenAlignedNudge(workplane, camera, screen.right * step, screen.down * step);
    translation = {
      x: workplane.xAxis.x * aligned.x + workplane.zAxis.x * aligned.z,
      y: workplane.xAxis.y * aligned.x + workplane.zAxis.y * aligned.z,
      z: workplane.xAxis.z * aligned.x + workplane.zAxis.z * aligned.z,
    };
  }
  let changed = false;
  const next = shapes.map((shape) => {
    if (!selected.has(shape.id) || shape.locked) return shape;
    const x = cleanNearZero(shape.x + translation.x);
    const z = cleanNearZero(shape.z + translation.z);
    const elevation = cleanNearZero((shape.elevation ?? 0) + translation.y);
    if (x === shape.x && z === shape.z && elevation === (shape.elevation ?? 0)) return shape;
    changed = true;
    return { ...shape, x, z, elevation };
  });
  return changed ? next : shapes;
}

// Keep this controller independent of render closures: every repeat must move
// the latest scene, and rerenders must not end the press-to-release interaction.
export function createKeyboardMovementInteraction(callbacks: {
  begin: () => boolean;
  move: (event: KeyboardMovementEvent) => void;
  end: () => void;
}) {
  const pressed = new Set<string>();
  const finish = () => {
    if (pressed.size === 0) return;
    pressed.clear();
    callbacks.end();
  };
  return {
    keyDown(event: KeyboardMovementEvent) {
      if (!isMovementKey(event.key)) return false;
      // A repeat after focus loss or interruption cannot start a new gesture.
      if (pressed.size === 0 && (event.repeat || !callbacks.begin())) return false;
      pressed.add(event.key);
      callbacks.move(event);
      return true;
    },
    keyUp(key: string) {
      if (!pressed.has(key)) return;
      if (pressed.size === 1) finish();
      else pressed.delete(key);
    },
    finish,
  };
}
