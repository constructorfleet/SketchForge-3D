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

function extrusionProfile(halfWidth = 1, centerX = 0): SketchProfile {
  return {
    points: [
      { id: "a", x: centerX - halfWidth, z: -1 }, { id: "b", x: centerX + halfWidth, z: -1 },
      { id: "c", x: centerX + halfWidth, z: 1 }, { id: "d", x: centerX - halfWidth, z: 1 },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
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
  it("rebuilds a persisted sketch revolve from an edited source profile", async () => {
    const { store } = projectStore();
    const engine = createEngine(store);
    const original = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Source revolve", profile: [[1, -5], [2, -5], [2, 5], [1, 5]],
      sides: 48, x: 12, z: -4, elevation: 7,
    }])).shapes[0]!;
    expect(value(await engine.project("recompute")).shapes[0]?.sketchSourceId).toBe(original.sketchSourceId);
    const sourceProfile = original.sketchProfile!;
    const changedProfile = {
      ...sourceProfile,
      points: sourceProfile.points.map((point) => ({ ...point, x: point.x * 2 })),
    };
    const beforeGeometry = original.importedMesh?.positions;

    const changed = await engine.changeShape("recompute", original.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated).toMatchObject({
      id: original.id, sketchSourceId: original.sketchSourceId, sketchOperation: "revolve",
      sketchProfile: changedProfile, x: 12, z: -4, elevation: 7,
    });
    expect(updated.width).toBeGreaterThan(original.width);
    expect(updated.importedMesh?.positions).not.toEqual(beforeGeometry);
  });

  it("rebuilds a retained boolean ancestor after editing a source revolve", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "revolve", name: "Source revolve", profile: [[0, -5], [2, -5], [2, 5], [0, 5]], sides: 48, x: 12, z: -4, elevation: 7 },
      { kind: "box", name: "Cutter", width: 1, depth: 1, height: 12, x: 12, z: -4, elevation: 6, hole: true },
    ]));
    const source = created.shapes[0]!;
    const group = value(await engine.cut("recompute", { solidIds: [source.id], holeIds: [created.shapes[1]!.id] })).shape;
    const sourceChild = group.groupedShapes!.find((child) => child.sketchSourceId === source.sketchSourceId)!;
    const previousGroupBrep = group.cadBrep;
    const previousWrites = writeCount();
    const changedProfile = {
      ...sourceChild.sketchProfile!,
      points: sourceChild.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.5 })),
    };

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    expect(value(changed).shape).toMatchObject({
      id: sourceChild.id, sketchSourceId: source.sketchSourceId, sketchOperation: "revolve",
      sketchProfile: changedProfile, x: sourceChild.x, z: sourceChild.z, elevation: sourceChild.elevation,
    });
    expect(writeCount()).toBe(previousWrites + 1);
    const persisted = value(await engine.project("recompute")).shapes.find((shape) => shape.id === group.id)!;
    expect(persisted.cadBrep).not.toBe(previousGroupBrep);
    expect(persisted.groupedShapes?.find((child) => child.id === sourceChild.id)?.sketchProfile).toEqual(changedProfile);
  });

  it("rebuilds a retained boolean ancestor when a source revolve setting changes", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "revolve", name: "Source revolve", profile: [[0, -5], [2, -5], [2, 5], [0, 5]], sides: 48, x: 12, z: -4, elevation: 7 },
      { kind: "box", name: "Cutter", width: 1, depth: 1, height: 12, x: 12, z: -4, elevation: 6, hole: true },
    ]));
    const source = created.shapes[0]!;
    const group = value(await engine.cut("recompute", { solidIds: [source.id], holeIds: [created.shapes[1]!.id] })).shape;
    const sourceChild = group.groupedShapes!.find((child) => child.sketchSourceId === source.sketchSourceId)!;
    const previousGroupBrep = group.cadBrep;
    const previousMesh = sourceChild.importedMesh?.positions;
    const previousWrites = writeCount();

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sides: 64 });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated).toMatchObject({
      id: sourceChild.id, sketchSourceId: source.sketchSourceId, sketchOperation: "revolve",
      sketchRevolve: { sides: 64 }, x: sourceChild.x, z: sourceChild.z,
      elevation: sourceChild.elevation, rotation: sourceChild.rotation,
      rotationX: sourceChild.rotationX, rotationZ: sourceChild.rotationZ,
    });
    expect(updated.importedMesh?.positions).not.toEqual(previousMesh);
    expect(writeCount()).toBe(previousWrites + 1);
    const persisted = value(await engine.project("recompute")).shapes.find((shape) => shape.id === group.id)!;
    expect(persisted.cadBrep).not.toBe(previousGroupBrep);
    expect(persisted.groupedShapes?.find((child) => child.id === sourceChild.id)).toMatchObject({
      sketchSourceId: source.sketchSourceId, sketchRevolve: { sides: 64 },
    });
    expect(persisted).toMatchObject({ x: group.x, z: group.z, elevation: group.elevation, rotation: group.rotation });
  });

  it("rolls back a source revolve setting edit when its retained cut becomes ineffective", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "revolve", name: "Source revolve", profile: [[0, -5], [2, -5], [2, 5], [0, 5]], sides: 48 },
      { kind: "box", name: "Cutter", width: 0.5, depth: 0.5, height: 12, x: 1.8, hole: true },
    ]));
    const source = created.shapes[0]!;
    const group = value(await engine.cut("recompute", { solidIds: [source.id], holeIds: [created.shapes[1]!.id] })).shape;
    const sourceChild = group.groupedShapes!.find((child) => child.sketchSourceId === source.sketchSourceId)!;
    const before = value(await engine.project("recompute"));
    const previousWrites = writeCount();

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sides: 64, sweepAngle: 90, startAngle: 180 });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure).toMatchObject({
      reason: "sweep_failed", message: expect.stringMatching(/dependent boolean/i),
    });
    expect(writeCount()).toBe(previousWrites);
    const after = value(await engine.project("recompute"));
    expect(after.revision).toBe(before.revision);
    expect(after.shapes.find((shape) => shape.id === group.id)).toEqual(before.shapes.find((shape) => shape.id === group.id));
    expect(after.shapes.find((shape) => shape.id === group.id)?.groupedShapes?.find((child) => child.id === sourceChild.id)?.sketchRevolve).toMatchObject({
      sides: 48, sweepAngle: 360, startAngle: 0,
    });
  });

  it("rolls back a source revolve edit when its retained boolean can no longer be rebuilt", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "revolve", name: "Source revolve", profile: [[0, -5], [2, -5], [2, 5], [0, 5]], sides: 48 },
      { kind: "box", name: "Cutter", width: 0.5, depth: 0.5, height: 12, x: 1.8, hole: true },
    ]));
    const source = created.shapes[0]!;
    const group = value(await engine.cut("recompute", { solidIds: [source.id], holeIds: [created.shapes[1]!.id] })).shape;
    const before = value(await engine.project("recompute"));
    const previousWrites = writeCount();
    const disjointProfile = {
      ...source.sketchProfile!,
      points: source.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 0.1 })),
    };

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: disjointProfile });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure).toMatchObject({
      reason: "sweep_failed", message: expect.stringMatching(/dependent boolean/i),
    });
    expect(writeCount()).toBe(previousWrites);
    const after = value(await engine.project("recompute"));
    expect(after.revision).toBe(before.revision);
    expect(after.shapes.find((shape) => shape.id === group.id)).toEqual(before.shapes.find((shape) => shape.id === group.id));
  });

  it("rebuilds a persisted sketch extrusion from an edited source profile", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Source extrusion", width: 2, depth: 2, height: 3, x: 12, z: -4, elevation: 7 },
      { kind: "box", name: "Cutter", width: 0.5, depth: 0.5, height: 4, x: 12, z: -4, elevation: 6.5, hole: true },
    ]));
    const original = created.shapes[0]!;
    const document = await store.read("recompute");
    document!.shapes[0] = {
      ...document!.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: extrusionProfile(),
      sketchSourceId: "sketch/source-extrusion",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    };
    const cut = value(await engine.cut("recompute", {
      solidIds: [original.id], holeIds: [created.shapes[1]!.id],
    })).shape;
    const sourceChild = cut.groupedShapes!.find((shape) => shape.sketchSourceId === "sketch/source-extrusion")!;
    const beforeBrep = cut.cadBrep;
    const beforeWrites = writeCount();

    const changed = await engine.changeShape("recompute", "sketch/source-extrusion", {
      sketchProfile: extrusionProfile(2),
    });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated).toMatchObject({
      id: sourceChild.id, sketchSourceId: "sketch/source-extrusion", sketchOperation: "extrude",
      sketchProfile: extrusionProfile(2), x: sourceChild.x, z: sourceChild.z, elevation: sourceChild.elevation,
    });
    expect(updated.width).toBeCloseTo(4, 2);
    expect(updated.cadBrep).not.toBe(original.cadBrep);
    expect(writeCount()).toBe(beforeWrites + 1);
    const persisted = value(await engine.project("recompute")).shapes.find((shape) => shape.id === cut.id)!;
    expect(persisted.cadBrep).not.toBe(beforeBrep);
    expect(persisted.groupedShapes?.find((shape) => shape.id === sourceChild.id)?.sketchProfile).toEqual(extrusionProfile(2));
    expect(persisted).toMatchObject({ x: cut.x, z: cut.z, elevation: cut.elevation });
    expect(value(await engine.project("recompute")).revision).toBe(beforeWrites + 1);
  });

  it("does not persist an extrusion source edit when rebuilt geometry breaks its dependent boolean", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Source extrusion", width: 2, depth: 2, height: 3, x: 12, z: -4, elevation: 7 },
      { kind: "box", name: "Cutter", width: 0.5, depth: 0.5, height: 4, x: 12, z: -4, elevation: 6.5, hole: true },
    ]));
    const document = await store.read("recompute");
    document!.shapes[0] = {
      ...document!.shapes[0]!, sketchOperation: "extrude", sketchProfile: extrusionProfile(),
      sketchSourceId: "sketch/source-extrusion", cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    };
    const cut = value(await engine.cut("recompute", { solidIds: [created.shapes[0]!.id], holeIds: [created.shapes[1]!.id] })).shape;
    const before = value(await engine.project("recompute"));
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("recompute", "sketch/source-extrusion", {
      sketchProfile: extrusionProfile(1, 100),
    });

    expect(changed.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeEdit);
    const afterBooleanRefusal = value(await engine.project("recompute"));
    expect(afterBooleanRefusal.revision).toBe(before.revision);
    expect(afterBooleanRefusal.shapes.find((shape) => shape.id === cut.id)).toEqual(before.shapes.find((shape) => shape.id === cut.id));

    const invalid = await engine.changeShape("recompute", "sketch/source-extrusion", {
      sketchProfile: { points: [], segments: [] },
    });
    expect(invalid.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeEdit);
    const afterInvalidProfile = value(await engine.project("recompute"));
    expect(afterInvalidProfile.revision).toBe(before.revision);
    expect(afterInvalidProfile.shapes.find((shape) => shape.id === cut.id)).toEqual(before.shapes.find((shape) => shape.id === cut.id));
  });

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
