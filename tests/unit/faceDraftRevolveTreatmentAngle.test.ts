import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Revolve draft angle replay", createdAt: 1,
    shapes: [], history: [], historyIndex: -1, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0, placementWorkplane: horizontalPlacementWorkplane(),
    sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === "recompute" ? document : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      writes += 1; document.shapes = shapes; document.metadata.revision = writes; return { revision: writes };
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

describe("treated full-turn revolve face draft angle edits", () => {
  it.each([
    ["fillet", { kind: "fillet" as const, amount: 0.1 }],
    ["45-degree chamfer", { kind: "chamfer" as const, amount: 0.1, angle: 45 }],
  ])("replays a retained face draft and all-edge %s after changing only the angle", async (_name, treatment) => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Drafted filleted revolve", profile: [[5, -5], [10, -5], [10, 5], [5, 5]], sides: 24,
    }])).shapes[0]!;
    const cap = (await shapeFaces(created, { topology: "exact" })).find((face) =>
      face.surfaceType === "plane" && face.normal?.y! < -0.99)!;
    const draft = { sourceFaceId: cap.id, angle: 5, pullDirection: "z" as const };
    const drafted = value(await engine.changeShape("recompute", created.id, { faceDraft: draft })).shape;
    const treated = value(await engine.treat("recompute", drafted.id, treatment)).shape;
    const priorBrep = treated.cadBrep;
    const writesBeforeEdit = writeCount();

    const edited = await engine.changeShape("recompute", treated.id, { faceDraft: { ...draft, angle: 8 } });

    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const result = value(edited).shape;
    expect(writeCount()).toBe(writesBeforeEdit + 1);
    expect(result.id).toBe(treated.id);
    expect(result.sketchSourceId).toBe(treated.sketchSourceId);
    expect(result.faceDraft).toMatchObject({ ...draft, angle: 8 });
    expect(result.faceDraft?.sourceFaceId).toBe(draft.sourceFaceId);
    expect(result.edgeTreatments?.[0]).toMatchObject({ kind: treatment.kind, amount: treatment.amount, allEdges: true });
    expect(result.edgeTreatmentHistory).toHaveLength(1);
    expect(result.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ ...draft, angle: 8 });
    expect(result.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(result.edgeTreatments?.[0]?.edgeCount);
    expect(result.cadBrep).not.toBe(priorBrep);

    const writesBeforeRefusedEdits = writeCount();
    const axisEdit = await engine.changeShape("recompute", result.id, { faceDraft: { ...result.faceDraft!, pullDirection: "-z" } });
    const combinedEdit = await engine.changeShape("recompute", result.id, { faceDraft: { ...result.faceDraft!, angle: 9, pullDirection: "-z" } });
    expect(axisEdit.ok).toBe(false);
    expect(combinedEdit.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeRefusedEdits);

    const archive = await exportSkfProject({
      projectId: "recompute", projectName: "Treated revolve draft", createdAt: 1, modifiedAt: 2,
      shapes: [result], history: [editorHistoryEntry([result], [])], historyIndex: 0,
      assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    });
    const restored = await importSkfProject(archive);
    const restoredShape = restored.shapes[0]!;
    expect(restoredShape.id).toBe(result.id);
    expect(restoredShape.sketchSourceId).toBe(result.sketchSourceId);
    expect(restoredShape.faceDraft).toMatchObject({ ...draft, angle: 8 });
    expect(restoredShape.edgeTreatments).toEqual(result.edgeTreatments);

    const reopened = projectStore();
    reopened.document.shapes = restored.shapes;
    const reopenedEngine = createEngine(reopened.store);
    const editedProfile = {
      ...restoredShape.sketchProfile!,
      points: restoredShape.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const profileReplay = await reopenedEngine.changeShape("recompute", restoredShape.sketchSourceId!, { sketchProfile: editedProfile });
    expect(profileReplay.ok, JSON.stringify(profileReplay)).toBe(true);
    const profileUpdated = value(profileReplay).shape;
    expect(profileUpdated.id).toBe(result.id);
    expect(profileUpdated.sketchSourceId).toBe(result.sketchSourceId);
    expect(profileUpdated.faceDraft).toMatchObject({ ...draft, angle: 8 });
    expect(profileUpdated.edgeTreatments?.[0]).toMatchObject({ kind: treatment.kind, amount: treatment.amount, allEdges: true });
    expect(profileUpdated.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject({ ...draft, angle: 8 });
    expect(profileUpdated.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(profileUpdated.edgeTreatments?.[0]?.edgeCount);
    expect(reopened.writeCount()).toBe(1);

    const settingReplay = await reopenedEngine.changeShape("recompute", restoredShape.sketchSourceId!, { sides: 32 });
    expect(settingReplay.ok, JSON.stringify(settingReplay)).toBe(true);
    const settingUpdated = value(settingReplay).shape;
    expect(settingUpdated.sketchRevolve?.sides).toBe(32);
    expect(settingUpdated.faceDraft).toMatchObject({ ...draft, angle: 8 });
    expect(settingUpdated.edgeTreatments?.[0]).toMatchObject({ kind: treatment.kind, amount: treatment.amount, allEdges: true });
    expect(settingUpdated.edgeTreatmentHistory?.[0]?.before.sketchRevolve?.sides).toBe(32);
    expect(settingUpdated.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(settingUpdated.edgeTreatments?.[0]?.edgeCount);
    expect(reopened.writeCount()).toBe(2);

    const beforeFailedReplay = value(await reopenedEngine.project("recompute"));
    const writesBeforeFailure = reopened.writeCount();
    const invalidReplay = await reopenedEngine.changeShape("recompute", restoredShape.sketchSourceId!, {
      sketchProfile: {
        ...settingUpdated.sketchProfile!,
        points: settingUpdated.sketchProfile!.points.map((point) => ({ ...point, z: point.z * 0.001 })),
      },
    });
    expect(invalidReplay.ok).toBe(false);
    expect(invalidReplay.ok ? undefined : invalidReplay.failure.reason).toBe("sweep_failed");
    expect(reopened.writeCount()).toBe(writesBeforeFailure);
    expect(value(await reopenedEngine.project("recompute")).shapes).toEqual(beforeFailedReplay.shapes);
  }, CAD_TEST_TIMEOUT_MS);
});
