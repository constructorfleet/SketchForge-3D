import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { uniqueSketchSegmentForSideBoundary } from "@constructorfleet/sketchforge-engine/faceDraftSegmentLineage";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Face draft segment lineage", createdAt: 1,
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

const rectangle = {
  points: [
    { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
    { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
  ],
  segments: [
    { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
    { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
  ],
};

async function originalExtrusion(projectName = "Segment lineage", profile = rectangle) {
  const { store, document, writeCount } = projectStore();
  document.projectName = projectName;
  const shape = await sketchExtrusionShapeFromRequest({
    id: "segment-lineage-extrusion", sketchSourceId: "sketch/segment-lineage-extrusion",
    name: "Segment lineage extrusion", profile, height: 3, x: 0, z: 0, elevation: 0, rotation: 0,
  });
  document.shapes = [shape];
  return { store, document, writeCount, shape };
}

describe("persisted face-draft segment lineage", () => {
  it("marks a merged lateral boundary ambiguous when it matches two collinear segments", () => {
    const segments = [
      { id: "first", start: { x: 1, z: -1 }, end: { x: 1, z: 0 } },
      { id: "second", start: { x: 1, z: 0 }, end: { x: 1, z: 1 } },
    ];
    const edge = (first: { x: number; y: number; z: number }, second: { x: number; y: number; z: number }) => ({
      curveType: "line", vertices: [first, second],
    });
    const boundary = [
      edge({ x: 1, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }),
      edge({ x: 1, y: 3, z: -1 }, { x: 1, y: 3, z: 0 }),
      edge({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }),
      edge({ x: 1, y: 3, z: 0 }, { x: 1, y: 3, z: 1 }),
      edge({ x: 1, y: 0, z: -1 }, { x: 1, y: 3, z: -1 }),
      edge({ x: 1, y: 0, z: 0 }, { x: 1, y: 3, z: 0 }),
      edge({ x: 1, y: 0, z: 1 }, { x: 1, y: 3, z: 1 }),
    ];
    expect(uniqueSketchSegmentForSideBoundary(boundary, segments, 3)).toEqual({ status: "ambiguous" });
  });

  it("replays a drafted extrusion side by sketch segment after its normal changes and a .skf round trip", async () => {
    const { store, document, writeCount, shape } = await originalExtrusion();
    const engine = createEngine(store);
    const sourceFaces = await shapeFaces(shape);
    const selectedFace = sourceFaces.find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.99)!;
    const selectedDraft = { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" as const };
    const drafted = value(await engine.changeShape("recompute", shape.id, { faceDraft: selectedDraft })).shape;
    expect(drafted.faceDraft).toMatchObject({ sourceFaceId: selectedFace.id });
    expect((drafted as WorkplaneShape & { faceDraftSourceSegmentId?: string }).faceDraftSourceSegmentId).toBe("bc");

    const archived = await exportSkfProject({ ...document, modifiedAt: 2 });
    const restored = await importSkfProject(archived);
    expect(restored.shapes[0]?.faceDraft).toMatchObject({ sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" });
    expect((restored.shapes[0] as WorkplaneShape & { faceDraftSourceSegmentId?: string }).faceDraftSourceSegmentId).toBe("bc");
    expect(restored.shapes[0]?.cadBrep).toBeDefined();
    const archiveFiles = unzipSync(archived);
    const project = JSON.parse(strFromU8(archiveFiles["project.json"]!)) as {
      states: Array<{ nodes: Array<{ definition: Record<string, unknown> }> }>;
    };
    for (const state of project.states) {
      for (const node of state.nodes) delete node.definition.faceDraftSourceSegmentId;
    }
    archiveFiles["project.json"] = strToU8(JSON.stringify(project));
    const legacyArchive = zipSync(archiveFiles);
    const legacy = await importSkfProject(legacyArchive);
    expect(legacy.shapes[0]?.faceDraftSourceSegmentId).toBeUndefined();
    expect(legacy.shapes[0]?.faceDraftSourceFaceIds).toHaveLength(6);
    document.shapes = legacy.shapes;

    const changedProfile = {
      ...rectangle,
      points: rectangle.points.map((point) => point.id === "c" ? { ...point, x: 1.5 } : { ...point }),
    };
    const changed = await engine.changeShape("recompute", shape.sketchSourceId!, { sketchProfile: changedProfile });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const replayed = value(changed).shape;
    expect(replayed.faceDraft).toMatchObject({ angle: 5, pullDirection: "y" });
    expect((replayed as WorkplaneShape & { faceDraftSourceSegmentId?: string }).faceDraftSourceSegmentId).toBe("bc");
    expect(writeCount()).toBe(2);

    const { store: referenceStore, shape: referenceSource } = await originalExtrusion("Fresh segment reference", changedProfile);
    const referenceEngine = createEngine(referenceStore);
    const segmentDx = 0.5;
    const segmentDz = 2;
    const segmentLength = Math.hypot(segmentDx, segmentDz);
    const expectedNormal = { x: segmentDz / segmentLength, z: -segmentDx / segmentLength };
    const referenceFace = (await shapeFaces(referenceSource)).find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(Math.abs(face.normal.x * expectedNormal.x + face.normal.z * expectedNormal.z) - 1) < 1e-6)!;
    expect(referenceFace).toBeDefined();
    expect(Math.abs(referenceFace.normal!.x)).toBeLessThan(0.99);
    const reference = value(await referenceEngine.changeShape("recompute", referenceSource.id, {
      faceDraft: { sourceFaceId: referenceFace.id, angle: 5, pullDirection: "y" },
    })).shape;
    const actualProperties = await shapeProperties(replayed);
    const expectedProperties = await shapeProperties(reference);
    expect(actualProperties.volume).toBeCloseTo(expectedProperties.volume, 6);
    expect(actualProperties.centerOfMass.y).toBeCloseTo(expectedProperties.centerOfMass.y, 6);
    expect(actualProperties.centerOfMass.z).toBeCloseTo(expectedProperties.centerOfMass.z, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("rolls back when the selected sketch segment is removed", async () => {
    const { store, document, writeCount, shape } = await originalExtrusion("Removed segment");
    const engine = createEngine(store);
    const sourceFaces = await shapeFaces(shape);
    const selectedFace = sourceFaces.find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.99)!;
    const drafted = value(await engine.changeShape("recompute", shape.id, {
      faceDraft: { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" },
    })).shape;
    expect((drafted as WorkplaneShape & { faceDraftSourceSegmentId?: string }).faceDraftSourceSegmentId).toBe("bc");

    const before = value(await engine.project("recompute"));
    const writesBefore = writeCount();
    const splitProfile = {
      points: [
        { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
        { id: "middle", x: 1, z: 0 }, { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "b-middle", startId: "b", endId: "middle" },
        { id: "middle-c", startId: "middle", endId: "c" }, { id: "cd", startId: "c", endId: "d" },
        { id: "da", startId: "d", endId: "a" },
      ],
    };
    const result = await engine.changeShape("recompute", shape.sketchSourceId!, { sketchProfile: splitProfile });
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBefore);
    expect(value(await engine.project("recompute"))).toEqual(before);
    expect(document.shapes[0]?.faceDraftSourceSegmentId).toBe("bc");
  }, CAD_TEST_TIMEOUT_MS);

  it("fails closed if a tracked profile becomes curved and preserves the project", async () => {
    const { store, document, writeCount, shape } = await originalExtrusion("Unsupported tracked profile");
    const engine = createEngine(store);
    const selectedFace = (await shapeFaces(shape)).find((face) => face.surfaceType === "plane" && face.normal
      && face.normal.x > 0.99)!;
    const drafted = value(await engine.changeShape("recompute", shape.id, {
      faceDraft: { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" },
    })).shape;
    expect(drafted.faceDraftSourceSegmentId).toBe("bc");

    const before = value(await engine.project("recompute"));
    const writesBefore = writeCount();
    const curvedProfile = {
      ...rectangle,
      points: rectangle.points.map((point) => point.id === "b"
        ? { ...point, handleOut: { x: 1.5, z: -0.5 } }
        : point.id === "c" ? { ...point, handleIn: { x: 1.5, z: 0.5 } } : { ...point }),
    };
    const result = await engine.changeShape("recompute", shape.sketchSourceId!, { sketchProfile: curvedProfile });
    expect(result.ok).toBe(false);
    expect(writeCount()).toBe(writesBefore);
    expect(value(await engine.project("recompute"))).toEqual(before);
    expect(document.shapes[0]?.faceDraftSourceSegmentId).toBe("bc");
  }, CAD_TEST_TIMEOUT_MS);

  it("tracks a selected side among collinear same-normal sketch segments", async () => {
    const splitRectangle = {
      points: [
        { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
        { id: "middle", x: 1, z: 0 }, { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "b-middle", startId: "b", endId: "middle" },
        { id: "middle-c", startId: "middle", endId: "c" }, { id: "cd", startId: "c", endId: "d" },
        { id: "da", startId: "d", endId: "a" },
      ],
    };
    const { store, document, writeCount, shape } = await originalExtrusion("Collinear segments", splitRectangle);
    const engine = createEngine(store);
    const selectedFace = (await shapeFaces(shape)).find((face) => face.surfaceType === "plane" && face.normal
      && face.normal.x > 0.99)!;
    const drafted = value(await engine.changeShape("recompute", shape.id, {
      faceDraft: { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" },
    })).shape;
    expect(["b-middle", "middle-c"]).toContain(drafted.faceDraftSourceSegmentId);
    expect(writeCount()).toBe(1);

    const segmentId = drafted.faceDraftSourceSegmentId!;
    const movedMiddle = {
      ...splitRectangle,
      points: splitRectangle.points.map((point) => point.id === "middle" ? { ...point, x: 1.2 } : { ...point }),
    };
    const changed = await engine.changeShape("recompute", shape.sketchSourceId!, { sketchProfile: movedMiddle });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const replayed = value(changed).shape;
    expect(replayed.sketchProfile).toEqual(movedMiddle);
    expect(replayed.faceDraftSourceSegmentId).toBe(segmentId);
    expect(Math.abs(replayed.faceDraft?.sourceFaceNormal.x ?? 0)).toBeLessThan(0.99);
    expect(writeCount()).toBe(2);
    expect(document.shapes[0]?.faceDraftSourceSegmentId).toBe(segmentId);
  }, CAD_TEST_TIMEOUT_MS);

  it("replays a treated extrusion draft by sketch segment after a profile edit", async () => {
    const { store, document, writeCount, shape } = await originalExtrusion("Treated segment lineage");
    const engine = createEngine(store);
    const sourceFaces = await shapeFaces(shape);
    const selectedFace = sourceFaces.find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.99)!;
    const drafted = value(await engine.changeShape("recompute", shape.id, {
      faceDraft: { sourceFaceId: selectedFace.id, angle: 5, pullDirection: "y" },
    })).shape;
    const treated = value(await engine.treat("recompute", drafted.id, { kind: "fillet", amount: 0.1 })).shape;
    const archived = await exportSkfProject({ ...document, modifiedAt: 3 });
    document.shapes = (await importSkfProject(archived)).shapes;
    const changedProfile = {
      ...rectangle,
      points: rectangle.points.map((point) => point.id === "c" ? { ...point, x: 1.5 } : { ...point }),
    };
    const result = await engine.changeShape("recompute", shape.sketchSourceId!, { sketchProfile: changedProfile });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const replayed = value(result).shape;
    expect(replayed.faceDraft).toMatchObject({ angle: 5, pullDirection: "y" });
    expect(replayed.faceDraftSourceSegmentId).toBe("bc");
    expect(replayed.edgeTreatments).toHaveLength(1);
    expect(replayed.edgeTreatments?.[0]).toMatchObject({ kind: "fillet", amount: 0.1, allEdges: true });
    expect(replayed.cadBrep).not.toBe(treated.cadBrep);
    // The edited rectangle's bounds center moves +0.25 in sketch X. This is an
    // independent world-placement expectation; deriving it from replay output
    // would let the same placement bug affect both sides of the assertion.
    const sourceCenterX = (Math.min(...rectangle.points.map((point) => point.x)) + Math.max(...rectangle.points.map((point) => point.x))) / 2;
    const editedCenterX = (Math.min(...changedProfile.points.map((point) => point.x)) + Math.max(...changedProfile.points.map((point) => point.x))) / 2;
    const expectedWorldX = shape.x + editedCenterX - sourceCenterX;
    expect(replayed.x).toBeCloseTo(expectedWorldX, 6);
    expect(writeCount()).toBe(3);

    const { store: referenceStore, shape: referenceSource } = await originalExtrusion("Treated reference", changedProfile);
    const referenceEngine = createEngine(referenceStore);
    const segmentDx = 0.5;
    const segmentDz = 2;
    const segmentLength = Math.hypot(segmentDx, segmentDz);
    const expectedNormal = { x: segmentDz / segmentLength, z: -segmentDx / segmentLength };
    const referenceFace = (await shapeFaces(referenceSource)).find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(Math.abs(face.normal.x * expectedNormal.x + face.normal.z * expectedNormal.z) - 1) < 1e-6)!;
    const referenceDraft = value(await referenceEngine.changeShape("recompute", referenceSource.id, {
      faceDraft: { sourceFaceId: referenceFace.id, angle: 5, pullDirection: "y" },
    })).shape;
    const reference = value(await referenceEngine.treat("recompute", referenceDraft.id, { kind: "fillet", amount: 0.1 })).shape;
    const actualProperties = await shapeProperties(replayed);
    const expectedProperties = await shapeProperties(reference);
    expect(actualProperties.volume).toBeCloseTo(expectedProperties.volume, 6);
    expect(actualProperties.centerOfMass.x).toBeCloseTo(expectedProperties.centerOfMass.x, 6);
    expect(actualProperties.centerOfMass.y).toBeCloseTo(expectedProperties.centerOfMass.y, 6);
    expect(actualProperties.centerOfMass.z).toBeCloseTo(expectedProperties.centerOfMass.z, 6);
  }, CAD_TEST_TIMEOUT_MS);
});
