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
    metadata: { revision: 0 }, projectName: "Face draft fillet group replay", createdAt: 1,
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

function findNestedShape(shape: WorkplaneShape, predicate: (candidate: WorkplaneShape) => boolean): WorkplaneShape | undefined {
  if (predicate(shape)) return shape;
  for (const child of shape.groupedShapes ?? []) {
    const found = findNestedShape(child, predicate);
    if (found) return found;
  }
  return undefined;
}

describe("face-drafted fillet recompute inside retained booleans", () => {
  it("replays after a profile edit through a nested sketch source and .skf round trip", async () => {
    const { store, document, writeCount } = projectStore();
    const engine = createEngine(store);
    const added = value(await engine.addShapes("recompute", [
      { kind: "revolve", name: "Drafted fillet cutter", profile: [[1, -4], [2, -4], [2, 4], [1, 4]], sides: 24 },
      { kind: "box", name: "Target", width: 12, depth: 12, height: 12 },
    ]));
    const revolve = added.shapes.find((shape) => shape.sketchOperation === "revolve")!;
    const target = added.shapes.find((shape) => shape.kind === "box")!;
    const selectedFace = (await shapeFaces(revolve, { topology: "exact" })).find((face) =>
      face.surfaceType === "plane" && face.normal?.y! < -0.99)!;
    const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "z" as const };
    const drafted = value(await engine.changeShape("recompute", revolve.id, { faceDraft: draft })).shape;
    const treated = value(await engine.treat("recompute", drafted.id, { kind: "fillet", amount: 0.1 })).shape;
    const cut = value(await engine.cut("recompute", { solidIds: [target.id], holeIds: [treated.id] })).shape;
    const child = findNestedShape(cut, (shape) => shape.sketchSourceId === revolve.sketchSourceId)!;
    expect(child.edgeTreatmentHistory?.[0]?.feature).toMatchObject({ kind: "fillet", allEdges: true, amount: 0.1 });
    const sourceId = child.sketchSourceId!;
    const groupId = cut.id;

    const archived = await store.read("recompute");
    const restored = await importSkfProject(await exportSkfProject({ ...archived!, modifiedAt: 2 }));
    document.shapes = restored.shapes;
    const restoredGroup = value(await engine.project("recompute")).shapes.find((shape) => shape.id === groupId)!;
    const restoredChild = findNestedShape(restoredGroup, (shape) => shape.sketchSourceId === sourceId)!;
    expect(restoredChild.id).toBe(child.id);
    expect(restoredChild.faceDraft).toMatchObject(draft);
    expect(restoredChild.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    const beforeEdit = value(await engine.project("recompute"));
    const beforeGroup = beforeEdit.shapes.find((shape) => shape.id === groupId)!;
    const beforeChild = findNestedShape(beforeGroup, (shape) => shape.id === restoredChild.id)!;
    const writesBeforeEdit = writeCount();
    const sourceProfile = revolve.sketchProfile!;
    const editedProfile = {
      ...sourceProfile,
      points: sourceProfile.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };

    const changed = await engine.changeShape("recompute", sourceId, { sketchProfile: editedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updatedChild = value(changed).shape;
    expect(updatedChild.id).toBe(restoredChild.id);
    expect(updatedChild.sketchSourceId).toBe(sourceId);
    expect(updatedChild.sketchProfile).toEqual(editedProfile);
    expect(updatedChild.faceDraft).toMatchObject(draft);
    expect(updatedChild.edgeTreatments).toHaveLength(1);
    expect(updatedChild.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(updatedChild.edgeTreatmentHistory).toHaveLength(1);
    expect(updatedChild.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(updatedChild.edgeTreatments?.[0]?.edgeCount);
    expect(updatedChild.edgeTreatmentHistory?.[0]?.before.faceDraft).toMatchObject(draft);
    expect(updatedChild.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(editedProfile);
    expect(updatedChild.edgeTreatmentHistory?.[0]?.before.cadBrep).not.toBe(updatedChild.cadBrep);
    expect(writeCount()).toBe(writesBeforeEdit + 1);

    const afterGroup = value(await engine.project("recompute")).shapes.find((shape) => shape.id === groupId)!;
    expect(afterGroup.id).toBe(beforeGroup.id);
    expect(afterGroup.cadBrep).not.toBe(beforeGroup.cadBrep);
    expect(findNestedShape(afterGroup, (shape) => shape.id === beforeChild.id)).toMatchObject({
      id: beforeChild.id, sketchSourceId: sourceId, faceDraft: draft, sketchProfile: editedProfile,
    });
  }, CAD_TEST_TIMEOUT_MS);
});
