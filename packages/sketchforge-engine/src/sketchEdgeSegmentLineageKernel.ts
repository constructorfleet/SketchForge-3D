/**
 * Selected-edge identity by sketch lineage (#350), on a solid the caller gives.
 *
 * The matcher behind `sketchEdgeSegmentLineage`, without the server kernel, so
 * the editor's CAD worker can run the same test the REST path does (#540).
 * Browser-safe: it imports nothing that loads a kernel of its own.
 *
 * A cap edge of a straight, single-region sketch extrusion is named by the
 * sketch segment swept to make it and the cap (bottom or top) it lies on,
 * judged by the endpoint test the face-draft lineage uses
 * (`sketchFaceDraftKernel`); `missing` or `ambiguous` is answered rather than
 * a guess.
 */

import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";
import type { EdgeTreatmentSourceEdge, SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";
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

/** Every edge of a lineage-eligible solid, in kernel order, with what it was swept from. */
export type SketchLineageEdges = {
  segments: SegmentEndpoints[];
  edges: BoundaryEdge[];
  matches: SketchSourceEdgeMatch[];
};

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
 *
 * `profile` is the profile at the size the listed solid is built, when that is
 * not the stored one: the server passes a resized extrusion's scaled profile
 * (#539). The editor's worker lists the stored B-rep and never passes one.
 */
export function sketchLineageSegments(shape: WorkplaneShape, profile?: SketchProfile): SegmentEndpoints[] | null {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.cadBrep) return null;
  if (shape.faceDraft !== undefined || shape.draftPrismAngle !== undefined || shape.shell
    || (shape.edgeTreatments?.length ?? 0) > 0 || (shape.edgeTreatmentHistory?.length ?? 0) > 0
    || shape.mirrorX || shape.mirrorY || shape.mirrorZ) return null;
  return segmentEndpoints(profile ?? shape.sketchProfile);
}

/** The straight-or-not type and the vertex positions of one kernel edge. */
export function boundaryEdgeOnKernel(cad: OcctKernel, edge: ShapeHandle): BoundaryEdge {
  let curveType = "unknown";
  try {
    curveType = cad.curveType(edge);
  } catch {
    // An edge with no curve type is not a straight cap edge.
  }
  return { curveType, vertices: cad.getSubShapes(edge, "vertex").map((vertex) => cad.vertexPosition(vertex)) };
}

/**
 * List a lineage-eligible shape's edges and what each was swept from, or null
 * when the shape is outside the boundary. `solid` is only built for an
 * eligible shape; it must be the solid edge indexes are numbered on, in the
 * frame and at the size of the profile it is matched against.
 */
export function sketchLineageEdgesOnKernel(
  cad: OcctKernel,
  shape: WorkplaneShape,
  solid: () => ShapeHandle,
  profile?: SketchProfile,
): SketchLineageEdges | null {
  const segments = sketchLineageSegments(shape, profile);
  if (!segments) return null;
  const edges = cad.getSubShapes(solid(), "edge").map((edge) => boundaryEdgeOnKernel(cad, edge));
  // The caps are the solid's lowest and highest vertex levels: exact vertex
  // positions, not a bounding box, which OCCT pads by its tolerance.
  const ys = edges.flatMap((edge) => edge.vertices.map((vertex) => vertex.y));
  const levels = { bottom: Math.min(...ys), top: Math.max(...ys) };
  if (!Number.isFinite(levels.bottom) || !(levels.top - levels.bottom > LEVEL_TOLERANCE)) return null;
  return { segments, edges, matches: edges.map((edge) => uniqueSketchSourceEdge(edge, segments, levels)) };
}

function sameSourceEdge(left: EdgeTreatmentSourceEdge, right: SketchSourceEdgeMatch) {
  return right.status === "matched" && right.segmentId === left.segmentId && right.cap === left.cap;
}

/** Name each listed edge index by its sketch segment and cap, or say why one cannot be. */
export function sketchSourceEdgesForListedIndexes(listed: SketchLineageEdges | null, indexes: number[]): SketchSourceEdgesResult {
  if (!listed || indexes.length === 0) return { status: "unsupported" };
  const sourceEdges: EdgeTreatmentSourceEdge[] = [];
  for (const index of indexes) {
    const match = listed.matches[index];
    if (!match || match.status !== "matched") return { status: match?.status ?? "missing", index };
    const sourceEdge = { segmentId: match.segmentId, cap: match.cap };
    // The reverse must be unique too, or replay could not tell which edge it meant.
    if (listed.matches.filter((candidate) => sameSourceEdge(sourceEdge, candidate)).length !== 1) {
      return { status: "ambiguous", index };
    }
    sourceEdges.push(sourceEdge);
  }
  return { status: "matched", sourceEdges };
}

/** Find the one listed edge index for each recorded segment and cap. */
export function listedIndexesForSketchSourceEdges(
  listed: SketchLineageEdges | null,
  sourceEdges: EdgeTreatmentSourceEdge[],
): SketchEdgeIndexesResult {
  if (!listed || sourceEdges.length === 0) return { status: "unsupported" };
  const edges: number[] = [];
  for (const sourceEdge of sourceEdges) {
    if (!listed.segments.some((segment) => segment.id === sourceEdge.segmentId)) return { status: "missing", sourceEdge };
    const found = listed.matches.flatMap((match, index) => sameSourceEdge(sourceEdge, match) ? [index] : []);
    if (found.length !== 1) return { status: found.length === 0 ? "missing" : "ambiguous", sourceEdge };
    edges.push(found[0]!);
  }
  return { status: "matched", edges };
}

/**
 * Whether two edges join the same points, in either order. How a caller that
 * numbers edges on its own copy of the solid -- the editor's worker, after
 * placing and healing it -- finds the listed edge it means.
 */
export function sameEdgeEndpoints(left: Vec3[], right: Vec3[], tolerance = 1e-5) {
  if (left.length !== right.length || left.length === 0) return false;
  const close = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.z - b.z) <= tolerance;
  if (left.length !== 2) return left.every((vertex, index) => close(vertex, right[index]!));
  return (close(left[0]!, right[0]!) && close(left[1]!, right[1]!)) || (close(left[0]!, right[1]!) && close(left[1]!, right[0]!));
}
