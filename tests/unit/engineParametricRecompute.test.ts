import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";

function profile(sectionHalfWidth = 1, spineStart = 0, spineEnd = 10, spineOffset = 0): SketchProfile {
  return {
    points: [
      { id: "a", x: -sectionHalfWidth, z: -1, sweepRole: "section" },
      { id: "b", x: sectionHalfWidth, z: -1, sweepRole: "section" },
      { id: "c", x: sectionHalfWidth, z: 1, sweepRole: "section" },
      { id: "d", x: -sectionHalfWidth, z: 1, sweepRole: "section" },
      { id: "p0", x: spineStart, z: spineOffset, sweepRole: "spine" },
      { id: "p1", x: spineEnd, z: spineOffset, sweepRole: "spine" },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" },
      { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" },
      { id: "da", startId: "d", endId: "a" },
      { id: "spine", startId: "p0", endId: "p1" },
    ],
  };
}

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Parametric recompute",
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
  return { store, writeCount: () => writes };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("dependency-ordered feature recomputation", () => {
  it("rebuilds a boolean cut after its nested source sketch changes and persists the result", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "sketchSweep", name: "Source duct", profile: profile() },
      { kind: "box", name: "Cutter", width: 2, depth: 4, height: 4, x: 0, elevation: 5, hole: true },
    ]));
    const source = created.shapes[0]!;
    const group = value(await engine.cut("recompute", {
      solidIds: [source.id],
      holeIds: [created.shapes[1]!.id],
    })).shape;
    const beforeBrep = group.cadBrep;
    const writesBeforeEdit = writeCount();

    const editedProfile = profile(2);
    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: editedProfile });

    expect(changed.ok).toBe(true);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
    const current = value(await engine.project("recompute"));
    const persistedGroup = current.shapes.find((shape) => shape.id === group.id)!;
    expect(persistedGroup.groupedShapes?.find((child) => child.sketchSourceId === source.sketchSourceId)?.sketchProfile).toEqual(editedProfile);
    expect(persistedGroup.cadBrep).not.toBe(beforeBrep);

    const bytes = await exportSkfProject({
      projectId: "recompute",
      projectName: current.name,
      createdAt: current.createdAt,
      modifiedAt: current.createdAt,
      shapes: current.shapes,
      history: [],
      historyIndex: -1,
      assets: [],
      workspace: current.workspace,
      snapGrid: current.snapGrid,
      placementElevation: 0,
    });
    const restored = await importSkfProject(bytes);
    const restoredGroup = restored.shapes.find((shape) => shape.id === group.id)!;
    expect(restoredGroup.cadBrep).toBe(persistedGroup.cadBrep);
    expect(restoredGroup.groupedShapes?.find((child) => child.sketchSourceId === source.sketchSourceId)?.sketchProfile).toEqual(editedProfile);
  });

  it("rolls back all writes when an invalid upstream sketch is submitted", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "sketchSweep", name: "Source duct", profile: profile() },
      { kind: "box", name: "Cutter", width: 2, depth: 4, height: 4, x: 0, elevation: 5, hole: true },
    ]));
    const source = created.shapes[0]!;
    const group = value(await engine.cut("recompute", {
      solidIds: [source.id],
      holeIds: [created.shapes[1]!.id],
    })).shape;
    const before = value(await engine.project("recompute"));
    const writesBeforeEdit = writeCount();
    const invalid = profile();
    invalid.points[0]!.x = Number.NaN;

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: invalid });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure.reason).toBe("invalid_shape_request");
    expect(writeCount()).toBe(writesBeforeEdit);
    const after = value(await engine.project("recompute"));
    expect(after.shapes.find((shape) => shape.id === group.id)).toEqual(before.shapes.find((shape) => shape.id === group.id));
  });
});
