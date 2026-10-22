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
    metadata: { revision: 0 },
    projectName: "Face draft fillet replay",
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

describe("face draft and fillet replay", () => {
  it("applies one all-edge fillet after a face draft on a full-turn sketch revolve", async () => {
    const { store, document, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Drafted filleted revolve", profile: [[5, -5], [10, -5], [10, 5], [5, 5]], sides: 24,
    }])).shapes[0]!;
    const cap = (await shapeFaces(created, { topology: "exact" })).find((face) =>
      face.surfaceType === "plane" && face.normal?.y! < -0.99)!;
    const draft = { sourceFaceId: cap.id, angle: 5, pullDirection: "z" as const };
    const drafted = value(await engine.changeShape("recompute", created.id, { faceDraft: draft })).shape;

    const treated = await engine.treat("recompute", drafted.id, { kind: "fillet", amount: 0.1 });

    expect(treated.ok, JSON.stringify(treated)).toBe(true);
    const result = value(treated).shape;
    expect(result.faceDraft).toMatchObject(draft);
    expect(result.edgeTreatments).toHaveLength(1);
    expect(result.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(result.edgeTreatmentHistory).toHaveLength(1);
    expect(result.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(result.cadBrep).not.toBe(drafted.cadBrep);

    const changedProfile = {
      ...created.sketchProfile!,
      points: created.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const profileReplay = await engine.changeShape("recompute", created.sketchSourceId!, { sketchProfile: changedProfile });
    expect(profileReplay.ok, JSON.stringify(profileReplay)).toBe(true);
    const replayed = value(profileReplay).shape;
    expect(replayed.sketchProfile).toEqual(changedProfile);
    expect(replayed.faceDraft).toMatchObject(draft);
    expect(replayed.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(replayed.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(replayed.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(replayed.cadBrep).not.toBe(replayed.edgeTreatmentHistory?.[0]?.before.cadBrep);

    const settingsReplay = await engine.changeShape("recompute", created.sketchSourceId!, { sides: 32 });
    expect(settingsReplay.ok, JSON.stringify(settingsReplay)).toBe(true);
    const settingsUpdated = value(settingsReplay).shape;
    expect(settingsUpdated.sketchRevolve?.sides).toBe(32);
    expect(settingsUpdated.faceDraft).toMatchObject(draft);
    expect(settingsUpdated.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(settingsUpdated.edgeTreatmentHistory?.[0]?.before.sketchRevolve?.sides).toBe(32);
    expect(settingsUpdated.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);

    const archive = await exportSkfProject({
      projectId: "recompute", projectName: "Draft and fillet replay", createdAt: 1, modifiedAt: 2,
      shapes: [settingsUpdated], history: [editorHistoryEntry([settingsUpdated], [])], historyIndex: 0,
      assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    });
    const restored = await importSkfProject(archive);
    const restoredShape = restored.shapes[0]!;
    expect(restoredShape.faceDraft).toMatchObject(draft);
    expect(restoredShape.edgeTreatments).toEqual(settingsUpdated.edgeTreatments);
    expect(restoredShape.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);

    const reopened = projectStore();
    reopened.document.shapes = restored.shapes;
    const reopenedEngine = createEngine(reopened.store);
    const postImportReplay = await reopenedEngine.changeShape("recompute", restoredShape.sketchSourceId!, {
      sketchProfile: {
        ...restoredShape.sketchProfile!,
        points: restoredShape.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.05 })),
      },
    });
    expect(postImportReplay.ok, JSON.stringify(postImportReplay)).toBe(true);
    expect(value(postImportReplay).shape.faceDraft).toMatchObject(draft);
    expect(value(postImportReplay).shape.edgeTreatments).toEqual(settingsUpdated.edgeTreatments);
    expect(reopened.writeCount()).toBe(1);
    expect(writeCount()).toBeGreaterThan(0);
  }, CAD_TEST_TIMEOUT_MS);
});
