/**
 * Selected-edge identity by sketch lineage (#350).
 *
 * An edge index from `GET /edges` names an edge of one topology; a sketch edit
 * rebuilds the solid and the same index can name a different edge, or none.
 * A cap edge of a straight, single-region sketch extrusion has a source that
 * survives the edit: the sketch segment swept to make it and the cap (bottom
 * or top) it lies on. This maps one to the other in both directions with the
 * same endpoint test the face-draft lineage uses (`sketchFaceDraftKernel`), and
 * answers `missing` or `ambiguous` rather than guessing.
 *
 * Indexes are taken from `edgeSolidForShape`, the solid `GET /edges` and
 * `POST /treatments` both number, so a recorded index and a replayed one name
 * the edge the treatment rounds. The matcher itself is in
 * `sketchEdgeSegmentLineageKernel`, which the editor's CAD worker shares.
 *
 * A resized bare extrusion's edges are listed at its drawn size, so its
 * segments are matched at that size too (#539). Only this server side says
 * so: the kernel module takes the profile as given, which keeps it free of
 * the server kernel the editor's worker cannot load.
 */

import type { OcctKernel } from "occt-wasm";
import type { EdgeTreatmentSourceEdge, WorkplaneShape } from "./domain/sketchforge.js";
import { edgeSolidForShape, resizedSketchExtrusionProfile } from "./serverCadOperations.js";
import { withCadKernel } from "./serverCadKernel.js";
import {
  listedIndexesForSketchSourceEdges,
  sketchLineageEdgesOnKernel,
  sketchSourceEdgesForListedIndexes,
  type SketchEdgeIndexesResult,
  type SketchSourceEdgesResult,
} from "./sketchEdgeSegmentLineageKernel.js";

export {
  uniqueSketchSourceEdge,
  type SketchEdgeIndexesResult,
  type SketchSourceEdgeMatch,
  type SketchSourceEdgesResult,
} from "./sketchEdgeSegmentLineageKernel.js";

/** The listed edges of `shape`, matched against its profile at the size `edgeSolidForShape` builds it. */
function lineageEdges(cad: OcctKernel, shape: WorkplaneShape) {
  const profile = resizedSketchExtrusionProfile(shape) ?? undefined;
  return sketchLineageEdgesOnKernel(cad, shape, () => edgeSolidForShape(cad, shape), profile);
}

/** Name each listed edge index by its sketch segment and cap, or say why one cannot be. */
export function sketchSourceEdgesForEdgeIndexesOnKernel(
  cad: OcctKernel,
  shape: WorkplaneShape,
  indexes: number[],
): SketchSourceEdgesResult {
  if (indexes.length === 0) return { status: "unsupported" };
  return sketchSourceEdgesForListedIndexes(lineageEdges(cad, shape), indexes);
}

/** Find the one listed edge index for each recorded segment and cap on a rebuilt source. */
export function edgeIndexesForSketchSourceEdgesOnKernel(
  cad: OcctKernel,
  shape: WorkplaneShape,
  sourceEdges: EdgeTreatmentSourceEdge[],
): SketchEdgeIndexesResult {
  if (sourceEdges.length === 0) return { status: "unsupported" };
  return listedIndexesForSketchSourceEdges(lineageEdges(cad, shape), sourceEdges);
}

export function sketchSourceEdgesForEdgeIndexes(shape: WorkplaneShape, indexes: number[]): Promise<SketchSourceEdgesResult> {
  return withCadKernel((cad) => sketchSourceEdgesForEdgeIndexesOnKernel(cad, shape, indexes));
}

export function edgeIndexesForSketchSourceEdges(
  shape: WorkplaneShape,
  sourceEdges: EdgeTreatmentSourceEdge[],
): Promise<SketchEdgeIndexesResult> {
  return withCadKernel((cad) => edgeIndexesForSketchSourceEdgesOnKernel(cad, shape, sourceEdges));
}
