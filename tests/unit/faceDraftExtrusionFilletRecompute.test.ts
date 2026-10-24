import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Face draft extrusion fillet", createdAt: 1,
    shapes: [], history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === "recompute" ? document : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      writes += 1;
      document.shapes = shapes;
      document.metadata.revision = writes;
      return { revision: writes };
    },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { store, document, writeCount: () => writes };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("fillet after a retained face draft on a sketch extrusion", () => {
  it("replays one all-edge fillet after a profile edit and .skf round trip", async () => {
    const { store, document, writeCount } = projectStore();
    const engine = createEngine(store);
    const original = await sketchExtrusionShapeFromRequest({
      id: "drafted-extrusion", sketchSourceId: "sketch/drafted-extrusion", name: "Drafted extrusion",
      profile: {
        points: [
          { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
          { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
        ],
        segments: [
          { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
          { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
        ],
      },
      height: 3, x: 0, z: 0, elevation: 0, rotation: 0,
    });
    document.shapes = [original];
    const faces = await shapeFaces(original);
    const selectedFace = faces.find((face) => face.surfaceType === "plane" && face.normal
      && (Math.abs(face.normal.x) > 0.99 || Math.abs(face.normal.z) > 0.99))!;
    const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" as const };
    const drafted = value(await engine.changeShape("recompute", original.id, { faceDraft: draft })).shape;
    const writesBeforeTreatment = writeCount();

    const refusedChamfer = await engine.treat("recompute", drafted.id, { kind: "chamfer", amount: 0.1, angle: 30 });

    expect(refusedChamfer.ok).toBe(false);
    expect(refusedChamfer.ok ? undefined : refusedChamfer.failure.reason).toBe("cad_refused");
    expect(writeCount()).toBe(writesBeforeTreatment);

    const result = await engine.treat("recompute", drafted.id, { kind: "fillet", amount: 0.1 });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const treated = value(result).shape;
    expect(treated.id).toBe(original.id);
    expect(treated.sketchSourceId).toBe(original.sketchSourceId);
    expect(treated.faceDraft).toMatchObject(draft);
    expect(treated.edgeTreatments).toHaveLength(1);
    expect(treated.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(treated.edgeTreatmentHistory).toHaveLength(1);
    expect(writeCount()).toBe(writesBeforeTreatment + 1);

    const groupId = treated.id;
    const sourceId = treated.sketchSourceId!;
    const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
    const restored = await importSkfProject(archived);
    expect(restored.shapes[0]?.id).toBe(groupId);
    expect(restored.shapes[0]?.faceDraft).toMatchObject(draft);
    expect(restored.shapes[0]?.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    document.shapes = restored.shapes;
    const writesBeforeEdit = writeCount();

    const editedProfile = {
      ...original.sketchProfile!,
      points: original.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const changed = await engine.changeShape("recompute", sourceId, { sketchProfile: editedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const replayed = value(changed).shape;
    expect(replayed.id).toBe(groupId);
    expect(replayed.sketchSourceId).toBe(sourceId);
    expect(replayed.sketchProfile).toEqual(editedProfile);
    expect(replayed.cadBrep).not.toBe(treated.cadBrep);
    expect(replayed.faceDraft).toMatchObject({ angle: draft.angle, pullDirection: draft.pullDirection });
    expect(replayed.faceDraft?.sourceFaceId).not.toBe(draft.sourceFaceId);
    expect(replayed.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
    expect(replayed.edgeTreatments).toHaveLength(1);
    expect(replayed.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(replayed.edgeTreatmentHistory).toHaveLength(1);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ angle: draft.angle, pullDirection: draft.pullDirection });
    expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft?.sourceFaceId).toBe(replayed.faceDraft?.sourceFaceId);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.cadBrep).not.toBe(replayed.cadBrep);
    expect(writeCount()).toBe(writesBeforeEdit + 1);

    const writesBeforeFailedReplay = writeCount();
    const rotatedProfile = {
      ...editedProfile,
      points: editedProfile.points.map((point) => ({
        ...point,
        x: (point.x - point.z) / Math.sqrt(2),
        z: (point.x + point.z) / Math.sqrt(2),
      })),
    };
    const failedReplay = await engine.changeShape("recompute", sourceId, { sketchProfile: rotatedProfile });

    expect(failedReplay.ok, JSON.stringify(failedReplay)).toBe(true);
    const replayedAfterRotation = value(failedReplay).shape;
    expect(replayedAfterRotation.sketchProfile).toEqual(rotatedProfile);
    expect(replayedAfterRotation.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
    expect(replayedAfterRotation.faceDraft?.sourceFaceId).not.toBe(replayed.faceDraft?.sourceFaceId);
    expect(writeCount()).toBe(writesBeforeFailedReplay + 1);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("chamfer after a retained face draft on a sketch extrusion", () => {
  it("replays one symmetric all-edge chamfer after a profile edit and .skf round trip", async () => {
    const { store, document, writeCount } = projectStore();
    const engine = createEngine(store);
    const original = await sketchExtrusionShapeFromRequest({
      id: "drafted-chamfer-extrusion", sketchSourceId: "sketch/drafted-chamfer-extrusion", name: "Drafted extrusion",
      profile: {
        points: [
          { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
          { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
        ],
        segments: [
          { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
          { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
        ],
      },
      height: 3, x: 0, z: 0, elevation: 0, rotation: 0,
    });
    document.shapes = [original];
    const faces = await shapeFaces(original);
    const selectedFace = faces.find((face) => face.surfaceType === "plane" && face.normal
      && (Math.abs(face.normal.x) > 0.99 || Math.abs(face.normal.z) > 0.99))!;
    const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" as const };
    const drafted = value(await engine.changeShape("recompute", original.id, { faceDraft: draft })).shape;
    const writesBeforeTreatment = writeCount();

    const asymmetric = await engine.treat("recompute", drafted.id, { kind: "chamfer", amount: 0.1, angle: 30 });
    expect(asymmetric.ok).toBe(false);
    expect(asymmetric.ok ? undefined : asymmetric.failure.reason).toBe("cad_refused");
    expect(writeCount()).toBe(writesBeforeTreatment);
    const selectedEdge = await engine.treat("recompute", drafted.id, { kind: "chamfer", amount: 0.1, angle: 45, edges: [0] });
    expect(selectedEdge.ok).toBe(false);
    expect(selectedEdge.ok ? undefined : selectedEdge.failure.reason).toBe("cad_refused");
    expect(writeCount()).toBe(writesBeforeTreatment);

    const result = await engine.treat("recompute", drafted.id, { kind: "chamfer", amount: 0.1, angle: 45 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const treated = value(result).shape;
    expect(treated.faceDraft).toMatchObject(draft);
    expect(treated.edgeTreatments).toHaveLength(1);
    expect(treated.edgeTreatments?.[0]).toMatchObject({
      kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true,
    });
    expect(treated.edgeTreatmentHistory).toHaveLength(1);

    const writesBeforeSecondTreatment = writeCount();
    const secondTreatment = await engine.treat("recompute", treated.id, { kind: "fillet", amount: 0.05 });
    expect(secondTreatment.ok).toBe(false);
    expect(secondTreatment.ok ? undefined : secondTreatment.failure.reason).toBe("cad_refused");
    expect(writeCount()).toBe(writesBeforeSecondTreatment);

    const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
    const restored = await importSkfProject(archived);
    expect(restored.shapes[0]?.faceDraft).toMatchObject(draft);
    expect(restored.shapes[0]?.edgeTreatments?.[0]).toMatchObject({
      kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true,
    });
    document.shapes = restored.shapes;

    const editedProfile = {
      ...original.sketchProfile!,
      points: original.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const writesBeforeEdit = writeCount();
    const changed = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: editedProfile });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const replayed = value(changed).shape;
    expect(replayed.sketchProfile).toEqual(editedProfile);
    expect(replayed.faceDraft).toMatchObject({ angle: draft.angle, pullDirection: draft.pullDirection });
    expect(replayed.faceDraft?.sourceFaceId).not.toBe(draft.sourceFaceId);
    expect(replayed.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
    expect(replayed.edgeTreatments).toHaveLength(1);
    expect(replayed.edgeTreatments?.[0]).toMatchObject({
      kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true,
    });
    expect(replayed.edgeTreatmentHistory).toHaveLength(1);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ angle: draft.angle, pullDirection: draft.pullDirection });
    expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft?.sourceFaceId).toBe(replayed.faceDraft?.sourceFaceId);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
    expect(writeCount()).toBe(writesBeforeEdit + 1);

    const writesBeforeFailedReplay = writeCount();
    const rotatedProfile = {
      ...editedProfile,
      points: editedProfile.points.map((point) => ({
        ...point,
        x: (point.x - point.z) / Math.sqrt(2),
        z: (point.x + point.z) / Math.sqrt(2),
      })),
    };
    const failedReplay = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: rotatedProfile });
    expect(failedReplay.ok, JSON.stringify(failedReplay)).toBe(true);
    const replayedAfterRotation = value(failedReplay).shape;
    expect(replayedAfterRotation.sketchProfile).toEqual(rotatedProfile);
    expect(replayedAfterRotation.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
    expect(replayedAfterRotation.faceDraft?.sourceFaceId).not.toBe(replayed.faceDraft?.sourceFaceId);
    expect(writeCount()).toBe(writesBeforeFailedReplay + 1);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("editing angle and pull axis of a retained face draft on a sketch extrusion", () => {
  it.each(["fillet", "chamfer"] as const)(
    "replays one all-edge %s after a combined edit and a post-import profile edit",
    async (kind) => {
      const { store, document, writeCount } = projectStore();
      const engine = createEngine(store);
      const original = await sketchExtrusionShapeFromRequest({
        id: `angle-edit-${kind}`, sketchSourceId: `sketch/angle-edit-${kind}`, name: "Drafted extrusion",
        profile: {
          points: [
            { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
            { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
          ],
          segments: [
            { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
            { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
          ],
        },
        height: 3, x: 0, z: 0, elevation: 0, rotation: 0,
      });
      document.shapes = [original];
      const faces = await shapeFaces(original);
      const selectedFace = faces.find((face) => face.surfaceType === "plane" && face.normal
        && (Math.abs(face.normal.x) > 0.99 || Math.abs(face.normal.z) > 0.99))!;
      const otherFace = faces.find((face) => face.surfaceType === "plane" && face.id !== selectedFace.id)!;
      const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" as const };
      const drafted = value(await engine.changeShape("recompute", original.id, { faceDraft: draft })).shape;
      const treatment = kind === "fillet"
        ? { kind, amount: 0.1 } as const
        : { kind, amount: 0.1, angle: 45 } as const;
      const treated = value(await engine.treat("recompute", drafted.id, treatment)).shape;

      const writesBeforeInvalidEdit = writeCount();
      const changedFace = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, sourceFaceId: otherFace.id, angle: 7 },
      });
      expect(changedFace.ok).toBe(false);
      expect(changedFace.ok ? undefined : changedFace.failure.reason).toBe("invalid_shape_request");
      expect(writeCount()).toBe(writesBeforeInvalidEdit);
      const writesBeforeCombinedEdit = writeCount();
      const combinedEdit = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, angle: 8, pullDirection: "-y" },
      });
      expect(combinedEdit.ok, JSON.stringify(combinedEdit)).toBe(true);
      const edited = value(combinedEdit).shape;
      expect(edited.id).toBe(original.id);
      expect(edited.sketchSourceId).toBe(original.sketchSourceId);
      expect(edited.faceDraft).toMatchObject({ ...draft, angle: 8, pullDirection: "-y" });
      expect(edited.cadBrep).not.toBe(treated.cadBrep);
      expect(edited.edgeTreatments).toHaveLength(1);
      expect(edited.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      expect(edited.edgeTreatmentHistory).toHaveLength(1);
      expect(edited.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ ...draft, angle: 8, pullDirection: "-y" });
      expect(edited.edgeTreatmentHistory?.[0]?.before.cadBrep).not.toBe(edited.cadBrep);
      expect(edited.edgeTreatments?.[0]?.edgeCount).toBeGreaterThan(0);
      expect(edited.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(edited.edgeTreatments?.[0]?.edgeCount);
      expect(writeCount()).toBe(writesBeforeCombinedEdit + 1);

      const writesBeforeAdditionalTreatment = writeCount();
      const secondTreatment = await engine.treat("recompute", edited.id, kind === "fillet"
        ? { kind: "chamfer", amount: 0.05, angle: 45 }
        : { kind: "fillet", amount: 0.05 });
      expect(secondTreatment.ok).toBe(false);
      expect(secondTreatment.ok ? undefined : secondTreatment.failure.reason).toBe("cad_refused");
      const selectedEdgeTreatment = await engine.treat("recompute", edited.id, {
        kind: "chamfer", amount: 0.05, angle: 45, edges: [0],
      });
      expect(selectedEdgeTreatment.ok).toBe(false);
      expect(selectedEdgeTreatment.ok ? undefined : selectedEdgeTreatment.failure.reason).toBe("cad_refused");
      expect(writeCount()).toBe(writesBeforeAdditionalTreatment);

      const prismDraft = await engine.changeShape("recompute", edited.id, { draftPrismAngle: 4 });
      expect(prismDraft.ok).toBe(false);
      expect(prismDraft.ok ? undefined : prismDraft.failure.reason).toBe("invalid_shape_request");
      expect(writeCount()).toBe(writesBeforeCombinedEdit + 1);

      const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
      const restored = await importSkfProject(archived);
      expect(restored.shapes[0]?.id).toBe(original.id);
      expect(restored.shapes[0]?.sketchSourceId).toBe(original.sketchSourceId);
      expect(restored.shapes[0]?.faceDraft).toMatchObject({ ...draft, angle: 8, pullDirection: "-y" });
      expect(restored.shapes[0]?.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      document.shapes = restored.shapes;

      const editedProfile = {
        ...original.sketchProfile!,
        points: original.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.15 })),
      };
      const writesBeforeProfileEdit = writeCount();
      const profileEdit = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: editedProfile });
      expect(profileEdit.ok, JSON.stringify(profileEdit)).toBe(true);
      const replayed = value(profileEdit).shape;
      expect(replayed.id).toBe(original.id);
      expect(replayed.sketchSourceId).toBe(original.sketchSourceId);
      expect(replayed.sketchProfile).toEqual(editedProfile);
      expect(replayed.faceDraft).toMatchObject({ angle: 8, pullDirection: "-y" });
      expect(replayed.faceDraft?.sourceFaceId).not.toBe(draft.sourceFaceId);
      expect(replayed.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
      expect(replayed.edgeTreatments).toHaveLength(1);
      expect(replayed.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      expect(replayed.edgeTreatmentHistory).toHaveLength(1);
      expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ angle: 8, pullDirection: "-y" });
      expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft?.sourceFaceId).toBe(replayed.faceDraft?.sourceFaceId);
      expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
      expect(replayed.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(replayed.edgeTreatments?.[0]?.edgeCount);
      expect(writeCount()).toBe(writesBeforeProfileEdit + 1);

      const writesBeforeFailedReplay = writeCount();
      const rotatedProfile = {
        ...editedProfile,
        points: editedProfile.points.map((point) => ({
          ...point,
          x: (point.x - point.z) / Math.sqrt(2),
          z: (point.x + point.z) / Math.sqrt(2),
        })),
      };
      const failedReplay = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: rotatedProfile });
      expect(failedReplay.ok, JSON.stringify(failedReplay)).toBe(true);
      const replayedAfterRotation = value(failedReplay).shape;
      expect(replayedAfterRotation.sketchProfile).toEqual(rotatedProfile);
      expect(replayedAfterRotation.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
      expect(replayedAfterRotation.faceDraft?.sourceFaceId).not.toBe(replayed.faceDraft?.sourceFaceId);
      expect(writeCount()).toBe(writesBeforeFailedReplay + 1);
    },
    CAD_TEST_TIMEOUT_MS,
  );
});

describe("reselecting the source face of an untreated sketch-extrusion draft", () => {
  it("rebuilds from the original extrusion, persists the new face, and replays it after import", async () => {
    const makeOriginal = async (projectName: string, profileScale = 1) => {
      const { store, document, writeCount } = projectStore();
      document.projectName = projectName;
      const original = await sketchExtrusionShapeFromRequest({
        id: "face-reselection-extrusion", sketchSourceId: "sketch/face-reselection-extrusion",
        name: "Face-reselection extrusion",
        profile: {
          points: [
            { id: "a", x: -profileScale, z: -1 }, { id: "b", x: profileScale, z: -1 },
            { id: "c", x: profileScale, z: 1 }, { id: "d", x: -profileScale, z: 1 },
          ],
          segments: [
            { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
            { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
          ],
        },
        height: 3, x: 0, z: 0, elevation: 0, rotation: 0,
      });
      document.shapes = [original];
      return { store, document, writeCount, original };
    };

    const { store, document, writeCount, original } = await makeOriginal("Face reselection");
    const engine = createEngine(store);
    const sourceFaces = await shapeFaces(original);
    const firstFace = sourceFaces.find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.99)!;
    const newlySelectedSourceFace = sourceFaces.find((face) => face.surfaceType === "plane" && face.normal
      && face.normal.x * firstFace.normal!.x < -0.99)!;

    const originalProperties = await shapeProperties(original);
    const firstDraft = { sourceFaceId: firstFace.id, angle: 5, pullDirection: "y" as const };
    const initiallyDrafted = value(await engine.changeShape("recompute", original.id, {
      faceDraft: firstDraft,
    })).shape;
    expect(initiallyDrafted.faceDraftSourceFaceIds).toEqual(sourceFaces.map((face) => face.id));
    const firstDraftProperties = await shapeProperties(initiallyDrafted);
    const faceOnDraftedShape = (await shapeFaces(initiallyDrafted))
      .find((face) => face.id === newlySelectedSourceFace.id);
    expect(faceOnDraftedShape).toBeDefined();
    if (!faceOnDraftedShape) throw new Error("Expected the untouched opposite source face to retain its ID.");
    expect(faceOnDraftedShape?.surfaceType).toBe("plane");
    expect(faceOnDraftedShape?.id).toBe(newlySelectedSourceFace.id);
    const writesBeforeReselection = writeCount();

    const reselection = await engine.changeShape("recompute", initiallyDrafted.id, {
      faceDraft: { sourceFaceId: faceOnDraftedShape.id, angle: 7, pullDirection: "y" },
    });

    expect(reselection.ok, JSON.stringify(reselection)).toBe(true);
    const redrafted = value(reselection).shape;
    expect(writeCount()).toBe(writesBeforeReselection + 1);
    expect(redrafted.id).toBe(original.id);
    expect(redrafted.sketchSourceId).toBe(original.sketchSourceId);
    expect(redrafted.faceDraft).toMatchObject({
      sourceFaceId: faceOnDraftedShape.id, angle: 7, pullDirection: "y",
    });
    const redraftedProperties = await shapeProperties(redrafted);
    expect(redraftedProperties.volume).toBeGreaterThan(0);
    expect(redraftedProperties.volume).toBeLessThan(originalProperties.volume);

    const reference = projectStore();
    reference.document.shapes = [structuredClone(original)];
    const referenceEngine = createEngine(reference.store);
    const referenceFace = (await shapeFaces(original)).find((face) => face.id === newlySelectedSourceFace.id)!;
    const referenceDraft = value(await referenceEngine.changeShape("recompute", original.id, {
      faceDraft: { sourceFaceId: referenceFace.id, angle: 7, pullDirection: "y" },
    })).shape;
    const referenceProperties = await shapeProperties(referenceDraft);
    expect(redraftedProperties.volume).toBeCloseTo(referenceProperties.volume, 6);
    expect(redraftedProperties.centerOfMass.x).toBeCloseTo(referenceProperties.centerOfMass.x, 6);
    expect(redraftedProperties.centerOfMass.y).toBeCloseTo(referenceProperties.centerOfMass.y, 6);
    expect(redraftedProperties.centerOfMass.z).toBeCloseTo(referenceProperties.centerOfMass.z, 6);
    expect(
      Math.abs(firstDraftProperties.centerOfMass.x - redraftedProperties.centerOfMass.x)
        + Math.abs(firstDraftProperties.centerOfMass.z - redraftedProperties.centerOfMass.z),
    ).toBeGreaterThan(1e-6);

    const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
    const restored = await importSkfProject(archived);
    expect(restored.shapes[0]?.id).toBe(original.id);
    expect(restored.shapes[0]?.sketchSourceId).toBe(original.sketchSourceId);
    expect(restored.shapes[0]?.faceDraft).toMatchObject({
      sourceFaceId: faceOnDraftedShape.id, angle: 7, pullDirection: "y",
    });
    expect(restored.shapes[0]?.faceDraftSourceFaceIds).toEqual(sourceFaces.map((face) => face.id));
    document.shapes = restored.shapes;

    const editedProfile = {
      ...original.sketchProfile!,
      points: original.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const writesBeforeProfileEdit = writeCount();
    const profileEdit = await engine.changeShape("recompute", original.sketchSourceId!, {
      sketchProfile: editedProfile,
    });
    expect(profileEdit.ok, JSON.stringify(profileEdit)).toBe(true);
    const replayed = value(profileEdit).shape;
    expect(writeCount()).toBe(writesBeforeProfileEdit + 1);
    expect(replayed.id).toBe(original.id);
    expect(replayed.sketchSourceId).toBe(original.sketchSourceId);
    expect(replayed.faceDraft).toMatchObject({
      angle: 7, pullDirection: "y",
    });
    expect(replayed.sketchProfile).toEqual(editedProfile);
    expect(replayed.faceDraftSourceFaceIds).toContain(replayed.faceDraft?.sourceFaceId);
    expect(replayed.faceDraftSourceFaceIds).not.toContain(faceOnDraftedShape.id);
    const replayedProperties = await shapeProperties(replayed);
    expect(replayedProperties.volume).toBeGreaterThan(0);
    const profileReference = await makeOriginal("Fresh profile replay reference", 1.1);
    const profileReferenceEngine = createEngine(profileReference.store);
    const profileReferenceFace = (await shapeFaces(profileReference.original)).find((face) =>
      face.surfaceType === "plane" && face.normal
        && face.normal.x * newlySelectedSourceFace.normal!.x > 0.99,
    )!;
    const profileReferenceDraft = value(await profileReferenceEngine.changeShape(
      "recompute", profileReference.original.id,
      { faceDraft: { sourceFaceId: profileReferenceFace.id, angle: 7, pullDirection: "y" } },
    )).shape;
    const profileReferenceProperties = await shapeProperties(profileReferenceDraft);
    expect(replayedProperties.volume).toBeCloseTo(profileReferenceProperties.volume, 6);
    expect(replayedProperties.centerOfMass.x).toBeCloseTo(profileReferenceProperties.centerOfMass.x, 6);
    expect(replayedProperties.centerOfMass.y).toBeCloseTo(profileReferenceProperties.centerOfMass.y, 6);
    expect(replayedProperties.centerOfMass.z).toBeCloseTo(profileReferenceProperties.centerOfMass.z, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("rejects generated face IDs and profile-plus-reselection atomically", async () => {
    const { store, document, writeCount, original } = await (async () => {
      const { store, document, writeCount } = projectStore();
      const original = await sketchExtrusionShapeFromRequest({
        id: "face-reselection-safety", sketchSourceId: "sketch/face-reselection-safety",
        name: "Face-reselection safety",
        profile: {
          points: [
            { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
            { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
          ],
          segments: [
            { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
            { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
          ],
        },
        height: 3, x: 0, z: 0, elevation: 0, rotation: 0,
      });
      document.shapes = [original];
      return { store, document, writeCount, original };
    })();
    const engine = createEngine(store);
    const sourceFaces = await shapeFaces(original);
    const selectedFace = sourceFaces.find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.99)!;
    const drafted = value(await engine.changeShape("recompute", original.id, {
      faceDraft: { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" },
    })).shape;
    const draftedFaces = await shapeFaces(drafted);
    const generatedId = draftedFaces.find((face) => !sourceFaces.some((source) => source.id === face.id))?.id;
    expect(generatedId).toBeDefined();
    const before = value(await engine.project("recompute"));
    const writesBefore = writeCount();

    const generatedIdResult = await engine.changeShape("recompute", drafted.id, {
      faceDraft: { sourceFaceId: generatedId!, angle: 7, pullDirection: "y" },
    });
    expect(generatedIdResult.ok).toBe(false);
    expect(writeCount()).toBe(writesBefore);
    expect(value(await engine.project("recompute"))).toEqual(before);

    const duplicateTargetId = sourceFaces.find((face) => face.id !== selectedFace.id)!.id;
    const storedShape = document.shapes[0]!;
    storedShape.faceIds = [...(storedShape.faceIds ?? [])];
    storedShape.faceIds[storedShape.faceIds.length - 1] = duplicateTargetId;
    const beforeAmbiguousReselection = value(await engine.project("recompute"));
    const ambiguousResult = await engine.changeShape("recompute", drafted.id, {
      faceDraft: { sourceFaceId: duplicateTargetId, angle: 7, pullDirection: "y" },
    });
    expect(ambiguousResult.ok).toBe(false);
    expect(writeCount()).toBe(writesBefore);
    expect(value(await engine.project("recompute"))).toEqual(beforeAmbiguousReselection);

    const changedProfile = {
      ...original.sketchProfile!,
      points: original.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const combinedResult = await engine.changeShape("recompute", original.sketchSourceId!, {
      sketchProfile: changedProfile,
      faceDraft: { sourceFaceId: sourceFaces.find((face) => face.id !== selectedFace.id)!.id, angle: 7, pullDirection: "y" },
    });
    expect(combinedResult.ok).toBe(false);
    expect(writeCount()).toBe(writesBefore);
    expect(value(await engine.project("recompute"))).toEqual(before);
    expect(document.shapes[0]?.faceDraft?.sourceFaceId).toBe(selectedFace.id);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("editing the pull axis of a retained face draft on a sketch extrusion", () => {
  it.each(["fillet", "chamfer"] as const)(
    "replays one all-edge %s after an axis-only edit and a post-import profile edit",
    async (kind) => {
      const { store, document, writeCount } = projectStore();
      const engine = createEngine(store);
      const original = await sketchExtrusionShapeFromRequest({
        id: `axis-edit-${kind}`, sketchSourceId: `sketch/axis-edit-${kind}`, name: "Axis-edited extrusion",
        profile: {
          points: [
            { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
            { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
          ],
          segments: [
            { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
            { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
          ],
        },
        height: 3, x: 0, z: 0, elevation: 0, rotation: 0,
      });
      document.shapes = [original];
      const faces = await shapeFaces(original);
      const selectedFace = faces.find((face) => face.surfaceType === "plane" && face.normal
        && (Math.abs(face.normal.x) > 0.99 || Math.abs(face.normal.z) > 0.99))!;
      const otherFace = faces.find((face) => face.surfaceType === "plane" && face.id !== selectedFace.id)!;
      const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" as const };
      const drafted = value(await engine.changeShape("recompute", original.id, { faceDraft: draft })).shape;
      const treatment = kind === "fillet"
        ? { kind, amount: 0.1 } as const
        : { kind, amount: 0.1, angle: 45 } as const;
      const treated = value(await engine.treat("recompute", drafted.id, treatment)).shape;

      const writesBeforeInvalidAxis = writeCount();
      const beforeInvalidAxis = value(await engine.project("recompute"));
      const invalidPullDirection = selectedFace.normal!.x > 0.99 ? "x"
        : selectedFace.normal!.x < -0.99 ? "-x"
          : selectedFace.normal!.z > 0.99 ? "z" : "-z";
      const invalidAxis = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, pullDirection: invalidPullDirection },
      });
      expect(invalidAxis.ok).toBe(false);
      expect(writeCount()).toBe(writesBeforeInvalidAxis);
      expect(value(await engine.project("recompute"))).toEqual(beforeInvalidAxis);

      const changedFace = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, sourceFaceId: otherFace.id, pullDirection: "-y" },
      });
      expect(changedFace.ok).toBe(false);
      expect(changedFace.ok ? undefined : changedFace.failure.reason).toBe("invalid_shape_request");
      expect(writeCount()).toBe(writesBeforeInvalidAxis);

      const writesBeforeAxisEdit = writeCount();
      const axisEdit = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, pullDirection: "-y" },
      });
      expect(axisEdit.ok, JSON.stringify(axisEdit)).toBe(true);
      const edited = value(axisEdit).shape;
      expect(edited.id).toBe(original.id);
      expect(edited.sketchSourceId).toBe(original.sketchSourceId);
      expect(edited.faceDraft).toMatchObject({ ...draft, pullDirection: "-y" });
      expect(edited.cadBrep).not.toBe(treated.cadBrep);
      expect(edited.edgeTreatments).toHaveLength(1);
      expect(edited.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      expect(edited.edgeTreatmentHistory).toHaveLength(1);
      expect(edited.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ ...draft, pullDirection: "-y" });
      expect(edited.edgeTreatments?.[0]?.edgeCount).toBeGreaterThan(0);
      expect(edited.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(edited.edgeTreatments?.[0]?.edgeCount);
      expect(writeCount()).toBe(writesBeforeAxisEdit + 1);

      const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
      const restored = await importSkfProject(archived);
      expect(restored.shapes[0]?.id).toBe(original.id);
      expect(restored.shapes[0]?.sketchSourceId).toBe(original.sketchSourceId);
      expect(restored.shapes[0]?.faceDraft).toMatchObject({ ...draft, pullDirection: "-y" });
      expect(restored.shapes[0]?.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      document.shapes = restored.shapes;

      const editedProfile = {
        ...original.sketchProfile!,
        points: original.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.15 })),
      };
      const writesBeforeProfileEdit = writeCount();
      const profileEdit = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: editedProfile });
      expect(profileEdit.ok, JSON.stringify(profileEdit)).toBe(true);
      const replayed = value(profileEdit).shape;
      expect(replayed.id).toBe(original.id);
      expect(replayed.sketchSourceId).toBe(original.sketchSourceId);
      expect(replayed.sketchProfile).toEqual(editedProfile);
      expect(replayed.faceDraft).toMatchObject({ angle: draft.angle, pullDirection: "-y" });
      expect(replayed.faceDraft?.sourceFaceId).not.toBe(draft.sourceFaceId);
      expect(replayed.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
      expect(replayed.edgeTreatments).toHaveLength(1);
      expect(replayed.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      expect(replayed.edgeTreatmentHistory).toHaveLength(1);
      expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ angle: draft.angle, pullDirection: "-y" });
      expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft?.sourceFaceId).toBe(replayed.faceDraft?.sourceFaceId);
      expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
      expect(replayed.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(replayed.edgeTreatments?.[0]?.edgeCount);
      expect(writeCount()).toBe(writesBeforeProfileEdit + 1);

      const writesBeforeFailedReplay = writeCount();
      const rotatedProfile = {
        ...editedProfile,
        points: editedProfile.points.map((point) => ({
          ...point,
          x: (point.x - point.z) / Math.sqrt(2),
          z: (point.x + point.z) / Math.sqrt(2),
        })),
      };
      const failedReplay = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: rotatedProfile });
      expect(failedReplay.ok, JSON.stringify(failedReplay)).toBe(true);
      const replayedAfterRotation = value(failedReplay).shape;
      expect(replayedAfterRotation.sketchProfile).toEqual(rotatedProfile);
      expect(replayedAfterRotation.faceDraftSourceSegmentId).toBe(treated.faceDraftSourceSegmentId);
      expect(replayedAfterRotation.faceDraft?.sourceFaceId).not.toBe(replayed.faceDraft?.sourceFaceId);
      expect(writeCount()).toBe(writesBeforeFailedReplay + 1);
    },
    CAD_TEST_TIMEOUT_MS,
  );
});
