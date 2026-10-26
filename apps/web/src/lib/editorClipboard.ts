import { canonicalizeShape, cloneWorkplaneShapeTreeWithFreshIds } from "@constructorfleet/sketchforge-engine/workplaneShapes";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { migratePre548CutBrepFrames } from "@constructorfleet/sketchforge-engine/cutBrepFrameMigration";
import type { WorkplaneShape } from "@/types/sketchforge";

const CLIPBOARD_METADATA_KEYS = [
  "material",
  "appearance",
  "faceIds",
  "faceColors",
  "stepAssembly",
  "stepComponent",
  "draftPrismAngle",
  "draftPrismSourceHeight",
  "draftPrismSourceFrame",
  "faceDraft",
  "faceDraftSourceFaceIds",
  "faceDraftSourceSegmentId",
  "faceDraftSourceFrame",
  "faceDraftSourceScale",
  "edgeTreatments",
  "edgeTreatmentHistory",
  "shell",
  "cadDisplayEdges",
  "cadDisplayEdgesVersion",
  "edgeResizeMode",
  "cadBrep",
  "cadBrepFrame",
  "cadPrimitiveFrame",
] as const satisfies readonly (keyof WorkplaneShape)[];

/** Parse the app-owned shape payload stored in the shared and system clipboards. */
export function parseClipboardShapes(serialized: string): WorkplaneShape[] {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    const shapes = parsed.flatMap((candidate: unknown) => {
      if (!candidate || typeof candidate !== "object") return [];
      const shape = candidate as Partial<WorkplaneShape>;
      const { name, kind, color } = shape;
      if (typeof name !== "string" || typeof kind !== "string" || typeof color !== "string") return [];
      const metadata = Object.fromEntries(CLIPBOARD_METADATA_KEYS.flatMap((key) =>
        shape[key] === undefined ? [] : [[key, shape[key]]],
      )) as Partial<WorkplaneShape>;
      return [canonicalizeShape({ ...sceneShape({ ...shape, name, kind, color }), ...metadata })];
    });
    return migratePre548CutBrepFrames(shapes);
  } catch {
    return [];
  }
}

/** Clone clipboard shapes with the same offset used by the editor's Paste command. */
export function pasteClipboardShapes(shapes: WorkplaneShape[]): WorkplaneShape[] {
  return shapes.map((shape) => {
    const pasted = cloneWorkplaneShapeTreeWithFreshIds(shape, "paste");
    return {
      ...pasted,
      x: Math.min(110, shape.x + 12),
      z: Math.min(110, shape.z + 12),
    };
  });
}
