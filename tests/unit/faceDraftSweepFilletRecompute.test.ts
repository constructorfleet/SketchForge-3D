import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Face draft sweep fillet", createdAt: 1,
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

function sweepProfile(scale = 1) {
  return {
    points: [
      { id: "a", x: -scale, z: -scale, sweepRole: "section" },
      { id: "b", x: scale, z: -scale, sweepRole: "section" },
      { id: "c", x: scale, z: scale, sweepRole: "section" },
      { id: "d", x: -scale, z: scale, sweepRole: "section" },
      { id: "p0", x: 0, z: 0, sweepRole: "spine" },
      { id: "p1", x: 10, z: 0, sweepRole: "spine" },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
      { id: "spine", startId: "p0", endId: "p1" },
    ],
  };
}

describe("fillet after a retained face draft on a sketch sweep", () => {
  it("replays one all-edge fillet after a profile edit and .skf round trip", async () => {
    const { store, document, writeCount } = projectStore();
    const engine = createEngine(store);
    const original = value(await engine.addShapes("recompute", [{
      kind: "sketchSweep", name: "Drafted sweep", profile: sweepProfile(), x: 12, z: -4, rotation: 90,
    }])).shapes[0]!;
    const selectedFace = (await shapeFaces(original)).find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.99)!;
    const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "z" as const };
    const drafted = value(await engine.changeShape("recompute", original.id, { faceDraft: draft })).shape;
    const writesBeforeTreatment = writeCount();

    const refusedAsymmetricChamfer = await engine.treat("recompute", drafted.id, { kind: "chamfer", amount: 0.1, angle: 30 });
    expect(refusedAsymmetricChamfer.ok).toBe(false);
    expect(refusedAsymmetricChamfer.ok ? undefined : refusedAsymmetricChamfer.failure.reason).toBe("cad_refused");
    expect(writeCount()).toBe(writesBeforeTreatment);

    const result = await engine.treat("recompute", drafted.id, { kind: "fillet", amount: 0.1 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const treated = value(result).shape;
    expect(treated.faceDraft).toMatchObject(draft);
    expect(treated.edgeTreatments).toHaveLength(1);
    expect(treated.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(treated.edgeTreatmentHistory).toHaveLength(1);
    expect(writeCount()).toBe(writesBeforeTreatment + 1);

    const writesBeforeSecondTreatment = writeCount();
    const secondTreatment = await engine.treat("recompute", treated.id, { kind: "fillet", amount: 0.05 });
    expect(secondTreatment.ok).toBe(false);
    expect(secondTreatment.ok ? undefined : secondTreatment.failure.reason).toBe("cad_refused");
    expect(writeCount()).toBe(writesBeforeSecondTreatment);

    const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
    const restored = await importSkfProject(archived);
    expect(restored.shapes[0]?.faceDraft).toMatchObject(draft);
    expect(restored.shapes[0]?.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    document.shapes = restored.shapes;
    const writesBeforeEdit = writeCount();
    const editedProfile = {
      ...sweepProfile(),
      points: sweepProfile().points.map((point) => point.sweepRole === "section" ? { ...point, x: point.x * 1.2 } : point),
    };
    const changed = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: editedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const replayed = value(changed).shape;
    expect(replayed.sketchProfile).toEqual(editedProfile);
    expect(replayed.faceDraft).toMatchObject(draft);
    expect(replayed.edgeTreatments).toHaveLength(1);
    expect(replayed.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(replayed.edgeTreatments?.[0]?.edgeCount).toBeGreaterThan(0);
    expect(replayed.edgeTreatmentHistory).toHaveLength(1);
    expect(replayed.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(replayed.edgeTreatments?.[0]?.edgeCount);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
    expect(writeCount()).toBe(writesBeforeEdit + 1);

    const writesBeforeDraftEdit = writeCount();
    const changedDraft = await engine.changeShape("recompute", replayed.id, {
      faceDraft: { ...draft, angle: 6, pullDirection: "x" },
    });
    expect(changedDraft.ok).toBe(false);
    expect(changedDraft.ok ? undefined : changedDraft.failure.reason).toBe("invalid_shape_request");
    expect(writeCount()).toBe(writesBeforeDraftEdit);

    const beforeMissingFaceReplay = value(await engine.project("recompute"));
    const writesBeforeMissingFaceReplay = writeCount();
    const rotatedSection = {
      ...editedProfile,
      points: editedProfile.points.map((point) => point.sweepRole === "section"
        ? { ...point, x: (point.x - point.z) / Math.sqrt(2), z: (point.x + point.z) / Math.sqrt(2) }
        : point),
    };
    const missingFaceReplay = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: rotatedSection });
    expect(missingFaceReplay.ok).toBe(false);
    expect(missingFaceReplay.ok ? undefined : missingFaceReplay.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeMissingFaceReplay);
    expect(value(await engine.project("recompute"))).toEqual(beforeMissingFaceReplay);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("chamfer after a retained face draft on a sketch sweep", () => {
  it("replays one symmetric all-edge chamfer after a profile edit and .skf round trip", async () => {
    const { store, document, writeCount } = projectStore();
    const engine = createEngine(store);
    const original = value(await engine.addShapes("recompute", [{
      kind: "sketchSweep", name: "Drafted sweep", profile: sweepProfile(), x: 12, z: -4, rotation: 90,
    }])).shapes[0]!;
    const selectedFace = (await shapeFaces(original)).find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.99)!;
    const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "z" as const };
    const drafted = value(await engine.changeShape("recompute", original.id, { faceDraft: draft })).shape;

    const chamferedResult = await engine.treat("recompute", drafted.id, {
      kind: "chamfer", amount: 0.1, angle: 45,
    });
    expect(chamferedResult.ok, JSON.stringify(chamferedResult)).toBe(true);
    const chamfered = value(chamferedResult).shape;
    expect(chamfered.faceDraft).toMatchObject(draft);
    expect(chamfered.edgeTreatments).toHaveLength(1);
    expect(chamfered.edgeTreatments?.[0]).toMatchObject({
      kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true,
    });
    expect(writeCount()).toBe(3);
    const writesBeforeSecondTreatment = writeCount();
    const secondTreatment = await engine.treat("recompute", chamfered.id, { kind: "fillet", amount: 0.05 });
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
      ...sweepProfile(),
      points: sweepProfile().points.map((point) => point.sweepRole === "section" ? { ...point, x: point.x * 1.2 } : point),
    };
    const changed = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: editedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const replayed = value(changed).shape;
    expect(replayed.sketchProfile).toEqual(editedProfile);
    expect(replayed.faceDraft).toMatchObject(draft);
    expect(replayed.edgeTreatments).toHaveLength(1);
    expect(replayed.edgeTreatments?.[0]).toMatchObject({
      kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true,
    });
    expect(replayed.edgeTreatmentHistory).toHaveLength(1);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
    expect(writeCount()).toBe(4);

    const beforeMissingFaceReplay = value(await engine.project("recompute"));
    const writesBeforeMissingFaceReplay = writeCount();
    const rotatedSection = {
      ...editedProfile,
      points: editedProfile.points.map((point) => point.sweepRole === "section"
        ? { ...point, x: (point.x - point.z) / Math.sqrt(2), z: (point.x + point.z) / Math.sqrt(2) }
        : point),
    };
    const missingFaceReplay = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: rotatedSection });
    expect(missingFaceReplay.ok).toBe(false);
    expect(missingFaceReplay.ok ? undefined : missingFaceReplay.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeMissingFaceReplay);
    expect(value(await engine.project("recompute"))).toEqual(beforeMissingFaceReplay);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("editing the angle of a retained face draft on a sketch sweep", () => {
  it.each(["fillet", "chamfer"] as const)(
    "replays one all-edge %s after an angle-only edit and a post-import profile edit",
    async (kind) => {
      const { store, document, writeCount } = projectStore();
      const engine = createEngine(store);
      const original = value(await engine.addShapes("recompute", [{
        kind: "sketchSweep", name: "Angle-edited sweep", profile: sweepProfile(), x: 12, z: -4, rotation: 90,
      }])).shapes[0]!;
      const faces = await shapeFaces(original);
      const selectedFace = faces.find((face) => face.surfaceType === "plane" && face.normal
        && Math.abs(face.normal.x) > 0.99)!;
      const otherFace = faces.find((face) => face.surfaceType === "plane" && face.id !== selectedFace.id)!;
      const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "z" as const };
      const drafted = value(await engine.changeShape("recompute", original.id, { faceDraft: draft })).shape;
      const treatment = kind === "fillet"
        ? { kind, amount: 0.1 } as const
        : { kind, amount: 0.1, angle: 45 } as const;
      const treated = value(await engine.treat("recompute", drafted.id, treatment)).shape;

      const writesBeforeRefusals = writeCount();
      const changedAxis = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, pullDirection: "x" },
      });
      expect(changedAxis.ok).toBe(false);
      expect(changedAxis.ok ? undefined : changedAxis.failure.reason).toBe("invalid_shape_request");
      const changedFace = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, sourceFaceId: otherFace.id },
      });
      expect(changedFace.ok).toBe(false);
      expect(changedFace.ok ? undefined : changedFace.failure.reason).toBe("invalid_shape_request");
      const secondTreatment = await engine.treat("recompute", treated.id, kind === "fillet"
        ? { kind: "chamfer", amount: 0.05, angle: 45 }
        : { kind: "fillet", amount: 0.05 });
      expect(secondTreatment.ok).toBe(false);
      expect(secondTreatment.ok ? undefined : secondTreatment.failure.reason).toBe("cad_refused");
      const selectedEdgeTreatment = await engine.treat("recompute", treated.id, {
        kind: "chamfer", amount: 0.05, angle: 45, edges: [0],
      });
      expect(selectedEdgeTreatment.ok).toBe(false);
      expect(selectedEdgeTreatment.ok ? undefined : selectedEdgeTreatment.failure.reason).toBe("cad_refused");
      expect(writeCount()).toBe(writesBeforeRefusals);

      const writesBeforeAngleEdit = writeCount();
      const angleEdit = await engine.changeShape("recompute", treated.id, {
        faceDraft: { ...draft, angle: 8 },
      });
      expect(angleEdit.ok, JSON.stringify(angleEdit)).toBe(true);
      const edited = value(angleEdit).shape;
      expect(edited.id).toBe(original.id);
      expect(edited.sketchSourceId).toBe(original.sketchSourceId);
      expect(edited.faceDraft).toMatchObject({ ...draft, angle: 8 });
      expect(edited.cadBrep).not.toBe(treated.cadBrep);
      expect(edited.edgeTreatments).toHaveLength(1);
      expect(edited.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      expect(edited.edgeTreatmentHistory).toHaveLength(1);
      expect(edited.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ ...draft, angle: 8 });
      expect(edited.edgeTreatments?.[0]?.edgeCount).toBeGreaterThan(0);
      expect(edited.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(edited.edgeTreatments?.[0]?.edgeCount);
      expect(writeCount()).toBe(writesBeforeAngleEdit + 1);

      const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
      const restored = await importSkfProject(archived);
      expect(restored.shapes[0]?.id).toBe(original.id);
      expect(restored.shapes[0]?.sketchSourceId).toBe(original.sketchSourceId);
      expect(restored.shapes[0]?.faceDraft).toMatchObject({ ...draft, angle: 8 });
      expect(restored.shapes[0]?.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      document.shapes = restored.shapes;

      const editedProfile = {
        ...sweepProfile(),
        points: sweepProfile().points.map((point) => point.sweepRole === "section"
          ? { ...point, x: point.x * 1.2 }
          : point),
      };
      const writesBeforeProfileEdit = writeCount();
      const profileEdit = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: editedProfile });
      expect(profileEdit.ok, JSON.stringify(profileEdit)).toBe(true);
      const replayed = value(profileEdit).shape;
      expect(replayed.id).toBe(original.id);
      expect(replayed.sketchSourceId).toBe(original.sketchSourceId);
      expect(replayed.sketchProfile).toEqual(editedProfile);
      expect(replayed.faceDraft).toMatchObject({ ...draft, angle: 8 });
      expect(replayed.edgeTreatments).toHaveLength(1);
      expect(replayed.edgeTreatments?.[0]).toMatchObject({
        kind, amount: 0.1, allEdges: true, ...(kind === "chamfer" ? { chamferAngle: 45 } : {}),
      });
      expect(replayed.edgeTreatmentHistory).toHaveLength(1);
      expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ ...draft, angle: 8 });
      expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
      expect(replayed.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(replayed.edgeTreatments?.[0]?.edgeCount);
      expect(writeCount()).toBe(writesBeforeProfileEdit + 1);

      const beforeFailedReplay = value(await engine.project("recompute"));
      const writesBeforeFailedReplay = writeCount();
      const rotatedSection = {
        ...editedProfile,
        points: editedProfile.points.map((point) => point.sweepRole === "section"
          ? { ...point, x: (point.x - point.z) / Math.sqrt(2), z: (point.x + point.z) / Math.sqrt(2) }
          : point),
      };
      const failedReplay = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: rotatedSection });
      expect(failedReplay.ok).toBe(false);
      expect(failedReplay.ok ? undefined : failedReplay.failure.reason).toBe("sweep_failed");
      expect(writeCount()).toBe(writesBeforeFailedReplay);
      expect(value(await engine.project("recompute"))).toEqual(beforeFailedReplay);
    },
    CAD_TEST_TIMEOUT_MS,
  );
});
