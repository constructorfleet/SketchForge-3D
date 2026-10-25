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
 * the edge the treatment rounds.
 */

import type { OcctKernel } from "occt-wasm";
import type { EdgeTreatmentSourceEdge, WorkplaneShape } from "./domain/sketchforge.js";
import { edgeSolidForShape } from "./serverCadOperations.js";
import { withCadKernel } from "./serverCadKernel.js";
import {
  edgeMatchesSegmentAtY,
  segmentEndpoints,
  type BoundaryEdge,
  type SegmentEndpoints,
} from "./sketchFaceDraftKernel.js";

const LEVEL_TOLERANCE = 1e-6;

export type SketchSourceEdgeMatch =
  | { status: "matched"; segmentId: string; cap: EdgeTreatmentSourceEdge["cap"] }
  | { status: "missing" | "ambiguous" };

export type SketchSourceEdgesResult =
  | { status: "matched"; sourceEdges: EdgeTreatmentSourceEdge[] }
  | { status: "unsupported" }
  | { status: "missing" | "ambiguous"; index: number };

export type SketchEdgeIndexesResult =
  | { status: "matched"; edges: number[] }
  | { status: "unsupported" }
  | { status: "missing" | "ambiguous"; sourceEdge: EdgeTreatmentSourceEdge };

/** The one (segment, cap) a straight cap edge was swept from, judged by its endpoints alone. */
export function uniqueSketchSourceEdge(
  edge: BoundaryEdge,
  segments: SegmentEndpoints[],
  levels: { bottom: number; top: number },
): SketchSourceEdgeMatch {
  if (edge.curveType !== "line" || edge.vertices.length !== 2) return { status: "missing" };
  const matches = segments.flatMap((segment) => ([["bottom", levels.bottom], ["top", levels.top]] as const)
    .filter(([, y]) => edgeMatchesSegmentAtY(edge.vertices, y, segment))
    .map(([cap]) => ({ segmentId: segment.id, cap })));
  if (matches.length === 1) return { status: "matched", ...matches[0]! };
  return { status: matches.length === 0 ? "missing" : "ambiguous" };
}

/**
 * Whether a shape's edges can be named by lineage at all: a sketch extrusion
 * whose exact solid is still the bare extrusion of an eligible profile. A
 * draft, an earlier treatment, a shell or a mirror changes the edges, so those
 * are outside the boundary rather than matched approximately.
 */
function lineageSegments(shape: WorkplaneShape): SegmentEndpoints[] | null {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.cadBrep) return null;
  if (shape.faceDraft !== undefined || shape.draftPrismAngle !== undefined || shape.shell
    || (shape.edgeTreatments?.length ?? 0) > 0 || (shape.edgeTreatmentHistory?.length ?? 0) > 0
    || shape.mirrorX || shape.mirrorY || shape.mirrorZ) return null;
  return segmentEndpoints(shape.sketchProfile);
}

function listedEdges(cad: OcctKernel, shape: WorkplaneShape) {
  const solid = edgeSolidForShape(cad, shape);
  const edges: BoundaryEdge[] = cad.getSubShapes(solid, "edge").map((edge) => {
    let curveType = "unknown";
    try {
      curveType = cad.curveType(edge);
    } catch {
      // An edge with no curve type is not a straight cap edge.
    }
    return { curveType, vertices: cad.getSubShapes(edge, "vertex").map((vertex) => cad.vertexPosition(vertex)) };
  });
  // The caps are the solid's lowest and highest vertex levels: exact vertex
  // positions, not a bounding box, which OCCT pads by its tolerance.
  const ys = edges.flatMap((edge) => edge.vertices.map((vertex) => vertex.y));
  const levels = { bottom: Math.min(...ys), top: Math.max(...ys) };
  if (!Number.isFinite(levels.bottom) || !(levels.top - levels.bottom > LEVEL_TOLERANCE)) return null;
  return { edges, levels };
}

function sameSourceEdge(left: EdgeTreatmentSourceEdge, right: SketchSourceEdgeMatch) {
  return right.status === "matched" && right.segmentId === left.segmentId && right.cap === left.cap;
}

/** Name each listed edge index by its sketch segment and cap, or say why one cannot be. */
export function sketchSourceEdgesForEdgeIndexesOnKernel(
  cad: OcctKernel,
  shape: WorkplaneShape,
  indexes: number[],
): SketchSourceEdgesResult {
  const segments = lineageSegments(shape);
  if (!segments || indexes.length === 0) return { status: "unsupported" };
  const listed = listedEdges(cad, shape);
  if (!listed) return { status: "unsupported" };
  const matches = listed.edges.map((edge) => uniqueSketchSourceEdge(edge, segments, listed.levels));
  const sourceEdges: EdgeTreatmentSourceEdge[] = [];
  for (const index of indexes) {
    const match = matches[index];
    if (!match || match.status !== "matched") return { status: match?.status ?? "missing", index };
    const sourceEdge = { segmentId: match.segmentId, cap: match.cap };
    // The reverse must be unique too, or replay could not tell which edge it meant.
    if (matches.filter((candidate) => sameSourceEdge(sourceEdge, candidate)).length !== 1) {
      return { status: "ambiguous", index };
    }
    sourceEdges.push(sourceEdge);
  }
  return { status: "matched", sourceEdges };
}

/** Find the one listed edge index for each recorded segment and cap on a rebuilt source. */
export function edgeIndexesForSketchSourceEdgesOnKernel(
  cad: OcctKernel,
  shape: WorkplaneShape,
  sourceEdges: EdgeTreatmentSourceEdge[],
): SketchEdgeIndexesResult {
  const segments = lineageSegments(shape);
  if (!segments || sourceEdges.length === 0) return { status: "unsupported" };
  const listed = listedEdges(cad, shape);
  if (!listed) return { status: "unsupported" };
  const matches = listed.edges.map((edge) => uniqueSketchSourceEdge(edge, segments, listed.levels));
  const edges: number[] = [];
  for (const sourceEdge of sourceEdges) {
    if (!segments.some((segment) => segment.id === sourceEdge.segmentId)) return { status: "missing", sourceEdge };
    const found = matches.flatMap((match, index) => sameSourceEdge(sourceEdge, match) ? [index] : []);
    if (found.length !== 1) return { status: found.length === 0 ? "missing" : "ambiguous", sourceEdge };
    edges.push(found[0]!);
  }
  return { status: "matched", edges };
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

