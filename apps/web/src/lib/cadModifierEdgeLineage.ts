// Imported by the CAD modifier worker: engine kernel modules only, never React or "@/i18n".
/**
 * Sketch-segment lineage for the editor's fillet and chamfer tool (#540).
 *
 * The worker numbers edges on its own copy of the solid: the stored B-rep
 * placed by its transform, then healed. The lineage matcher numbers them on
 * the stored B-rep itself, which is the frame the sketch profile is in. This
 * file only translates between the two -- an edge is the same edge when it
 * joins the same two points once placed -- and leaves every lineage decision
 * to the engine's matcher (`sketchEdgeSegmentLineageKernel`), so a treatment
 * made in the editor records exactly what `POST /treatments` would.
 */

import type { OcctKernel, Vec3 } from "occt-wasm";
import type { EdgeTreatmentSourceEdge, WorkplaneShape } from "@/types/sketchforge";
import type { CadModifierEdgeLineageSource, CadModifierLineageEdgeIds } from "@/lib/cadModifierTypes";
import {
  listedIndexesForSketchSourceEdges,
  sameEdgeEndpoints,
  sketchLineageEdgesOnKernel,
  sketchSourceEdgesForListedIndexes,
  type SketchLineageEdges,
} from "@/lib/engine/sketchEdgeSegmentLineageKernel";
import { solidFromBrepOnKernel, type BoundaryEdge } from "@/lib/engine/sketchFaceDraftKernel";

export type EdgeLineageSource = CadModifierEdgeLineageSource;

export type SessionSourceEdgesResult =
  | { status: "matched"; sourceEdges: EdgeTreatmentSourceEdge[] }
  | { status: "unsupported" | "missing" | "ambiguous" };

export type SessionEdgeIdsResult = CadModifierLineageEdgeIds;

/** A 3x4 row-major placement, as `cadBrepTransformForShape` gives it, applied to one point. */
function placed(point: Vec3, transform: number[] | undefined): Vec3 {
  if (transform?.length !== 12) return point;
  const [a, b, c, d, e, f, g, h, i, j, k, l] = transform as [number, number, number, number, number, number, number, number, number, number, number, number];
  return {
    x: a * point.x + b * point.y + c * point.z + d,
    y: e * point.x + f * point.y + g * point.z + h,
    z: i * point.x + j * point.y + k * point.z + l,
  };
}

/**
 * The indexes in `candidates` of edges joining the same points. Not their
 * curve types: the worker places a stored B-rep with a general transform,
 * which hands its lines back as B-splines. Whether an edge is straight is
 * the matcher's call, made on the stored B-rep.
 */
function sameEdges(edge: BoundaryEdge, candidates: BoundaryEdge[]) {
  return candidates.flatMap((candidate, index) => sameEdgeEndpoints(candidate.vertices, edge.vertices) ? [index] : []);
}

function listedLineageEdges(cad: OcctKernel, source: EdgeLineageSource): SketchLineageEdges | null {
  if (!source.cadBrep) return null;
  return sketchLineageEdgesOnKernel(cad, source as WorkplaneShape, () => solidFromBrepOnKernel(cad, source.cadBrep!));
}

/**
 * Name the selected session edges by sketch segment and cap. `selected` are
 * the worker's edges as placed; `transform` places the stored B-rep the same way.
 */
export function sessionSourceEdgesOnKernel(
  cad: OcctKernel,
  source: EdgeLineageSource,
  transform: number[] | undefined,
  selected: BoundaryEdge[],
): SessionSourceEdgesResult {
  const listed = listedLineageEdges(cad, source);
  if (!listed || selected.length === 0) return { status: "unsupported" };
  const placedListed = listed.edges.map((edge) => ({ ...edge, vertices: edge.vertices.map((vertex) => placed(vertex, transform)) }));
  const indexes: number[] = [];
  for (const edge of selected) {
    const found = sameEdges(edge, placedListed);
    if (found.length !== 1) return { status: found.length === 0 ? "missing" : "ambiguous" };
    indexes.push(found[0]!);
  }
  const named = sketchSourceEdgesForListedIndexes(listed, indexes);
  return named.status === "matched" ? named : { status: named.status };
}

/**
 * Find the session edge each recorded segment and cap names on a rebuilt
 * extrusion. `session` is every edge the worker listed, in id order.
 */
export function sessionEdgeIdsForSourceEdgesOnKernel(
  cad: OcctKernel,
  source: EdgeLineageSource,
  transform: number[] | undefined,
  session: BoundaryEdge[],
  sourceEdges: EdgeTreatmentSourceEdge[],
): SessionEdgeIdsResult {
  const listed = listedLineageEdges(cad, source);
  const found = listedIndexesForSketchSourceEdges(listed, sourceEdges);
  if (found.status !== "matched") return found;
  const edgeIds: number[] = [];
  for (const [position, index] of found.edges.entries()) {
    const edge = listed!.edges[index]!;
    const ids = sameEdges({ ...edge, vertices: edge.vertices.map((vertex) => placed(vertex, transform)) }, session);
    if (ids.length !== 1) return { status: ids.length === 0 ? "missing" : "ambiguous", sourceEdge: sourceEdges[position]! };
    edgeIds.push(ids[0]!);
  }
  return { status: "matched", edgeIds };
}
