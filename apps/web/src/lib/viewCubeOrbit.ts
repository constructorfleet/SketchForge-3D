/** Where the camera sits around its target, as the view cube reads it. */
export type CameraOrbit = {
  yawDegrees: number;
  pitchDegrees: number;
};

/**
 * How far the camera turns per pixel of drag.
 *
 * Matched to the cube's apparent size: dragging across the cube's ~70px face
 * turns the scene about a third of a turn, which feels like pushing the cube
 * itself rather than scrubbing a slider.
 */
export const ORBIT_DEGREES_PER_PIXEL = 0.5;

/**
 * Looking straight down the pole leaves no horizontal direction to derive a
 * yaw from, so the pitch stops just short of it.
 */
export const MAX_ORBIT_PITCH_DEGREES = 89;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The orbit a drag across the view cube lands on.
 *
 * Dragging right turns the scene right — the camera goes the other way, which
 * is what makes the cube feel like a physical object being pushed rather than a
 * camera being steered.
 */
export function orbitFromDrag(
  start: CameraOrbit,
  deltaX: number,
  deltaY: number,
  degreesPerPixel = ORBIT_DEGREES_PER_PIXEL,
): CameraOrbit {
  return {
    yawDegrees: start.yawDegrees - deltaX * degreesPerPixel,
    pitchDegrees: clamp(
      start.pitchDegrees + deltaY * degreesPerPixel,
      -MAX_ORBIT_PITCH_DEGREES,
      MAX_ORBIT_PITCH_DEGREES,
    ),
  };
}

/**
 * Unit direction from the target towards the camera for an orbit.
 *
 * Inverse of the yaw/pitch the viewport reads off the camera, so a direction
 * fed back through that reader returns the orbit it came from.
 */
export function orbitDirection(orbit: CameraOrbit): [number, number, number] {
  const yaw = (orbit.yawDegrees * Math.PI) / 180;
  const pitch = (orbit.pitchDegrees * Math.PI) / 180;
  const horizontal = Math.cos(pitch);
  return [Math.sin(yaw) * horizontal, Math.sin(pitch), Math.cos(yaw) * horizontal];
}
