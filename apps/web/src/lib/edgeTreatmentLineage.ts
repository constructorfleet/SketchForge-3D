/**
 * What the editor's fillet and chamfer tool records, and replays, by
 * sketch-segment lineage (#540).
 *
 * The REST path names a selected cap edge of a straight, single-region sketch
 * extrusion by the segment and cap it was swept from (#350). The editor now
 * asks its CAD worker for the same names when a treatment is applied, and on
 * a sketch edit finds the same edges of the rebuilt extrusion and rounds them
 * again. These are the main-thread decisions around those two worker calls;
 * the matching itself is the engine's (`sketchEdgeSegmentLineageKernel`).
 */

import type { CadModifierEdgeLineageSource } from "@/lib/cadModifierTypes";
import { cadBrepTransformForShape } from "@/lib/engine/cadBakeMetadata";
import { sketchLineageSegments } from "@/lib/engine/sketchEdgeSegmentLineageKernel";
import { shapeHasTaper } from "@/lib/engine/workplaneShapes";
import type { EdgeTreatmentFeature, EdgeTreatmentHistoryEntry, EdgeTreatmentSourceEdge, WorkplaneShape } from "@/types/sketchforge";

/** The prepared part a lineage request is about, and how its stored B-rep was placed for the worker. */
export type EdgeTreatmentLineageTarget = {
  source: CadModifierEdgeLineageSource;
  brepTransform?: number[];
};

/** Rotation and translation only: no scale and no reflection, within rounding. */
export function isRigidCadTransform(transform: number[]) {
  if (transform.length !== 12 || !transform.every(Number.isFinite)) return false;
  const [a, b, c, , e, f, g, , i, j, k] = transform as [number, number, number, number, number, number, number, number, number, number, number, number];
  const columns = [[a, e, i], [b, f, j], [c, g, k]] as const;
  const dot = (left: readonly number[], right: readonly number[]) => left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
  const tolerance = 1e-9;
  const orthonormal = columns.every((column, index) => columns.every((other, otherIndex) => (
    Math.abs(dot(column, other) - (index === otherIndex ? 1 : 0)) <= tolerance
  )));
  const determinant = a * (f * k - g * j) - b * (e * k - g * i) + c * (e * j - f * i);
  return orthonormal && determinant > 0;
}

function lineageSource(shape: WorkplaneShape): CadModifierEdgeLineageSource {
  return {
    sketchOperation: shape.sketchOperation,
    sketchProfile: shape.sketchProfile,
    cadBrep: shape.cadBrep,
    faceDraft: shape.faceDraft,
    draftPrismAngle: shape.draftPrismAngle,
    shell: shape.shell,
    edgeTreatments: shape.edgeTreatments,
    edgeTreatmentHistory: shape.edgeTreatmentHistory,
    mirrorX: shape.mirrorX,
    mirrorY: shape.mirrorY,
    mirrorZ: shape.mirrorZ,
  };
}

/**
 * The lineage request for a treatment about to be applied to `base`, or null
 * when the editor records it without lineage, as it always has: anything but
 * one ungrouped, untapered, bare straight sketch extrusion, or one resized or
 * mirrored since it was built, whose stored B-rep is no longer placed rigidly.
 */
export function edgeTreatmentLineageTarget(base: WorkplaneShape, sourceParts: readonly WorkplaneShape[]): EdgeTreatmentLineageTarget | null {
  if (base.groupedShapes?.length || sourceParts.length !== 1 || sourceParts[0]!.id !== base.id) return null;
  if (shapeHasTaper(base) || !base.cadBrepFrame || !sketchLineageSegments(base)) return null;
  const brepTransform = cadBrepTransformForShape(base);
  if (brepTransform && !isRigidCadTransform(brepTransform)) return null;
  return { source: lineageSource(base), ...(brepTransform ? { brepTransform } : {}) };
}

/**
 * The feature as recorded: with its sketch lineage when every selected edge
 * had one. An all-edge treatment is replayed as all edges and never carries it.
 */
export function edgeTreatmentFeatureWithLineage(
  feature: EdgeTreatmentFeature,
  sourceEdges: EdgeTreatmentSourceEdge[] | null | undefined,
): EdgeTreatmentFeature {
  if (!sourceEdges?.length || feature.allEdges || sourceEdges.length !== feature.edgeCount) return feature;
  return { ...feature, sourceEdges: sourceEdges.map((edge) => ({ ...edge })) };
}

function sameSelectedEdgeFeature(left: EdgeTreatmentFeature, right: EdgeTreatmentFeature) {
  return left.kind === right.kind
    && left.amount === right.amount
    && left.allEdges === undefined && right.allEdges === undefined
    && (left.kind !== "chamfer" || Math.abs((left.chamferAngle ?? 45) - (right.chamferAngle ?? 45)) < 0.001)
    && JSON.stringify(left.sourceEdges) === JSON.stringify(right.sourceEdges);
}

export type SelectedEdgeTreatmentReplay =
  | { status: "none" }
  | { status: "replay"; feature: EdgeTreatmentFeature & { sourceEdges: EdgeTreatmentSourceEdge[] }; entry: EdgeTreatmentHistoryEntry }
  | { status: "blocked" };

/**
 * Whether a sketch edit of `shape` replays a selected-edge treatment by
 * lineage. `none`: it keeps no lineage, and the edit rebuilds the bare
 * extrusion as it always has. `blocked`: it keeps lineage the edit cannot
 * replay -- a second treatment, a draft -- so the edit is refused, as the REST
 * path refuses it, rather than dropping the treatment.
 */
export function selectedEdgeTreatmentReplay(shape: WorkplaneShape): SelectedEdgeTreatmentReplay {
  const features = shape.edgeTreatments ?? [];
  const history = shape.edgeTreatmentHistory ?? [];
  if (!features.some((feature) => feature.sourceEdges !== undefined) && !history.some((entry) => entry.feature.sourceEdges !== undefined)) {
    return { status: "none" };
  }
  const [feature] = features;
  const [entry] = history;
  const distinct = new Set(feature?.sourceEdges?.map((edge) => `${edge.cap}:${edge.segmentId}`) ?? []);
  if (features.length !== 1 || history.length !== 1 || !feature?.sourceEdges?.length || !entry
    || distinct.size !== feature.sourceEdges.length
    || !sameSelectedEdgeFeature(feature, entry.feature)
    || shape.sketchOperation !== "extrude" || shape.faceDraft !== undefined || shape.draftPrismAngle !== undefined || shape.shell) {
    return { status: "blocked" };
  }
  return { status: "replay", feature: feature as EdgeTreatmentFeature & { sourceEdges: EdgeTreatmentSourceEdge[] }, entry };
}
