/**
 * Which projection the viewport camera uses.
 *
 * Perspective reads like an eye and is the friendlier view to model in.
 * Orthographic is the one CAD work needs: parallel edges stay parallel, so two
 * faces that line up look like they line up and a dimension read off the screen
 * means the same thing wherever in the frame it sits.
 */
export type CameraProjection = "perspective" | "orthographic";

export const CAMERA_PROJECTIONS: readonly CameraProjection[] = ["perspective", "orthographic"];

export const DEFAULT_CAMERA_PROJECTION: CameraProjection = "perspective";

/**
 * The projection a stored value asks for.
 *
 * A project saved before the setting existed, or by a build that spelled it
 * differently, carries no usable value — those fall back rather than leaving the
 * viewport with a projection the camera code cannot build.
 */
export function normalizeCameraProjection(
  value: unknown,
  fallback: CameraProjection = DEFAULT_CAMERA_PROJECTION,
): CameraProjection {
  return CAMERA_PROJECTIONS.includes(value as CameraProjection) ? (value as CameraProjection) : fallback;
}

export function toggledCameraProjection(current: CameraProjection): CameraProjection {
  return current === "orthographic" ? "perspective" : "orthographic";
}

function usableFovRadians(fovDegrees: number) {
  // A field of view of 0 or 180 degrees has no finite half-height, and a camera
  // never legitimately has one; clamping keeps the two conversions below from
  // handing the camera a 0 or an Infinity.
  const clamped = Math.min(179, Math.max(1, Number.isFinite(fovDegrees) ? fovDegrees : 1));
  return (clamped * Math.PI) / 180;
}

/**
 * Half the height of what a perspective camera sees at a given distance.
 *
 * This is what makes switching projections leave the view where it was: the
 * orthographic frustum is built to be exactly as tall as the perspective camera's
 * view already was at the orbit target, so the scene stays the same size on
 * screen and the camera keeps its position and direction.
 */
export function orthographicHalfHeightAtDistance(distance: number, fovDegrees: number) {
  const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 0;
  return Math.max(1e-3, safeDistance * Math.tan(usableFovRadians(fovDegrees) / 2));
}

/**
 * How far back a perspective camera has to sit to see a given half-height.
 *
 * The inverse of `orthographicHalfHeightAtDistance`, so going orthographic and
 * back lands on the distance it started at.
 */
export function perspectiveDistanceForHalfHeight(halfHeight: number, fovDegrees: number) {
  const safeHalfHeight = Number.isFinite(halfHeight) && halfHeight > 0 ? halfHeight : 0;
  return safeHalfHeight / Math.tan(usableFovRadians(fovDegrees) / 2);
}

/**
 * Half the height an orthographic camera actually sees, zoom included.
 *
 * Zoom means something different either side of the switch: a perspective camera
 * is zoomed by moving it, an orthographic one by shrinking its frustum, since
 * moving an orthographic camera along its own axis changes nothing at all on
 * screen. Reading the zoom back out here is what lets a view zoomed in
 * orthographically come back to the matching perspective distance.
 */
export function orthographicVisibleHalfHeight(frustumHeight: number, zoom: number) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const safeHeight = Number.isFinite(frustumHeight) && frustumHeight > 0 ? frustumHeight : 0;
  return Math.max(1e-3, safeHeight / (2 * safeZoom));
}
