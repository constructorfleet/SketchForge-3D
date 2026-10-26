import { buildGroupFromSelection } from "./serverShapeBooleans.js";
import { groupChildFrame } from "./serverShapeGroups.js";
import { resizedShapeSize, shapeDepth, shapeWidth } from "./workplaneShapes.js";
import {
  allEdgeTreatmentEdgeCount,
  applyDraftPrism,
  applyEdgeTreatment,
  applySketchFaceDraft,
  shapeWithCadResult,
} from "./serverCadOperations.js";
import { shapeFaces } from "./serverCadShell.js";
import { cadSketchRegions, cadSketchSweepPaths } from "./sketchCadProfile.js";
import { draftFaceForSketchSegment, legacyDraftSegmentForShape } from "./faceDraftSegmentLineage.js";
import { retainedDraftSourcePlacement } from "./sketchFaceDraftKernel.js";
import { edgeIndexesForSketchSourceEdges } from "./sketchEdgeSegmentLineage.js";
import type { EdgeTreatmentFeature, EdgeTreatmentHistoryEntry, WorkplaneShape } from "./domain/sketchforge.js";
import type { ProjectDocument } from "./projectStore.js";

export type RecomputeTreeResult =
  | { ok: true; shapes: WorkplaneShape[]; updated: WorkplaneShape; matchCount: number }
  | { ok: false; reason: "recompute_failed" | "dependency_missing" | "dependency_ambiguous" | "dependency_cycle"; message?: string };

type RecomputeNode = {
  shape: WorkplaneShape;
  dependencies: string[];
  order: number;
};

/** Where a treatment was applied, so reverting it later carries any move made since. */
export function edgeTreatmentAppliedFrame(shape: WorkplaneShape): NonNullable<EdgeTreatmentHistoryEntry["appliedFrame"]> {
  return {
    x: shape.x,
    z: shape.z,
    elevation: shape.elevation ?? 0,
    width: shape.width,
    depth: shape.depth,
    height: shape.height,
    rotation: shape.rotation ?? 0,
    rotationX: shape.rotationX ?? 0,
    rotationZ: shape.rotationZ ?? 0,
    mirrorX: Boolean(shape.mirrorX),
    mirrorY: Boolean(shape.mirrorY),
    mirrorZ: Boolean(shape.mirrorZ),
  };
}

/** Replay one supported all-edge treatment on rebuilt source geometry without carrying transient edge indexes forward. */
export async function replaySingleAllEdgeTreatment(
  original: WorkplaneShape,
  rebuilt: WorkplaneShape,
  draftPrismAngle = original.draftPrismAngle,
): Promise<WorkplaneShape> {
  const features = original.edgeTreatments ?? [];
  const history = original.edgeTreatmentHistory ?? [];
  if (features.length === 0 && history.length === 0) return rebuilt;
  const feature = features[0];
  const historyFeature = history[0]?.feature;
  if (feature?.sourceEdges !== undefined || historyFeature?.sourceEdges !== undefined) {
    return replaySelectedEdgeTreatment(original, rebuilt, draftPrismAngle);
  }
  const revolveSettings = original.sketchRevolve;
  const supportedFaceDraftRevolve = original.sketchOperation === "revolve"
    && revolveSettings !== undefined
    && Math.abs(Math.abs(revolveSettings.sweepAngle) - 360) < 1e-6
    && (revolveSettings.pitch ?? 0) === 0
    && (revolveSettings.coreRadius ?? 0) === 0
    && (feature?.kind === "chamfer" || feature?.kind === "fillet");
  const extrusionRegions = original.sketchOperation === "extrude" && original.sketchProfile
    ? cadSketchRegions(original.sketchProfile)
    : [];
  const supportedFaceDraftExtrusionTreatment = original.sketchOperation === "extrude"
    && extrusionRegions.length === 1
    && extrusionRegions[0]?.holes.length === 0
    && (feature?.kind === "fillet" || feature?.kind === "chamfer");
  let supportedFaceDraftSweep = false;
  if (original.sketchOperation === "sweep" && original.sketchProfile) {
    try {
      const { sections, spine } = cadSketchSweepPaths(original.sketchProfile);
      supportedFaceDraftSweep = sections.length === 1 && sections[0]?.holes.length === 0 && spine.steps.length > 0;
    } catch {
      supportedFaceDraftSweep = false;
    }
  }
  const supportedFaceDraftTreatmentKind = (feature?.kind === "fillet" || feature?.kind === "chamfer")
    && (supportedFaceDraftExtrusionTreatment || supportedFaceDraftRevolve || supportedFaceDraftSweep);
  const supportedFaceDraftTreatment = original.faceDraft !== undefined
    && features.length === 1
    && history.length === 1
    && historyFeature?.kind === feature?.kind
    && feature?.allEdges === true
    && historyFeature.allEdges === true
    && supportedFaceDraftTreatmentKind;
  if (original.faceDraft !== undefined && !supportedFaceDraftTreatment) {
    throw new Error("A face draft can replay one all-edge chamfer or all-edge fillet on a single-loop sketch extrusion, one all-edge chamfer or all-edge fillet on a single-section sketch sweep, or one all-edge chamfer or all-edge fillet on a plain full-turn revolve.");
  }
  if (features.length !== 1 || history.length !== 1
    || !feature || !historyFeature
    || feature.allEdges !== true || historyFeature.allEdges !== true
    || historyFeature.kind !== feature.kind
    || historyFeature.amount !== feature.amount
    || (feature.kind === "chamfer" && historyFeature.chamferAngle !== undefined && feature.chamferAngle !== undefined
      && Math.abs(historyFeature.chamferAngle - feature.chamferAngle) >= 0.001)) {
    throw new Error("This source edit cannot safely replay its selected-edge treatments.");
  }

  const previousFeature = feature;
  let treatmentSource = rebuilt;
  if (draftPrismAngle !== undefined) {
    treatmentSource = {
      ...shapeWithCadResult(rebuilt, await applyDraftPrism(rebuilt, { angle: draftPrismAngle })),
      draftPrismAngle,
      draftPrismSourceHeight: original.draftPrismSourceHeight ?? rebuilt.height,
      ...(original.draftPrismSourceFrame ?? rebuilt.draftPrismSourceFrame
        ? { draftPrismSourceFrame: original.draftPrismSourceFrame ?? rebuilt.draftPrismSourceFrame }
        : {}),
    };
  }
  if (original.faceDraft !== undefined && treatmentSource.faceDraft === undefined) {
    const profileChanged = JSON.stringify(original.sketchProfile) !== JSON.stringify(rebuilt.sketchProfile);
    const legacySegmentMatch = profileChanged && !original.faceDraftSourceSegmentId
      ? await legacyDraftSegmentForShape(original)
      : undefined;
    if (legacySegmentMatch?.status === "ambiguous") {
      throw new Error("The saved face draft does not identify one source sketch segment.");
    }
    const sourceSegmentId = original.faceDraftSourceSegmentId
      ?? (legacySegmentMatch?.status === "matched" ? legacySegmentMatch.segmentId : undefined);
    const segmentMatch = sourceSegmentId
      ? await draftFaceForSketchSegment(treatmentSource, sourceSegmentId)
      : undefined;
    if (segmentMatch && segmentMatch.status !== "matched"
      && (segmentMatch.status !== "unsupported" || original.faceDraftSourceSegmentId !== undefined)) {
      throw new Error("The selected sketch segment no longer maps to exactly one extrusion side face.");
    }
    const useSegmentLineage = segmentMatch?.status === "matched";
    const sourceNormal = useSegmentLineage ? segmentMatch.normal : original.faceDraft.sourceFaceNormal;
    if (!sourceNormal) throw new Error("The selected source face has no stable planar reference.");
    const matchingFaces = useSegmentLineage
      ? [{ id: segmentMatch.faceId }]
      : (await shapeFaces(treatmentSource)).filter((face) => face.surfaceType === "plane" && face.normal
        && Math.hypot(face.normal.x - sourceNormal.x, face.normal.y - sourceNormal.y, face.normal.z - sourceNormal.z) <= 1e-5);
    if (matchingFaces.length !== 1) throw new Error("The selected source face is missing or ambiguous after the sketch edit.");
    const matchedFace = matchingFaces[0]!;
    const faceSegmentMatch = useSegmentLineage
      ? segmentMatch
      : undefined;
    const faceDraft = original.faceDraft;
    const drafted = shapeWithCadResult(treatmentSource, await applySketchFaceDraft(treatmentSource, {
        ...faceDraft,
        sourceFaceId: matchedFace.id,
      }));
    treatmentSource = {
      ...drafted,
      ...retainedDraftSourcePlacement(treatmentSource, drafted.cadBrepFrame!, treatmentSource.cadBrepFrame),
      faceDraft: useSegmentLineage
        ? { ...faceDraft, sourceFaceId: matchedFace.id, sourceFaceNormal: sourceNormal }
        : faceDraft,
      ...(useSegmentLineage ? { faceDraftSourceFaceIds: treatmentSource.faceIds } : {}),
      ...(faceSegmentMatch ? { faceDraftSourceSegmentId: faceSegmentMatch.segmentId } : {}),
      faceDraftSourceFrame: original.faceDraftSourceFrame ?? treatmentSource.cadBrepFrame,
    };
  }
  const result = await applyEdgeTreatment(treatmentSource, {
    kind: previousFeature.kind,
    amount: previousFeature.amount,
    ...(previousFeature.kind === "chamfer" ? { angle: previousFeature.chamferAngle ?? 45 } : {}),
  });
  const treated = shapeWithCadResult(treatmentSource, result);
  const replayedFeature = {
    ...previousFeature,
    edgeCount: await allEdgeTreatmentEdgeCount(treatmentSource, previousFeature.kind),
  };
  const before = structuredClone(treatmentSource);
  const entry = history[0];
  return {
    ...treated,
    edgeTreatments: [replayedFeature],
    edgeTreatmentHistory: [{ ...entry, feature: replayedFeature, before, appliedFrame: edgeTreatmentAppliedFrame(treated) }],
  };
}

function sameSelectedEdgeFeature(left: EdgeTreatmentFeature, right: EdgeTreatmentFeature) {
  return left.kind === right.kind
    && left.amount === right.amount
    && left.allEdges === undefined && right.allEdges === undefined
    && (left.kind !== "chamfer" || Math.abs((left.chamferAngle ?? 45) - (right.chamferAngle ?? 45)) < 0.001)
    && JSON.stringify(left.sourceEdges) === JSON.stringify(right.sourceEdges);
}

/**
 * Replay one selected-edge fillet or chamfer by its sketch lineage (#350).
 *
 * Each recorded (segment, cap) must name exactly one edge of the rebuilt bare
 * extrusion; a segment the edit removed, or one that now names no edge or two,
 * fails the whole edit before anything is written. The rebuilt indexes are
 * used for this one treatment and not stored.
 */
async function replaySelectedEdgeTreatment(
  original: WorkplaneShape,
  rebuilt: WorkplaneShape,
  draftPrismAngle: number | undefined,
): Promise<WorkplaneShape> {
  const features = original.edgeTreatments ?? [];
  const history = original.edgeTreatmentHistory ?? [];
  const feature = features[0];
  const entry = history[0];
  const distinct = new Set(feature?.sourceEdges?.map((edge) => `${edge.cap}:${edge.segmentId}`) ?? []);
  if (features.length !== 1 || history.length !== 1 || !feature?.sourceEdges?.length || !entry
    || distinct.size !== feature.sourceEdges.length
    || !sameSelectedEdgeFeature(feature, entry.feature)
    || original.sketchOperation !== "extrude" || original.faceDraft !== undefined
    || original.draftPrismAngle !== undefined || draftPrismAngle !== undefined) {
    throw new Error("Selected-edge lineage replays exactly one selected-edge fillet or chamfer on an undrafted sketch extrusion.");
  }
  const found = await edgeIndexesForSketchSourceEdges(rebuilt, feature.sourceEdges);
  if (found.status === "unsupported") {
    throw new Error(`The selected ${feature.kind} edges on sketch segment${feature.sourceEdges.length === 1 ? "" : "s"} ${[...new Set(feature.sourceEdges.map((edge) => edge.segmentId))].join(", ")} cannot be replayed: the edited sketch is outside selected-edge lineage, which needs one straight-line region without holes, unmirrored and undrafted.`);
  }
  if (found.status !== "matched") {
    throw new Error(`The selected ${feature.kind} edge on sketch segment ${found.sourceEdge.segmentId} (${found.sourceEdge.cap} cap) is ${found.status} after the sketch edit.`);
  }
  const result = await applyEdgeTreatment(rebuilt, {
    kind: feature.kind,
    amount: feature.amount,
    ...(feature.kind === "chamfer" ? { angle: feature.chamferAngle ?? 45 } : {}),
    edges: found.edges,
  });
  const treated = shapeWithCadResult(rebuilt, result);
  const replayedFeature: EdgeTreatmentFeature = { ...feature, edgeCount: found.edges.length };
  const { edgeTreatmentHistory: _ownHistory, ...before } = rebuilt;
  return {
    ...treated,
    edgeTreatments: [replayedFeature],
    edgeTreatmentHistory: [{ ...entry, feature: replayedFeature, before: structuredClone(before), appliedFrame: edgeTreatmentAppliedFrame(treated) }],
  };
}

/** Replace a rebuilt sketch output in a project snapshot before scheduling its dependents. */
export function replaceSketchOutput(
  roots: WorkplaneShape[],
  sourceId: string,
  replacement: WorkplaneShape,
): { shapes: WorkplaneShape[]; matchCount: number } {
  let matchCount = 0;
  const visit = (shape: WorkplaneShape): WorkplaneShape => {
    if (shape.id === replacement.id && shape.sketchSourceId === sourceId) {
      matchCount += 1;
      return replacement;
    }
    if (!shape.groupedShapes?.length) return shape;
    const children = shape.groupedShapes.map(visit);
    return children.some((child, index) => child !== shape.groupedShapes![index])
      ? { ...shape, groupedShapes: children }
      : shape;
  };
  return { shapes: roots.map(visit), matchCount };
}

/**
 * Recompute every dependent node in deterministic dependency order.
 *
 * `project` already contains the newly rebuilt outputs named by
 * `changedSourceIds`; only their retained dependents are evaluated here.
 */
export async function recompute(
  project: Pick<ProjectDocument, "shapes">,
  changedSourceIds: readonly string[],
): Promise<RecomputeTreeResult> {
  const nodes = new Map<string, RecomputeNode>();
  const outputsBySource = new Map<string, string[]>();
  const active = new Set<WorkplaneShape>();
  let order = 0;

  const collect = (shape: WorkplaneShape): RecomputeTreeResult | undefined => {
    if (active.has(shape)) {
      return { ok: false, reason: "dependency_cycle", message: `Feature node ${shape.id} creates a dependency cycle.` };
    }
    if (nodes.has(shape.id)) {
      return { ok: false, reason: "dependency_ambiguous", message: `Feature node ${shape.id} appears more than once in the project tree.` };
    }
    active.add(shape);
    const children = shape.groupedShapes ?? [];
    nodes.set(shape.id, { shape, dependencies: children.map((child) => child.id), order: order++ });
    if (shape.sketchSourceId) {
      const outputs = outputsBySource.get(shape.sketchSourceId) ?? [];
      outputs.push(shape.id);
      outputsBySource.set(shape.sketchSourceId, outputs);
    }
    for (const child of children) {
      const failure = collect(child);
      if (failure) return failure;
    }
    active.delete(shape);
    return undefined;
  };

  for (const root of project.shapes) {
    const failure = collect(root);
    if (failure) return failure;
  }

  const changedNodeIds: string[] = [];
  for (const sourceId of changedSourceIds) {
    const outputs = outputsBySource.get(sourceId) ?? [];
    if (outputs.length === 0) return { ok: false, reason: "dependency_missing", message: `Sketch source ${sourceId} has no output node.` };
    if (outputs.length !== 1) return { ok: false, reason: "dependency_ambiguous", message: `Sketch source ${sourceId} has multiple output nodes.` };
    changedNodeIds.push(outputs[0]!);
  }
  if (changedNodeIds.length === 0) return { ok: false, reason: "dependency_missing", message: "No changed sketch sources were supplied." };

  const dependents = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    for (const dependency of node.dependencies) {
      if (!nodes.has(dependency)) {
        return { ok: false, reason: "dependency_missing", message: `Feature node ${id} depends on missing node ${dependency}.` };
      }
      const parents = dependents.get(dependency) ?? [];
      parents.push(id);
      dependents.set(dependency, parents);
    }
  }

  const affected = new Set(changedNodeIds);
  const pending = [...changedNodeIds];
  while (pending.length) {
    const dependency = pending.shift()!;
    for (const parent of dependents.get(dependency) ?? []) {
      if (!affected.has(parent)) {
        affected.add(parent);
        pending.push(parent);
      }
    }
  }

  const indegree = new Map<string, number>();
  for (const id of affected) {
    indegree.set(id, (nodes.get(id)?.dependencies ?? []).filter((dependency) => affected.has(dependency)).length);
  }
  const ready = [...affected].filter((id) => indegree.get(id) === 0)
    .sort((left, right) => nodes.get(left)!.order - nodes.get(right)!.order);
  const schedule: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    schedule.push(id);
    for (const parent of dependents.get(id) ?? []) {
      if (!affected.has(parent)) continue;
      const remaining = indegree.get(parent)! - 1;
      indegree.set(parent, remaining);
      if (remaining === 0) {
        ready.push(parent);
        ready.sort((left, right) => nodes.get(left)!.order - nodes.get(right)!.order);
      }
    }
  }
  if (schedule.length !== affected.size) {
    const nodeId = [...affected].find((id) => !schedule.includes(id))!;
    return { ok: false, reason: "dependency_cycle", message: `Feature node ${nodeId} is part of a dependency cycle.` };
  }
  const rebuilt = new Map<string, WorkplaneShape>();
  for (const id of schedule) {
    const node = nodes.get(id)!;
    const shape = node.shape;
    if (changedNodeIds.includes(id)) {
      rebuilt.set(id, shape);
      continue;
    }

    const children = node.dependencies.map((dependency) => rebuilt.get(dependency) ?? nodes.get(dependency)!.shape);
    try {
      if (shape.cadBrep && children.some((child) => child.hole)) {
        const result = await buildGroupFromSelection(children);
        if ("error" in result || result.cutRemovedNothing) {
          const detail = "error" in result ? result.error : "the cut removed no material";
          return { ok: false, reason: "recompute_failed", message: `Dependent boolean node ${id} could not be recomputed: ${detail}` };
        }
        // The group builder returns a natural-frame result. Restore the retained
        // group's resize, mirror, rotation and placement around that result.
        const frame = groupChildFrame(shape);
        const width = shapeWidth(result.group) * frame.scale.x;
        const depth = shapeDepth(result.group) * frame.scale.z;
        const height = result.group.height * frame.scale.y;
        const center = frame.toParent(result.group.x, (result.group.elevation ?? 0) + result.group.height / 2, result.group.z);
        rebuilt.set(id, {
          ...result.group,
          id: shape.id,
          name: shape.name,
          color: shape.color,
          locked: shape.locked,
          x: center.x,
          z: center.z,
          elevation: center.y - height / 2,
          width,
          depth,
          height,
          size: resizedShapeSize(width, depth),
          rotation: shape.rotation,
          rotationX: shape.rotationX,
          rotationZ: shape.rotationZ,
          mirrorX: shape.mirrorX,
          mirrorY: shape.mirrorY,
          mirrorZ: shape.mirrorZ,
          groupedShapes: result.group.groupedShapes?.map((child, index) => ({
            ...child,
            id: children[index]?.id ?? child.id,
          })),
        });
      } else {
        rebuilt.set(id, { ...shape, ...(children.length ? { groupedShapes: children } : {}) });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "an unexpected recompute error occurred";
      return { ok: false, reason: "recompute_failed", message: `Dependent boolean node ${id} could not be recomputed: ${detail}` };
    }
  }

  const shapes = project.shapes.map((shape) => rebuilt.get(shape.id) ?? shape);
  const updated = nodes.get(changedNodeIds[0]!)!.shape;
  return { ok: true, shapes, updated, matchCount: changedNodeIds.length };
}

export function findSketchOutput(roots: WorkplaneShape[], sourceId: string): WorkplaneShape[] {
  const matches: WorkplaneShape[] = [];
  const visit = (shape: WorkplaneShape) => {
    if (shape.sketchSourceId === sourceId) matches.push(shape);
    shape.groupedShapes?.forEach(visit);
  };
  roots.forEach(visit);
  return matches;
}
