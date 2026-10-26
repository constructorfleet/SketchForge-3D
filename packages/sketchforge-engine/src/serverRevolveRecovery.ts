/** Recover a legacy partial revolve's natural-frame axis without changing its saved record. */
import type { WorkplaneShape } from "./domain/sketchforge.js";
import { buildSketchRevolveMesh, normalizeSketchRevolveSettings } from "./sketchRevolve.js";
import { serverManifoldRuntime } from "./serverManifoldRuntime.js";

export async function recoverLegacyRevolveShape(shape: WorkplaneShape): Promise<WorkplaneShape> {
  let recovered = shape;
  const settings = normalizeSketchRevolveSettings(shape.sketchRevolve);
  if (!shape.revolveAxisOffset && shape.sketchOperation === "revolve" && shape.sketchProfile
    && shape.importedMesh && settings.pitch === 0 && settings.coreRadius === 0
    && Math.abs(Math.abs(settings.sweepAngle) - 360) > 1e-6) {
    try {
      const replay = buildSketchRevolveMesh(await serverManifoldRuntime(), shape.sketchProfile, settings);
      const stored = shape.importedMesh.positions;
      // A transformed/baked or stale mesh no longer has the replay's frame.
      // Only attach its offset when the retained source reproduces that mesh.
      const tolerance = 1e-5 * Math.max(1, replay.width, replay.height, replay.depth);
      if (stored.length === replay.positions.length
        && stored.every((value, index) => Number.isFinite(value) && Math.abs(value - replay.positions[index]) <= tolerance)) {
        recovered = { ...shape, revolveAxisOffset: replay.axisOffset };
      }
    } catch {
      // An un-replayable legacy record keeps its existing tessellated path.
    }
  }
  if (shape.groupedShapes?.length) {
    const children = await Promise.all(shape.groupedShapes.map(recoverLegacyRevolveShape));
    if (children.some((child, index) => child !== shape.groupedShapes![index])) {
      recovered = { ...recovered, groupedShapes: children };
    }
  }
  return recovered;
}

export function recoverLegacyRevolveShapes(shapes: readonly WorkplaneShape[]): Promise<WorkplaneShape[]> {
  return Promise.all(shapes.map(recoverLegacyRevolveShape));
}
