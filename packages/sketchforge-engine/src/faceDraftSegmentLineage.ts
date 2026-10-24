import type { WorkplaneShape } from "./domain/sketchforge.js";
import {
  draftFaceForSketchSegmentOnKernel,
  legacyDraftSegmentOnKernel,
  sketchSegmentForDraftFaceOnKernel,
  type SketchFaceSegmentMatch,
} from "./sketchFaceDraftKernel.js";
import { withCadKernel } from "./serverCadKernel.js";

export { uniqueSketchSegmentForSideBoundary, type SketchFaceSegmentMatch } from "./sketchFaceDraftKernel.js";

/** Map a selected source face to its exact sketch line segment, when supported. */
export function sketchSegmentForDraftFace(shape: WorkplaneShape, faceId: string): Promise<SketchFaceSegmentMatch> {
  return withCadKernel((cad) => sketchSegmentForDraftFaceOnKernel(cad, shape, faceId));
}

/** Find the unique source face corresponding to a retained sketch segment. */
export function draftFaceForSketchSegment(shape: WorkplaneShape, segmentId: string): Promise<SketchFaceSegmentMatch> {
  return withCadKernel((cad) => draftFaceForSketchSegmentOnKernel(cad, shape, segmentId));
}

/** Infer segment identity for a legacy draft from its persisted source geometry or saved normal. */
export function legacyDraftSegmentForShape(shape: WorkplaneShape): Promise<SketchFaceSegmentMatch> {
  return withCadKernel((cad) => legacyDraftSegmentOnKernel(cad, shape));
}
