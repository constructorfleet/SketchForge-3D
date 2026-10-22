import { buildGroupFromSelection } from "./serverShapeBooleans.js";
import {
  allEdgeTreatmentEdgeCount,
  applyDraftPrism,
  applyEdgeTreatment,
  applySketchFaceDraft,
  shapeWithCadResult,
} from "./serverCadOperations.js";
import { shapeFaces } from "./serverCadShell.js";
import { cadSketchRegions, cadSketchSweepPaths } from "./sketchCadProfile.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type RecomputeTreeResult =
  | { ok: true; shapes: WorkplaneShape[]; updated: WorkplaneShape; matchCount: number }
  | { ok: false; reason: "recompute_failed" | "dependency_missing" | "dependency_ambiguous"; message?: string };

function appliedFrame(shape: WorkplaneShape) {
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
  const supportedFaceDraftExtrusionFillet = original.sketchOperation === "extrude"
    && extrusionRegions.length === 1
    && extrusionRegions[0]?.holes.length === 0
    && feature?.kind === "fillet";
  let supportedFaceDraftSweepFillet = false;
  if (original.sketchOperation === "sweep" && original.sketchProfile && feature?.kind === "fillet") {
    try {
      const { sections, spine } = cadSketchSweepPaths(original.sketchProfile);
      supportedFaceDraftSweepFillet = sections.length === 1 && sections[0]?.holes.length === 0 && spine.steps.length > 0;
    } catch {
      supportedFaceDraftSweepFillet = false;
    }
  }
  const supportedFaceDraftTreatment = original.faceDraft !== undefined
    && features.length === 1
    && history.length === 1
    && historyFeature?.kind === feature?.kind
    && feature?.allEdges === true
    && historyFeature.allEdges === true
    && (supportedFaceDraftRevolve || supportedFaceDraftExtrusionFillet || supportedFaceDraftSweepFillet)
    && (feature.kind !== "chamfer" || Math.abs((feature.chamferAngle ?? 45) - 45) < 0.001)
    && (historyFeature.kind !== "chamfer" || Math.abs((historyFeature.chamferAngle ?? 45) - 45) < 0.001);
  if (original.faceDraft !== undefined && !supportedFaceDraftTreatment) {
    throw new Error("A face draft can replay one all-edge fillet on a single-loop sketch extrusion or single-section sketch sweep, or one symmetric all-edge chamfer or all-edge fillet on a plain full-turn revolve.");
  }
  if (features.length !== 1 || history.length !== 1
    || !feature || !historyFeature
    || feature.allEdges !== true || historyFeature.allEdges !== true
    || historyFeature.kind !== feature.kind
    || historyFeature.amount !== feature.amount
    || (feature.kind === "chamfer" && feature.chamferAngle !== undefined && Math.abs(feature.chamferAngle - 45) >= 0.001)
    || (historyFeature.kind === "chamfer" && historyFeature.chamferAngle !== undefined && Math.abs(historyFeature.chamferAngle - 45) >= 0.001)
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
    const sourceNormal = original.faceDraft.sourceFaceNormal;
    if (!sourceNormal) throw new Error("The selected source face has no stable planar reference.");
    const matchingFaces = (await shapeFaces(treatmentSource)).filter((face) => face.surfaceType === "plane"
      && face.normal
      && Math.hypot(face.normal.x - sourceNormal.x, face.normal.y - sourceNormal.y, face.normal.z - sourceNormal.z) <= 1e-5);
    if (matchingFaces.length !== 1) throw new Error("The selected source face is missing or ambiguous after the sketch edit.");
    const faceDraft = original.faceDraft;
    treatmentSource = {
      ...shapeWithCadResult(treatmentSource, await applySketchFaceDraft(treatmentSource, {
        ...faceDraft,
        sourceFaceId: matchingFaces[0]!.id,
      })),
      faceDraft,
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
    edgeTreatmentHistory: [{ ...entry, feature: replayedFeature, before, appliedFrame: appliedFrame(treated) }],
  };
}

/** Find a retained sketch output anywhere in the feature tree, replace it, then rebuild boolean ancestors bottom-up. */
export async function recomputeSketchOutput(
  roots: WorkplaneShape[],
  sourceId: string,
  replacement: WorkplaneShape,
): Promise<RecomputeTreeResult> {
  let matchCount = 0;
  let updated: WorkplaneShape | undefined;

  const visit = async (shape: WorkplaneShape): Promise<WorkplaneShape> => {
    if (shape.id === replacement.id && shape.sketchSourceId === sourceId) {
      matchCount += 1;
      updated = replacement;
      return replacement;
    }
    if (!shape.groupedShapes?.length) return shape;

    const children: WorkplaneShape[] = [];
    let changed = false;
    for (const child of shape.groupedShapes) {
      const next = await visit(child);
      children.push(next);
      changed ||= next !== child;
    }
    if (!changed) return shape;

    // Plain groups are containers; boolean groups have retained operand hole
    // modes and exact BREP. Rebuild those in dependency order after their child.
    if (!shape.cadBrep || !children.some((child) => child.hole)) {
      return { ...shape, groupedShapes: children };
    }
    const result = await buildGroupFromSelection(children);
    if ("error" in result || result.cutRemovedNothing) {
      throw new Error("The edited sketch made a dependent boolean invalid or ineffective.");
    }
    return {
      ...result.group,
      id: shape.id,
      name: shape.name,
      color: shape.color,
      locked: shape.locked,
      // `children` are expressed in this group's local coordinate system.
      // Rebuilding a new group from them produces a local origin; restore the
      // retained group's world placement on the rebuilt ancestor.
      x: result.group.x + shape.x,
      z: result.group.z + shape.z,
      elevation: (result.group.elevation ?? 0) + (shape.elevation ?? 0),
      rotation: shape.rotation,
      rotationX: shape.rotationX,
      rotationZ: shape.rotationZ,
      // The group builder creates fresh child IDs because ordinary grouping
      // is a new operation. Recompute is different: each retained child is the
      // same feature with new geometry, so keep its existing feature identity.
      groupedShapes: result.group.groupedShapes?.map((child, index) => ({
        ...child,
        id: children[index]?.id ?? child.id,
      })),
    };
  };

  try {
    const shapes = [] as WorkplaneShape[];
    for (const root of roots) shapes.push(await visit(root));
    if (matchCount === 0) return { ok: false, reason: "dependency_missing" };
    if (matchCount !== 1) return { ok: false, reason: "dependency_ambiguous" };
    return { ok: true, shapes, updated: updated!, matchCount };
  } catch (error) {
    return {
      ok: false,
      reason: "recompute_failed",
      message: error instanceof Error ? error.message : "A dependent feature could not be recomputed.",
    };
  }
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
