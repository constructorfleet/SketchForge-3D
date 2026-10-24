import {
  draftPrismProfileOffset,
  retainedDraftSourcePlacement,
  retainedFaceDraftFields,
  retainedPrismDraftFields,
  type ResolvedSketchFaceDraftSource,
  type RetainedFaceDraftPrior,
  type RetainedFaceDraftResolution,
  type SketchFaceDraftPullDirection,
  type SketchFaceDraftSource,
} from "@/lib/engine/sketchFaceDraftKernel";
import { canonicalizeShape } from "@/lib/engine/workplaneShapes";
import { createLocalId } from "@/lib/engine/localIds";
import { cadSketchRegions } from "@/lib/sketchCadProfile";
import { draftPrismControlForShape } from "@/lib/draftPrismEditor";
import { shapeFaceCount } from "@/lib/shapeFaces";
import type { SketchProfile, WorkplaneShape } from "@/types/sketchforge";

/**
 * Retained face and prism drafts in the editor (#384).
 *
 * A draft on a sketch extrusion is kept as a feature -- the same record, in the
 * same place, that the REST API writes -- so editing the sketch replays it
 * instead of losing it. The face resolution, the draft, the record and the
 * placement rule come from the engine's `sketchFaceDraftKernel`, which the
 * REST path calls too; what is here is the editor's side of it: which shapes
 * qualify, and how a worker result becomes a stored shape.
 */

/** Why a face draft on this shape would not be kept as a feature, or null when it is. */
export type RetainedFaceDraftUnavailable =
  | "not-sketch-extrusion"
  | "no-exact-source"
  | "draft-retained"
  | "treated"
  | "mirrored"
  | "resized";

const SCALE_TOLERANCE = 1e-6;

function near(left: number, right: number) {
  return Math.abs(left - right) <= SCALE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

function isSingleLoopSketchExtrusion(shape: WorkplaneShape) {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile) return false;
  try {
    const regions = cadSketchRegions(shape.sketchProfile);
    return regions.length === 1 && regions[0]?.holes.length === 0;
  } catch {
    return false;
  }
}

function hasTreatments(shape: WorkplaneShape) {
  return Boolean(shape.edgeTreatments?.length || shape.edgeTreatmentHistory?.length || shape.shell);
}

function isMirrored(shape: WorkplaneShape) {
  return Boolean(shape.mirrorX || shape.mirrorY || shape.mirrorZ);
}

function hasExactSource(shape: WorkplaneShape) {
  return Boolean(shape.cadBrep && shape.cadBrepFrame && !shape.cadBrepFrame.sourceTransform);
}

/** Whether the shape is drawn at the size of its own exact geometry, in all three directions. */
function unresized(shape: WorkplaneShape) {
  const frame = shape.cadBrepFrame;
  return Boolean(frame) && near(shape.width, frame!.width) && near(shape.depth, frame!.depth) && near(shape.height, frame!.height);
}

/** Whether the shape keeps a face or prism draft record. */
export function hasRetainedDraft(shape: WorkplaneShape) {
  return Boolean(shape.faceDraft) || shape.draftPrismAngle !== undefined;
}

/**
 * Whether a new face draft on this shape is kept as a feature.
 *
 * The shapes the REST API can draft and replay: a single-loop sketch
 * extrusion, exact, untreated and with no draft yet. A mirrored or resized
 * shape is refused too, because a replay rebuilds the extrusion from its sketch
 * at its sketch's size and would quietly undo either. A shape that already
 * keeps a draft is reported separately: a second draft on it is refused
 * rather than baked, as the REST API refuses it.
 */
export function retainedFaceDraftUnavailable(shape: WorkplaneShape): RetainedFaceDraftUnavailable | null {
  if (hasRetainedDraft(shape)) return "draft-retained";
  if (!isSingleLoopSketchExtrusion(shape)) return "not-sketch-extrusion";
  if (!hasExactSource(shape)) return "no-exact-source";
  if (hasTreatments(shape)) return "treated";
  if (isMirrored(shape)) return "mirrored";
  if (!unresized(shape)) return "resized";
  return null;
}

/**
 * Why the draft this shape keeps cannot be edited or replayed, or null when it
 * can. Something done to the shape since the draft -- a mirror, a fillet or
 * chamfer, a resize -- has no place in the record, so rebuilding from the
 * sketch would silently undo it; the edit is refused instead.
 */
export function retainedDraftReplayBlocked(shape: WorkplaneShape): RetainedFaceDraftUnavailable | null {
  if (!isSingleLoopSketchExtrusion(shape)) return "not-sketch-extrusion";
  if (!hasExactSource(shape)) return "no-exact-source";
  if (shape.faceDraft && shape.draftPrismAngle !== undefined) return "draft-retained";
  if (shape.draftPrismAngle !== undefined && !draftPrismControlForShape(shape).available) return "not-sketch-extrusion";
  if (hasTreatments(shape)) return "treated";
  if (isMirrored(shape)) return "mirrored";
  if (!unresized(shape)) return "resized";
  return null;
}

/** Whether the retained face draft on this shape can be edited or replayed. */
export function retainedFaceDraftEditable(shape: WorkplaneShape) {
  return Boolean(shape.faceDraft) && retainedDraftReplayBlocked(shape) === null;
}

/**
 * Whether a prism draft on this shape is kept as a feature: applied to an
 * undrafted sketch extrusion, or re-applied to one that keeps a prism draft.
 *
 * A first prism draft takes the shape's height as it stands, as the REST path
 * does, so only a footprint resize disqualifies it. A kept one must be
 * replayable. A face draft or treatment it would replace keeps the old baked
 * behaviour; a face-drafted shape refuses a prism draft altogether.
 */
export function retainedPrismDraftAvailable(shape: WorkplaneShape) {
  if (!draftPrismControlForShape(shape).available || !hasExactSource(shape) || shape.faceDraft) return false;
  if (shape.draftPrismAngle !== undefined) return retainedDraftReplayBlocked(shape) === null;
  if (hasTreatments(shape) || isMirrored(shape)) return false;
  const frame = shape.cadBrepFrame!;
  return near(shape.width, frame.width) && near(shape.depth, frame.depth);
}

/**
 * The shape with a stable ID on every face, for a draft to name one by.
 *
 * A sketch extrusion built in the editor has none of its own; it is given the
 * IDs the REST face listing reports for such a shape, so a face chosen by its
 * number here is the face a script would name.
 */
export function withDraftFaceIds(shape: WorkplaneShape): WorkplaneShape {
  const count = shapeFaceCount({ ...shape, faceIds: undefined });
  if (shape.faceIds?.length && (count === 0 || shape.faceIds.length === count)) return shape;
  return { ...shape, faceIds: Array.from({ length: count }, (_, index) => `face_${encodeURIComponent(shape.id)}_${index}`) };
}

/** The undrafted source height a draft on this shape starts from. */
export function retainedDraftSourceHeight(shape: WorkplaneShape) {
  return shape.draftPrismSourceHeight ?? shape.faceDraftSourceFrame?.height ?? shape.height;
}

/** Everything a retained draft adds, cleared: for a baked result, whose geometry no record describes. */
export const CLEARED_RETAINED_DRAFT_FIELDS = {
  faceDraft: undefined,
  faceDraftSourceFaceIds: undefined,
  faceDraftSourceSegmentId: undefined,
  faceDraftSourceFrame: undefined,
  faceDraftSourceScale: undefined,
  draftPrismAngle: undefined,
  draftPrismSourceHeight: undefined,
  draftPrismSourceFrame: undefined,
} satisfies Partial<WorkplaneShape>;

const CLEARED_TREATMENT_FIELDS = {
  faceColors: undefined,
  edgeTreatments: undefined,
  edgeTreatmentHistory: undefined,
  cadDisplayEdges: undefined,
  cadDisplayEdgesVersion: undefined,
} satisfies Partial<WorkplaneShape>;

function freshFaceIds(shapeId: string, count: number) {
  return Array.from({ length: count }, (_, index) => `face_${createLocalId(`${shapeId}-face-${index}`)}`);
}

function rotationOf(shape: WorkplaneShape) {
  return { rotation: shape.rotation, rotationX: shape.rotationX ?? 0, rotationZ: shape.rotationZ ?? 0 };
}

/**
 * The undrafted extrusion a retained draft is redrafted or replayed on.
 *
 * `rebuilt` is the extrusion freshly built from the (possibly edited) sketch,
 * in sketch coordinates, carrying no face IDs but its own fresh ones. It is
 * placed by the REST rule: the shape moves by however far the rebuilt frame is
 * from the frame the draft first started from. Its faces keep the IDs the draft
 * was chosen by when the sketch is unchanged -- the REST path does the same --
 * and get new ones when an edit rebuilt them.
 */
export function retainedFaceDraftRebuildBase(
  existing: WorkplaneShape,
  rebuilt: WorkplaneShape,
  sketch: "unchanged" | "profile-changed",
): WorkplaneShape {
  const faceCount = shapeFaceCount(rebuilt);
  const keptIds = sketch === "unchanged" && existing.faceDraftSourceFaceIds?.length === faceCount
    ? existing.faceDraftSourceFaceIds
    : undefined;
  const faceIds = keptIds ?? rebuilt.faceIds ?? freshFaceIds(existing.id, faceCount);
  return canonicalizeShape({
    ...rebuilt,
    id: existing.id,
    name: existing.name,
    color: existing.color,
    sketchSourceId: existing.sketchSourceId ?? rebuilt.sketchSourceId,
    locked: existing.locked,
    hidden: existing.hidden,
    ...retainedDraftSourcePlacement(existing, rebuilt.cadBrepFrame!),
    ...rotationOf(existing),
    faceIds: faceIds.length ? [...faceIds] : undefined,
    ...CLEARED_TREATMENT_FIELDS,
    ...CLEARED_RETAINED_DRAFT_FIELDS,
  });
}

/** What the CAD worker reports for a retained face draft, besides the mesh. */
export type RetainedFaceDraftOutcome = {
  sourceFaceIds: string[];
  resultFaceIds: string[];
  resolved: Pick<ResolvedSketchFaceDraftSource, "faceId" | "normal" | "segmentMatch">;
};

/**
 * The drafted shape the editor stores.
 *
 * `base` is the undrafted extrusion the worker drafted and `drafted` the shape
 * made from the worker's mesh. As on the REST path, the drafted part keeps the
 * base's position: its bounds' centre sits where the undrafted one's did. The
 * record is the engine's, and the colours go -- a draft rebuilds the faces.
 * `frameSource` is the shape the draft was asked of, which differs from `base`
 * only on an edit or replay.
 */
export function retainedFaceDraftShape(
  base: WorkplaneShape,
  drafted: WorkplaneShape,
  outcome: RetainedFaceDraftOutcome,
  request: { angle: number; pullDirection: SketchFaceDraftPullDirection },
  frameSource: WorkplaneShape = base,
): WorkplaneShape {
  return canonicalizeShape({
    ...drafted,
    x: base.x,
    z: base.z,
    elevation: base.elevation ?? 0,
    ...rotationOf(base),
    faceIds: [...outcome.resultFaceIds],
    ...CLEARED_TREATMENT_FIELDS,
    ...CLEARED_RETAINED_DRAFT_FIELDS,
    ...retainedFaceDraftFields(outcome.sourceFaceIds, frameSource, outcome.resolved, request),
  });
}

/**
 * The prism-drafted shape the editor stores.
 *
 * `existing` is the shape the draft was asked of -- undrafted, or keeping a
 * prism draft -- and `drafted` the shape made from the worker's mesh of
 * `profile`, the sketch as it now is. Placed by the REST rule against the
 * frame a plain extrusion of `profile` would have, which is the centre of its
 * bounds at the sketch's base; for an unchanged sketch the position stays.
 */
export function retainedPrismDraftShape(
  existing: WorkplaneShape,
  drafted: WorkplaneShape,
  angle: number,
  profile: SketchProfile = existing.sketchProfile!,
): WorkplaneShape {
  const centre = draftPrismProfileOffset(profile);
  return canonicalizeShape({
    ...drafted,
    sketchProfile: structuredClone(profile),
    ...retainedDraftSourcePlacement(existing, { x: centre.x, z: centre.z, elevation: 0 }),
    ...rotationOf(existing),
    faceIds: freshFaceIds(existing.id, shapeFaceCount({ ...drafted, faceIds: undefined })),
    ...CLEARED_TREATMENT_FIELDS,
    ...CLEARED_RETAINED_DRAFT_FIELDS,
    ...retainedPrismDraftFields(existing, angle),
  });
}

function priorOf(shape: WorkplaneShape): RetainedFaceDraftPrior {
  return {
    id: shape.id,
    faceIds: shape.faceIds,
    cadBrep: shape.cadBrep,
    cadBrepFrame: shape.cadBrepFrame,
    height: shape.height,
    sketchOperation: shape.sketchOperation,
    sketchProfile: shape.sketchProfile,
    faceDraft: shape.faceDraft,
    faceDraftSourceFaceIds: shape.faceDraftSourceFaceIds,
    faceDraftSourceSegmentId: shape.faceDraftSourceSegmentId,
    faceDraftSourceFrame: shape.faceDraftSourceFrame,
  };
}

function sourceOf(shape: WorkplaneShape): SketchFaceDraftSource {
  return {
    id: shape.id,
    sketchOperation: shape.sketchOperation,
    sketchProfile: shape.sketchProfile,
    cadBrep: shape.cadBrep,
    faceIds: shape.faceIds,
    cadBrepFrame: shape.cadBrepFrame,
    height: shape.height,
  };
}

/**
 * What the worker resolves a retained face draft from, trimmed to the fields
 * the resolver reads so no mesh crosses to the worker.
 *
 * `existing` is the shape the draft was asked of and `base` the undrafted
 * extrusion it is made on: the same shape for a new draft. The face is named
 * as the REST request names it: the chosen face for a new draft, the drafted
 * face otherwise.
 */
export function retainedFaceDraftResolution(
  existing: WorkplaneShape,
  base: WorkplaneShape,
  request: { sourceFaceId?: string; angle: number; pullDirection: SketchFaceDraftPullDirection },
  profileChanged: boolean,
): RetainedFaceDraftResolution {
  const sourceFaceId = request.sourceFaceId ?? existing.faceDraft?.sourceFaceId;
  if (!sourceFaceId) throw new Error("A retained face draft needs a face to act on.");
  return {
    existing: priorOf(existing),
    source: sourceOf(base),
    request: { sourceFaceId, angle: request.angle, pullDirection: request.pullDirection },
    profileChanged,
  };
}
