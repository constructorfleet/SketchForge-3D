import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { applyEdgeTreatment, applySketchFaceDraft, shapeWithCadResult } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

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
  return { store, writeCount: () => writes, document };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

async function persistAllEdgeFillet(
  engine: ReturnType<typeof createEngine>,
  store: ProjectStore,
  projectId: string,
  shapeId: string,
  amount = 0.1,
) {
  const before = await store.read(projectId);
  const source = before!.shapes.find((shape) => shape.id === shapeId)!;
  const treated = value(await engine.treat(projectId, shapeId, { kind: "fillet", amount })).shape;
  const feature = { kind: "fillet" as const, amount, edgeCount: 12, allEdges: true as const };
  const persisted = {
    ...treated,
    edgeTreatments: [feature],
    edgeTreatmentHistory: [{ id: `all-edge-fillet-${shapeId}`, createdAt: 1, feature, before: source }],
  };
  const after = await store.read(projectId);
  const index = after!.shapes.findIndex((shape) => shape.id === shapeId);
  after!.shapes[index] = persisted;
  return persisted;
}

async function persistAllEdgeChamfer(
  engine: ReturnType<typeof createEngine>,
  store: ProjectStore,
  projectId: string,
  shapeId: string,
  amount = 0.1,
) {
  const before = await store.read(projectId);
  const source = before!.shapes.find((shape) => shape.id === shapeId)!;
  const treated = value(await engine.treat(projectId, shapeId, { kind: "chamfer", amount })).shape;
  const feature = { kind: "chamfer" as const, amount, chamferAngle: 45, edgeCount: 12, allEdges: true as const };
  const persisted = {
    ...treated,
    edgeTreatments: [feature],
    edgeTreatmentHistory: [{ id: `all-edge-chamfer-${shapeId}`, createdAt: 1, feature, before: source }],
  };
  const after = await store.read(projectId);
  const index = after!.shapes.findIndex((shape) => shape.id === shapeId);
  after!.shapes[index] = persisted;
  return persisted;
}

describe("dependency-ordered feature recomputation", () => {
  it("persists and replays one face draft on a retained sketch extrusion", async () => {
    const { store, writeCount, document } = projectStore();
    const engine = createEngine(store);
    const original = await sketchExtrusionShapeFromRequest({
      id: "drafted-extrusion", sketchSourceId: "sketch/drafted-extrusion", name: "Drafted extrusion",
      profile: extrusionProfile(), height: 3, x: 4, z: -2, elevation: 7, rotation: 90,
    });
    document.shapes = [original];
    const sourceFaces = await shapeFaces(original);
    const selectedFace = sourceFaces.find((face) => face.normal && face.surfaceType === "plane"
      && (Math.abs(face.normal.x) > 0.99 || Math.abs(face.normal.z) > 0.99))!;
    const draft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" as const };

    const createdDraft = await engine.changeShape("recompute", original.id, { faceDraft: draft });

    expect(createdDraft.ok, JSON.stringify(createdDraft)).toBe(true);
    const drafted = value(createdDraft).shape;
    expect(drafted).toMatchObject({ id: original.id, sketchSourceId: original.sketchSourceId, faceDraft: draft,
      x: original.x, z: original.z, elevation: original.elevation, rotation: original.rotation });
    expect(drafted.faceDraft?.sourceFaceNormal).toEqual(selectedFace.normal);
    expect(drafted.cadBrep).not.toBe(original.cadBrep);
    const rotatedDraft = value(await engine.changeShape("recompute", original.id, { rotation: 135 })).shape;
    expect(rotatedDraft.faceDraft?.sourceFaceNormal).toEqual(drafted.faceDraft?.sourceFaceNormal);
    const persisted = await store.read("recompute");
    const restored = await importSkfProject(await exportSkfProject({ ...persisted!, modifiedAt: 1 }));
    const reloaded = restored.shapes[0]!;
    expect(reloaded.faceDraft).toMatchObject(draft);
    expect(reloaded.faceDraftSourceFrame).toEqual(drafted.faceDraftSourceFrame);
    document.shapes = restored.shapes;
    const restoredDraft = reloaded.faceDraft!;

    const beforeEditWrites = writeCount();
    const changed = await engine.changeShape("recompute", original.sketchSourceId!, {
      sketchProfile: extrusionProfile(1.5),
    });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    expect(value(changed).shape).toMatchObject({
      id: original.id, sketchSourceId: original.sketchSourceId, faceDraft: restoredDraft,
      sketchProfile: extrusionProfile(1.5), x: original.x, z: original.z, elevation: original.elevation, rotation: 135,
    });
    expect(value(changed).shape.cadBrep).not.toBe(rotatedDraft.cadBrep);
    expect(writeCount()).toBe(beforeEditWrites + 1);

    const beforeClear = writeCount();
    const cleared = await engine.changeShape("recompute", original.sketchSourceId!, { faceDraft: null });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(value(cleared).shape.faceDraft).toBeUndefined();
    expect(value(cleared).shape.cadBrep).not.toBe(value(changed).shape.cadBrep);
    expect(writeCount()).toBe(beforeClear + 1);
  }, CAD_TEST_TIMEOUT_MS);

  it("rolls back a face-draft source edit when its selected planar face has no unique match", async () => {
    const { store, writeCount, document } = projectStore();
    const engine = createEngine(store);
    const original = await sketchExtrusionShapeFromRequest({
      id: "unmatched-draft", sketchSourceId: "sketch/unmatched-draft", name: "Unmatched draft",
      profile: extrusionProfile(), height: 3,
    });
    document.shapes = [original];
    const selected = (await shapeFaces(original)).find((face) => face.normal && face.normal.x > 0.99)!;
    const created = await engine.changeShape("recompute", original.id, {
      faceDraft: { sourceFaceId: selected.id, angle: 5, pullDirection: "z" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const beforeEdit = value(await engine.project("recompute"));
    const writesBeforeEdit = writeCount();
    const shearedProfile = {
      ...extrusionProfile(),
      points: extrusionProfile().points.map((point) => ({ ...point, x: point.x + point.z * 0.25 })),
    };

    const changed = await engine.changeShape("recompute", "sketch/unmatched-draft", { sketchProfile: shearedProfile });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeEdit);
    expect(value(await engine.project("recompute")).shapes).toEqual(beforeEdit.shapes);
  }, CAD_TEST_TIMEOUT_MS);

  it("rolls back when the kernel cannot draft the selected face along a parallel axis", async () => {
    const { store, writeCount, document } = projectStore();
    const engine = createEngine(store);
    const original = await sketchExtrusionShapeFromRequest({
      id: "parallel-draft", sketchSourceId: "sketch/parallel-draft", name: "Parallel draft",
      profile: extrusionProfile(), height: 3,
    });
    document.shapes = [original];
    const selected = (await shapeFaces(original)).find((face) => face.normal && face.normal.x > 0.99)!;
    const writesBefore = writeCount();

    const result = await engine.changeShape("recompute", original.id, {
      faceDraft: { sourceFaceId: selected.id, angle: 5, pullDirection: "x" },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBefore);
    expect((await store.read("recompute"))?.shapes).toEqual([original]);
  }, CAD_TEST_TIMEOUT_MS);

  it("requires clearing a face draft before selecting a different source face", async () => {
    const { store, writeCount, document } = projectStore();
    const engine = createEngine(store);
    const original = await sketchExtrusionShapeFromRequest({
      id: "reselect-draft", sketchSourceId: "sketch/reselect-draft", name: "Reselect draft",
      profile: extrusionProfile(), height: 3,
    });
    const sourceFaces = await shapeFaces(original);
    original.faceIds = sourceFaces.map((_, index) => `surface-${index}`);
    document.shapes = [original];
    const selected = (await shapeFaces(original)).find((face) => face.normal && face.normal.x > 0.99)!;
    const other = (await shapeFaces(original)).find((face) => face.id !== selected.id && face.surfaceType === "plane")!;
    const created = await engine.changeShape("recompute", original.id, {
      faceDraft: { sourceFaceId: selected.id, angle: 5, pullDirection: "z" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const roundTripped = await importSkfProject(await exportSkfProject({
      ...(await store.read("recompute"))!, modifiedAt: 1,
    }));
    expect(roundTripped.shapes[0]?.faceDraft?.sourceFaceId).toBe(selected.id);
    const beforeReselect = value(await engine.project("recompute"));
    const writesBeforeReselect = writeCount();

    const changed = await engine.changeShape("recompute", original.id, {
      faceDraft: { sourceFaceId: other.id, angle: 5, pullDirection: "z" },
    });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure.reason).toBe("invalid_shape_request");
    expect(writeCount()).toBe(writesBeforeReselect);
    expect(value(await engine.project("recompute")).shapes).toEqual(beforeReselect.shapes);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a face draft when multiple rebuilt faces share its planar normal", async () => {
    const { store, writeCount, document } = projectStore();
    const engine = createEngine(store);
    const first = extrusionProfile(1, -5);
    const second = extrusionProfile(1, 5);
    const profile = {
      points: [...first.points.map((point) => ({ ...point, id: `a-${point.id}` })),
        ...second.points.map((point) => ({ ...point, id: `b-${point.id}` }))],
      segments: [...first.segments.map((segment) => ({ ...segment, id: `a-${segment.id}`, startId: `a-${segment.startId}`, endId: `a-${segment.endId}` })),
        ...second.segments.map((segment) => ({ ...segment, id: `b-${segment.id}`, startId: `b-${segment.startId}`, endId: `b-${segment.endId}` }))],
    };
    const original = await sketchExtrusionShapeFromRequest({
      id: "ambiguous-draft", sketchSourceId: "sketch/ambiguous-draft", name: "Ambiguous draft", profile, height: 3,
    });
    document.shapes = [original];
    const selected = (await shapeFaces(original)).find((face) => face.normal && face.normal.x > 0.99)!;
    const writesBefore = writeCount();

    const result = await engine.changeShape("recompute", original.id, {
      faceDraft: { sourceFaceId: selected.id, angle: 5, pullDirection: "z" },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBefore);
    expect((await store.read("recompute"))?.shapes).toEqual([original]);
  }, CAD_TEST_TIMEOUT_MS);

  it("requires complete unique face IDs when applying a draft to exact geometry", async () => {
    const original = await sketchExtrusionShapeFromRequest({
      id: "incomplete-face-ids", name: "Incomplete IDs", profile: extrusionProfile(), height: 3,
    });
    const sourceFaceId = original.faceIds![0]!;

    await expect(applySketchFaceDraft({ ...original, faceIds: original.faceIds!.slice(1) }, {
      sourceFaceId, angle: 5, pullDirection: "y",
    })).rejects.toThrow("complete, unique stable face ID list");
    await expect(applySketchFaceDraft({ ...original, faceIds: original.faceIds!.map(() => sourceFaceId) }, {
      sourceFaceId, angle: 5, pullDirection: "y",
    })).rejects.toThrow("complete, unique stable face ID list");
  }, CAD_TEST_TIMEOUT_MS);

  it("rolls back a drafted sketch edit when a retained boolean ancestor stops removing material", async () => {
    const { store, writeCount, document } = projectStore();
    const engine = createEngine(store);
    const hole = await sketchExtrusionShapeFromRequest({
      id: "drafted-hole", sketchSourceId: "sketch/drafted-hole", name: "Drafted hole",
      profile: extrusionProfile(0.5), height: 3, hole: true,
    });
    const target = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Target", width: 10, depth: 10, height: 3 },
    ])).shapes[0]!;
    document.shapes.push(hole);
    const cut = value(await engine.cut("recompute", { solidIds: [target.id], holeIds: [hole.id] })).shape;
    const groupedHole = cut.groupedShapes!.find((shape) => shape.sketchSourceId === hole.sketchSourceId)!;
    const selected = (await shapeFaces(groupedHole)).find((face) => face.normal && face.normal.x > 0.99)!;
    const created = await engine.changeShape("recompute", hole.sketchSourceId!, {
      faceDraft: { sourceFaceId: selected.id, angle: 5, pullDirection: "z" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const beforeEdit = value(await engine.project("recompute"));
    const writesBeforeEdit = writeCount();
    const movedProfile = {
      ...extrusionProfile(0.5),
      points: extrusionProfile(0.5).points.map((point) => ({ ...point, x: point.x + 20 })),
    };

    const changed = await engine.changeShape("recompute", hole.sketchSourceId!, { sketchProfile: movedProfile });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeEdit);
    expect(value(await engine.project("recompute")).shapes).toEqual(beforeEdit.shapes);
    expect(beforeEdit.shapes[0]?.id).toBe(cut.id);
  }, CAD_TEST_TIMEOUT_MS);

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

  it("replays an all-edge fillet after editing a retained sketch sweep", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{ kind: "sketchSweep", name: "Treated sweep", profile: profile() }]));
    const source = await persistAllEdgeFillet(engine, store, "recompute", created.shapes[0]!.id);
    const writesBeforeEdit = writeCount();
    const changedProfile = profile(1.5);

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated).toMatchObject({
      id: source.id, sketchSourceId: source.sketchSourceId, sketchProfile: changedProfile,
      rotation: source.rotation, rotationX: source.rotationX, rotationZ: source.rotationZ,
    });
    expect(updated.x).toBeCloseTo(source.x);
    expect(updated.z).toBeCloseTo(source.z);
    expect(updated.elevation).toBeCloseTo(source.elevation ?? 0);
    expect(updated.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(updated.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(writeCount()).toBe(writesBeforeEdit + 1);

    const beforeInvalidReplay = value(await engine.project("recompute"));
    const writesBeforeInvalidReplay = writeCount();
    const invalidReplay = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: profile(0.01) });
    expect(invalidReplay.ok).toBe(false);
    expect(invalidReplay.ok ? undefined : invalidReplay.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeInvalidReplay);
    expect(value(await engine.project("recompute")).shapes).toEqual(beforeInvalidReplay.shapes);
  });

  it("replays one symmetric all-edge chamfer after editing a retained sketch sweep", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{ kind: "sketchSweep", name: "Chamfered sweep", profile: profile() }]));
    const source = await persistAllEdgeChamfer(engine, store, "recompute", created.shapes[0]!.id);
    const writesBeforeEdit = writeCount();
    const changedProfile = profile(1.5);

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated.edgeTreatments?.[0]).toMatchObject({ kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true });
    expect(updated.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(updated.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(updated.edgeTreatments?.[0]?.edgeCount);
    expect(updated.cadBrep).not.toBe(updated.edgeTreatmentHistory?.[0]?.before.cadBrep);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
  });

  it("replays an all-edge fillet after editing a retained sketch revolve", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Treated revolve", profile: [[1, -2], [2, -2], [2, 2], [1, 2]], sides: 8,
    }]));
    const source = await persistAllEdgeFillet(engine, store, "recompute", created.shapes[0]!.id, 0.01);
    const writesBeforeEdit = writeCount();
    const changedProfile = {
      ...source.sketchProfile!,
      points: source.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.25 })),
    };

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated).toMatchObject({
      id: source.id, sketchSourceId: source.sketchSourceId, sketchProfile: changedProfile,
      rotation: source.rotation, rotationX: source.rotationX, rotationZ: source.rotationZ,
    });
    expect(updated.x).toBeCloseTo(source.x);
    expect(updated.z).toBeCloseTo(source.z);
    expect(updated.elevation).toBeCloseTo(source.elevation ?? 0);
    expect(updated.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.01, allEdges: true });
    expect(updated.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
  }, CAD_TEST_TIMEOUT_MS);

  it("replays one symmetric all-edge chamfer after editing a retained sketch revolve", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Chamfered revolve", profile: [[5, -5], [10, -5], [10, 5], [5, 5]], sides: 24,
    }]));
    const source = await persistAllEdgeChamfer(engine, store, "recompute", created.shapes[0]!.id, 0.1);
    const writesBeforeEdit = writeCount();
    const changedProfile = {
      ...source.sketchProfile!,
      points: source.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.25 })),
    };

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated.edgeTreatments?.[0]).toMatchObject({ kind: "chamfer", amount: 0.1, chamferAngle: 45, allEdges: true });
    expect(updated.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(updated.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(updated.edgeTreatments?.[0]?.edgeCount);
    expect(updated.cadBrep).toBeTruthy();
    expect(updated.cadBrep).not.toBe(updated.edgeTreatmentHistory?.[0]?.before.cadBrep);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
  }, CAD_TEST_TIMEOUT_MS);

  it("rolls back an all-edge chamfer replay when a revolve edit changes it to a partial turn", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Chamfered revolve", profile: [[5, -5], [10, -5], [10, 5], [5, 5]], sides: 24,
    }]));
    const source = await persistAllEdgeChamfer(engine, store, "recompute", created.shapes[0]!.id, 0.1);
    const beforeEdit = value(await engine.project("recompute")).shapes;
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, {
      sketchProfile: {
        ...source.sketchProfile!,
        points: source.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.1 })),
      },
      sweepAngle: 180,
    });

    expect(changed.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeEdit);
    expect(value(await engine.project("recompute")).shapes).toEqual(beforeEdit);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses an all-edge chamfer replay for a multi-region sketch revolve", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Chamfered revolve", profile: [[5, -5], [10, -5], [10, 5], [5, 5]], sides: 24,
    }]));
    const source = await persistAllEdgeChamfer(engine, store, "recompute", created.shapes[0]!.id, 0.1);
    const beforeEdit = value(await engine.project("recompute")).shapes;
    const writesBeforeEdit = writeCount();
    const addedPoints = [
      { id: "extra-a", x: -15, z: -5 }, { id: "extra-b", x: -12, z: -5 },
      { id: "extra-c", x: -12, z: 5 }, { id: "extra-d", x: -15, z: 5 },
    ];
    const addedSegments = [
      { id: "extra-ab", startId: "extra-a", endId: "extra-b" },
      { id: "extra-bc", startId: "extra-b", endId: "extra-c" },
      { id: "extra-cd", startId: "extra-c", endId: "extra-d" },
      { id: "extra-da", startId: "extra-d", endId: "extra-a" },
    ];

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, {
      sketchProfile: {
        ...source.sketchProfile!,
        points: [...source.sketchProfile!.points, ...addedPoints],
        segments: [...source.sketchProfile!.segments, ...addedSegments],
      },
    });

    expect(changed.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeEdit);
    expect(value(await engine.project("recompute")).shapes).toEqual(beforeEdit);
  }, CAD_TEST_TIMEOUT_MS);

  it("rolls back a revolve setting edit when its all-edge fillet cannot be replayed", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{
      kind: "revolve", name: "Treated revolve", profile: [[1, -2], [2, -2], [2, 2], [1, 2]], sides: 8,
    }]));
    const source = await persistAllEdgeFillet(engine, store, "recompute", created.shapes[0]!.id, 0.01);
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sides: 10 });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeEdit);
    expect((await store.read("recompute"))!.shapes[0]).toEqual(source);
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

  it("replays a retained all-edge fillet after editing a sketch extrusion source", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Source extrusion", width: 2, depth: 2, height: 3 },
    ])).shapes[0]!;
    const document = await store.read("recompute");
    const sourceProfile = extrusionProfile();
    const source: WorkplaneShape = {
      ...document!.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: sourceProfile,
      sketchSourceId: "sketch/treated-extrusion",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    };
    document!.shapes[0] = source;
    const treated = value(await engine.treat("recompute", created.id, { kind: "fillet", amount: 0.2 })).shape;
    const feature = { kind: "fillet" as const, amount: 0.2, edgeCount: 12, allEdges: true as const };
    document!.shapes[0] = {
      ...treated,
      edgeTreatments: [feature],
      edgeTreatmentHistory: [{ id: "all-edge-fillet", createdAt: 1, feature, before: source }],
    };
    const writesBeforeEdit = writeCount();
    const changedProfile = extrusionProfile(2);
    const rawRebuild = await sketchExtrusionShapeFromRequest({
      id: source.id,
      sketchSourceId: source.sketchSourceId!,
      name: source.name,
      color: source.color,
      profile: changedProfile,
      height: source.height,
      x: source.x,
      z: source.z,
      elevation: source.elevation,
    });

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated.edgeTreatments).toEqual([feature]);
    expect(updated.edgeTreatmentHistory).toHaveLength(1);
    expect(updated.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(updated.cadBrep).not.toBe(rawRebuild.cadBrep);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
  });

  it("replays one retained symmetric all-edge chamfer after editing a sketch extrusion source", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Chamfered extrusion", width: 2, depth: 2, height: 3 },
    ])).shapes[0]!;
    const document = await store.read("recompute");
    const source: WorkplaneShape = {
      ...document!.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: extrusionProfile(),
      sketchSourceId: "sketch/chamfered-extrusion",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    };
    document!.shapes[0] = source;
    const treated = value(await engine.treat("recompute", created.id, { kind: "chamfer", amount: 0.2 })).shape;
    const feature = { kind: "chamfer" as const, amount: 0.2, chamferAngle: 45, edgeCount: 12, allEdges: true as const };
    document!.shapes[0] = {
      ...treated,
      edgeTreatments: [feature],
      edgeTreatmentHistory: [{ id: "all-edge-chamfer", createdAt: 1, feature, before: source }],
    };
    const writesBeforeEdit = writeCount();
    const changedProfile = extrusionProfile(2);
    const rawRebuild = await sketchExtrusionShapeFromRequest({
      id: source.id,
      sketchSourceId: source.sketchSourceId!,
      name: source.name,
      color: source.color,
      profile: changedProfile,
      height: source.height,
      x: source.x,
      z: source.z,
      elevation: source.elevation,
    });

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated.edgeTreatments).toEqual([feature]);
    expect(updated.edgeTreatmentHistory).toHaveLength(1);
    expect(updated.edgeTreatmentHistory?.[0]?.before.sketchProfile).toEqual(changedProfile);
    expect(updated.edgeTreatmentHistory?.[0]?.feature.allEdges).toBe(true);
    expect(updated.cadBrep).not.toBe(rawRebuild.cadBrep);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
  });

  it("does not persist a source edit when an all-edge chamfer cannot be replayed", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [{ kind: "box", name: "Chamfered extrusion", width: 2, depth: 2, height: 3 }])).shapes[0]!;
    const document = await store.read("recompute");
    const source: WorkplaneShape = {
      ...document!.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: extrusionProfile(),
      sketchSourceId: "sketch/rollback-chamfered-extrusion",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    };
    document!.shapes[0] = source;
    const treated = value(await engine.treat("recompute", created.id, { kind: "chamfer", amount: 0.2 })).shape;
    const feature = { kind: "chamfer" as const, amount: 0.2, chamferAngle: 45, edgeCount: 12, allEdges: true as const };
    const persisted = {
      ...treated,
      edgeTreatments: [feature],
      edgeTreatmentHistory: [{ id: "all-edge-chamfer", createdAt: 1, feature, before: source }],
    };
    document!.shapes[0] = persisted;
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: extrusionProfile(0.05) });

    expect(changed.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeEdit);
    expect((await store.read("recompute"))!.shapes[0]).toEqual(persisted);
  });

  it.each(["selected-edge", "multiple", "non-45"] as const)(
    "refuses %s chamfer history when replaying an edited sketch extrusion",
    async (unsupported) => {
      const { store, writeCount } = projectStore();
      const engine = createEngine(store);
      const created = value(await engine.addShapes("recompute", [{ kind: "box", name: "Treated extrusion", width: 2, depth: 2, height: 3 }])).shapes[0]!;
      const document = await store.read("recompute");
      const source: WorkplaneShape = {
        ...document!.shapes[0]!,
        sketchOperation: "extrude",
        sketchProfile: extrusionProfile(),
        sketchSourceId: `sketch/unsupported-${unsupported}`,
        cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
      };
      const validFeature = { kind: "chamfer" as const, amount: 0.1, chamferAngle: 45, edgeCount: 12, allEdges: true as const };
      const unsupportedFeature = unsupported === "non-45"
        ? { ...validFeature, chamferAngle: 30 }
        : unsupported === "selected-edge"
          ? { kind: "chamfer" as const, amount: 0.1, chamferAngle: 45, edgeCount: 1 }
          : { ...validFeature, amount: 0.2 };
      const features = unsupported === "multiple" ? [validFeature, unsupportedFeature] : [unsupportedFeature];
      const histories = features.map((feature, index) => ({
        id: `unsupported-${unsupported}-${index}`,
        createdAt: index + 1,
        feature,
        before: source,
      }));
      const persisted: WorkplaneShape = { ...source, edgeTreatments: features, edgeTreatmentHistory: histories };
      document!.shapes[0] = persisted;
      const writesBeforeEdit = writeCount();

      const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: extrusionProfile(2) });

      expect(changed.ok).toBe(false);
      expect(writeCount()).toBe(writesBeforeEdit);
      expect((await store.read("recompute"))!.shapes[0]).toEqual(persisted);
    },
  );

  it("does not persist a source edit when the all-edge fillet cannot be replayed", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Treated extrusion", width: 2, depth: 2, height: 3 },
    ]));
    const document = await store.read("recompute");
    const sourceProfile = extrusionProfile();
    const source: WorkplaneShape = {
      ...document!.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: sourceProfile,
      sketchSourceId: "sketch/rollback-treated-extrusion",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    };
    document!.shapes[0] = source;
    const treated = value(await engine.treat("recompute", created.shapes[0]!.id, { kind: "fillet", amount: 0.2 })).shape;
    const feature = { kind: "fillet" as const, amount: 0.2, edgeCount: 12, allEdges: true as const };
    const persisted: WorkplaneShape = {
      ...treated,
      edgeTreatments: [feature],
      edgeTreatmentHistory: [{ id: "all-edge-fillet", createdAt: 1, feature, before: source }],
    };
    document!.shapes[0] = persisted;
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("recompute", source.sketchSourceId!, { sketchProfile: extrusionProfile(0.1) });

    expect(changed.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeEdit);
    expect((await store.read("recompute"))!.shapes[0]).toEqual(persisted);
  });

  it("rejects an all-edge fillet source edit when a draft prism makes replay order ambiguous", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Drafted treated extrusion", width: 2, depth: 2, height: 3 },
    ]));
    const document = await store.read("recompute");
    const sourceProfile = extrusionProfile();
    const feature = { kind: "fillet" as const, amount: 0.2, edgeCount: 12, allEdges: true as const };
    const persisted: WorkplaneShape = {
      ...document!.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: sourceProfile,
      sketchSourceId: "sketch/draft-and-fillet",
      draftPrismAngle: 5,
      edgeTreatments: [feature],
      edgeTreatmentHistory: [{
        id: "all-edge-fillet",
        createdAt: 1,
        feature,
        before: document!.shapes[0]!,
      }],
    };
    document!.shapes[0] = persisted;
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("recompute", persisted.sketchSourceId!, { sketchProfile: extrusionProfile(2) });
    const changedDraftAngle = await engine.changeShape("recompute", persisted.sketchSourceId!, { draftPrismAngle: 8 });

    expect(changed.ok).toBe(false);
    expect(changedDraftAngle.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeEdit);
    expect((await store.read("recompute"))!.shapes[0]).toEqual(persisted);
  });

  it("edits a persisted draft-prism angle by sketch source ID and keeps the draft during source recompute", async () => {
    const { store, writeCount } = projectStore();
    const engine = createEngine(store);
    const created = value(await engine.addShapes("recompute", [
      { kind: "box", name: "Drafted extrusion", width: 2, depth: 2, height: 3, x: 12, z: -4, elevation: 7 },
      { kind: "box", name: "Cutter", width: 0.5, depth: 0.5, height: 1, x: 12, z: -4, elevation: 8, hole: true },
    ]));
    const original = created.shapes[0]!;
    const document = await store.read("recompute");
    document!.shapes[0] = {
      ...document!.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: extrusionProfile(),
      sketchSourceId: "sketch/source-draft-prism",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    };
    value(await engine.draftPrism("recompute", original.id, 5));
    const cut = value(await engine.cut("recompute", { solidIds: [original.id], holeIds: [created.shapes[1]!.id] })).shape;
    const sourceChild = cut.groupedShapes!.find((shape) => shape.sketchSourceId === "sketch/source-draft-prism")!;
    const cutBeforeAngleEdit = cut.cadBrep;
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("recompute", "sketch/source-draft-prism", { draftPrismAngle: 12 });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const updated = value(changed).shape;
    expect(updated).toMatchObject({
      id: sourceChild.id,
      sketchSourceId: "sketch/source-draft-prism",
      sketchOperation: "extrude",
      draftPrismAngle: 12,
      x: sourceChild.x,
      z: sourceChild.z,
      elevation: sourceChild.elevation,
    });
    expect(writeCount()).toBe(writesBeforeEdit + 1);
    const afterAngleEdit = value(await engine.project("recompute")).shapes.find((shape) => shape.id === cut.id)!;
    expect(afterAngleEdit.cadBrep).not.toBe(cutBeforeAngleEdit);
    expect(afterAngleEdit.groupedShapes?.find((shape) => shape.id === sourceChild.id)?.draftPrismAngle).toBe(12);
    const cutBeforeProfileEdit = afterAngleEdit.cadBrep;

    const editedProfile = extrusionProfile(2);
    const writesBeforeProfileEdit = writeCount();
    const profileChanged = await engine.changeShape("recompute", "sketch/source-draft-prism", { sketchProfile: editedProfile });
    expect(profileChanged.ok, JSON.stringify(profileChanged)).toBe(true);
    expect(value(profileChanged).shape).toMatchObject({
      id: sourceChild.id,
      sketchSourceId: "sketch/source-draft-prism",
      sketchProfile: editedProfile,
      draftPrismAngle: 12,
      x: sourceChild.x,
      z: sourceChild.z,
      elevation: sourceChild.elevation,
    });
    expect(writeCount()).toBe(writesBeforeProfileEdit + 1);
    const afterProfileEdit = value(await engine.project("recompute")).shapes.find((shape) => shape.id === cut.id)!;
    expect(afterProfileEdit.cadBrep).not.toBe(cutBeforeProfileEdit);
    expect(afterProfileEdit.groupedShapes?.find((shape) => shape.id === sourceChild.id)).toMatchObject({
      draftPrismAngle: 12,
      draftPrismSourceHeight: 3,
      draftPrismSourceFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    });

    const bytes = await exportSkfProject({
      projectId: "recompute",
      projectName: "Parametric recompute",
      createdAt: 1,
      modifiedAt: 1,
      shapes: [afterProfileEdit],
      history: [],
      historyIndex: -1,
      assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE,
      snapGrid: DEFAULT_SNAP_GRID,
      placementElevation: 0,
    });
    const restored = await importSkfProject(bytes);
    const restoredSource = restored.shapes[0]?.groupedShapes?.find((shape) => shape.id === sourceChild.id);
    expect(restoredSource).toMatchObject({
      draftPrismAngle: 12,
      draftPrismSourceHeight: 3,
      draftPrismSourceFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    });

    const restoredDatabase = projectStore();
    const restoredDocument = await restoredDatabase.store.read("recompute");
    await restoredDatabase.store.write("recompute", restoredDocument!, restored.shapes);
    const restoredEngine = createEngine(restoredDatabase.store);
    const restoredEdit = await restoredEngine.changeShape("recompute", "sketch/source-draft-prism", {
      sketchProfile: extrusionProfile(3),
    });
    expect(restoredEdit.ok, JSON.stringify(restoredEdit)).toBe(true);
    expect(value(restoredEdit).shape).toMatchObject({
      id: sourceChild.id,
      sketchProfile: extrusionProfile(3),
      draftPrismAngle: 12,
      draftPrismSourceHeight: 3,
      draftPrismSourceFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    });

    const beforeIneffectiveRebuild = value(await engine.project("recompute"));
    const writesBeforeIneffectiveRebuild = writeCount();
    const ineffective = await engine.changeShape("recompute", "sketch/source-draft-prism", {
      sketchProfile: extrusionProfile(1, 100),
    });
    expect(ineffective.ok).toBe(false);
    expect(writeCount()).toBe(writesBeforeIneffectiveRebuild);
    expect(value(await engine.project("recompute"))).toEqual(beforeIneffectiveRebuild);

    const beforeInvalidEdit = value(await engine.project("recompute"));
    const writesBeforeInvalidEdit = writeCount();
    const invalid = await engine.changeShape("recompute", "sketch/source-draft-prism", { draftPrismAngle: 45 });
    expect(invalid.ok).toBe(false);
    expect(invalid.ok ? undefined : invalid.failure.reason).toBe("invalid_shape_request");
    expect(writeCount()).toBe(writesBeforeInvalidEdit);
    expect(value(await engine.project("recompute"))).toEqual(beforeInvalidEdit);
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
