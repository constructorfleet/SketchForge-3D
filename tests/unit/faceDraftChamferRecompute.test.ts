import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Face draft chamfer replay",
    createdAt: 1,
    shapes: [],
    history: [],
    historyIndex: -1,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(),
    sketchPlacementWorkplane: horizontalPlacementWorkplane(),
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
  return { store, writeCount: () => writes, document };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("face draft and chamfer replay", () => {
  it("replays one persisted all-edge chamfer after a face draft on a retained full-turn revolve", async () => {
    const { store, writeCount, document } = projectStore();
    const engine = createEngine(store);
    const profilePoints = [[5, -5], [10, -5], [10, 5], [5, 5]] as const;
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Drafted chamfered revolve", profile: profilePoints, sides: 24,
    }])).shapes[0]!;
    const selectedFace = (await shapeFaces(created, { topology: "exact" })).find((face) =>
      face.surfaceType === "plane" && face.normal?.y! < -0.99)!;
    const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "z" as const };
    const drafted = value(await engine.changeShape("recompute", created.id, { faceDraft: draft })).shape;
    // Clone the drafted result into a control feature with identical source data
    // and displayed dimensions. Removing draft metadata and the drafted BREP
    // makes its treatment path rebuild from the undrafted profile, while the
    // tested feature must chamfer its retained drafted BREP. (A revolve that
    // still carries a BREP is treated from that BREP, not rebuilt.)
    const control = structuredClone(drafted);
    control.id = `${drafted.id}-undrafted-control`;
    control.sketchSourceId = `${drafted.sketchSourceId}-undrafted-control`;
    delete control.faceDraft;
    delete control.faceDraftSourceFrame;
    delete control.faceDraftSourceScale;
    delete control.cadBrep;
    delete control.cadBrepFrame;
    document.shapes.push(control);
    const capArea = async (shape: WorkplaneShape) => {
      const cap = (await shapeFaces(shape, { topology: "exact" }))
        .find((face) => face.surfaceType === "plane" && face.normal?.y! < -0.99);
      if (!cap) throw new Error("The revolve is missing its negative-Y planar cap");
      return cap.area;
    };
    const writesBeforeTreatment = writeCount();

    const treated = await engine.treat("recompute", drafted.id, { kind: "chamfer", amount: 0.1, angle: 45 });
    const controlTreated = await engine.treat("recompute", control.id, { kind: "chamfer", amount: 0.1, angle: 45 });

    expect(treated.ok, JSON.stringify(treated)).toBe(true);
    expect(controlTreated.ok, JSON.stringify(controlTreated)).toBe(true);
    const result = value(treated).shape;
    expect(result.faceDraft).toMatchObject(draft);
    expect(result.edgeTreatments).toHaveLength(1);
    expect(result.edgeTreatments?.[0]).toMatchObject({ kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true });
    expect(result.edgeTreatmentHistory).toHaveLength(1);
    expect(result.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(result.cadBrep).not.toBe(drafted.cadBrep);
    expect(writeCount()).toBe(writesBeforeTreatment + 2);
    expect(await capArea(drafted)).toBeDefined();
    expect(await capArea(result)).not.toBeCloseTo(await capArea(value(controlTreated).shape), 5);
    expect(result.cadBrep).not.toBe(value(controlTreated).shape.cadBrep);

    const writesBeforeEdit = writeCount();
    const changedProfile = {
      ...created.sketchProfile!,
      points: created.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const replayed = await engine.changeShape("recompute", created.sketchSourceId!, { sketchProfile: changedProfile });
    const controlProfileReplay = await engine.changeShape("recompute", control.sketchSourceId!, { sketchProfile: changedProfile });

    expect(replayed.ok, JSON.stringify(replayed)).toBe(true);
    expect(controlProfileReplay.ok, JSON.stringify(controlProfileReplay)).toBe(true);
    const updated = value(replayed).shape;
    expect(updated.sketchProfile).toEqual(changedProfile);
    expect(updated.faceDraft).toMatchObject(draft);
    expect(updated.edgeTreatments?.[0]).toMatchObject({ kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true });
    expect(updated.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(updated.edgeTreatments?.[0]?.edgeCount);
    expect(updated.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(updated.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(updated.cadBrep).not.toBe(updated.edgeTreatmentHistory?.[0]?.before.cadBrep);
    expect(writeCount()).toBe(writesBeforeEdit + 2);
    expect(await capArea(updated)).not.toBeCloseTo(await capArea(value(controlProfileReplay).shape), 5);

    const writesBeforeSettingEdit = writeCount();
    const settingReplay = await engine.changeShape("recompute", created.sketchSourceId!, { sides: 32 });
    const controlSettingReplay = await engine.changeShape("recompute", control.sketchSourceId!, { sides: 32 });

    expect(settingReplay.ok, JSON.stringify(settingReplay)).toBe(true);
    expect(controlSettingReplay.ok, JSON.stringify(controlSettingReplay)).toBe(true);
    const settingUpdated = value(settingReplay).shape;
    expect(settingUpdated.sketchRevolve?.sides).toBe(32);
    expect(settingUpdated.faceDraft).toMatchObject(draft);
    expect(settingUpdated.edgeTreatments?.[0]).toMatchObject({ kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true });
    expect(settingUpdated.edgeTreatmentHistory).toHaveLength(1);
    expect(settingUpdated.edgeTreatmentHistory?.[0]?.before.sketchRevolve?.sides).toBe(32);
    expect(settingUpdated.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(settingUpdated.cadBrep).toBeTruthy();
    expect(settingUpdated.cadBrep).not.toBe(settingUpdated.edgeTreatmentHistory?.[0]?.before.cadBrep);
    expect(writeCount()).toBe(writesBeforeSettingEdit + 2);
    expect(await capArea(settingUpdated)).not.toBeCloseTo(await capArea(value(controlSettingReplay).shape), 5);

    const archive = await exportSkfProject({
      projectId: "recompute",
      projectName: "Draft and chamfer replay",
      createdAt: 1,
      modifiedAt: 2,
      shapes: [settingUpdated],
      history: [editorHistoryEntry([settingUpdated], [])],
      historyIndex: 0,
      assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE,
      snapGrid: DEFAULT_SNAP_GRID,
      placementElevation: 0,
    });
    const restored = await importSkfProject(archive);
    const restoredShape = restored.shapes[0]!;
    expect(restoredShape.faceDraft).toMatchObject(draft);
    expect(restoredShape.edgeTreatments).toEqual(settingUpdated.edgeTreatments);
    expect(restoredShape.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);

    const reopened = projectStore();
    reopened.document.shapes = restored.shapes;
    const reopenedEngine = createEngine(reopened.store);
    const postImportProfile = {
      ...restoredShape.sketchProfile!,
      points: restoredShape.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.05 })),
    };
    const postImportReplay = await reopenedEngine.changeShape("recompute", restoredShape.sketchSourceId!, { sketchProfile: postImportProfile });
    expect(postImportReplay.ok, JSON.stringify(postImportReplay)).toBe(true);
    const restoredReplayShape = value(postImportReplay).shape;
    expect(restoredReplayShape.sketchProfile).toEqual(postImportProfile);
    expect(restoredReplayShape.faceDraft).toMatchObject(draft);
    expect(restoredReplayShape.edgeTreatments).toEqual(settingUpdated.edgeTreatments);
    expect(restoredReplayShape.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(reopened.writeCount()).toBe(1);
    expect(await capArea(restoredReplayShape)).toBeDefined();

    const beforeFailedReplay = value(await engine.project("recompute"));
    const writesBeforeFailedReplay = writeCount();
    const tooShortForChamfer = {
      ...changedProfile,
      points: changedProfile.points.map((point) => ({ ...point, z: point.z * 0.01 })),
    };
    const failedReplay = await engine.changeShape("recompute", created.sketchSourceId!, { sketchProfile: tooShortForChamfer });

    expect(failedReplay.ok).toBe(false);
    expect(failedReplay.ok ? undefined : failedReplay.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeFailedReplay);
    expect(value(await engine.project("recompute")).shapes).toEqual(beforeFailedReplay.shapes);
  }, CAD_TEST_TIMEOUT_MS);

});
