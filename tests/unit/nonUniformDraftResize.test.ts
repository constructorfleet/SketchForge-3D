import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { applyDraftPrism, applySketchFaceDraft, shapeWithCadResult } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const profile = {
  points: [
    { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
    { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
  ],
  segments: [
    { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
    { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
  ],
};

async function extrusion(id: string, height: number): Promise<WorkplaneShape> {
  return sketchExtrusionShapeFromRequest({ id, profile, height, x: 0, z: 0, elevation: 0, rotation: 0 });
}

function projectStore() {
  let revision = 0;
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Non-uniform draft resize", createdAt: 1,
    shapes: [], history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  const store = {
    read: async (projectId: string) => projectId === "resize" ? document : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      document.shapes = shapes;
      revision += 1;
      document.metadata.revision = revision;
      return { revision };
    },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { store, document };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("drafts on non-uniformly resized sketch extrusions", () => {
  it("builds a prism draft at the drawn height instead of the source height", async () => {
    const natural = await extrusion("resized-prism", 3);
    const resized = { ...natural, height: 6 };
    const expectedSource = await extrusion("expected-prism", 6);
    const actual = shapeWithCadResult(resized, await applyDraftPrism(resized, { angle: -7 }));
    const expected = shapeWithCadResult(expectedSource, await applyDraftPrism(expectedSource, { angle: -7 }));

    const actualProperties = await shapeProperties({ ...actual, importedMesh: undefined });
    const expectedProperties = await shapeProperties({ ...expected, importedMesh: undefined });
    expect(actualProperties.volume).toBeCloseTo(expectedProperties.volume, 6);
    expect(actual.width).toBeCloseTo(expected.width, 6);
    expect(actual.depth).toBeCloseTo(expected.depth, 6);
    expect(actual.height).toBeCloseTo(expected.height, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("applies independent width and height resize before a prism draft", async () => {
    const natural = await extrusion("resize-prism-profile", 3);
    const resized = { ...natural, width: natural.width * 1.5, height: 6 };
    const resizedProfile = {
      ...profile,
      points: profile.points.map((point) => ({ ...point, x: point.x * 1.5 })),
    };
    const expectedSource = await sketchExtrusionShapeFromRequest({
      id: "expected-prism-profile", profile: resizedProfile, height: 6,
      x: 0, z: 0, elevation: 0, rotation: 0,
    });
    const actual = shapeWithCadResult(resized, await applyDraftPrism(resized, { angle: -7 }));
    const expected = shapeWithCadResult(expectedSource, await applyDraftPrism(expectedSource, { angle: -7 }));

    expect((await shapeProperties({ ...actual, importedMesh: undefined })).volume)
      .toBeCloseTo((await shapeProperties({ ...expected, importedMesh: undefined })).volume, 6);
    expect(actual.width).toBeCloseTo(expected.width, 6);
    expect(actual.height).toBeCloseTo(expected.height, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("builds a face draft from the drawn dimensions", async () => {
    const natural = await extrusion("resized-face", 3);
    const resized = { ...natural, height: 6 };
    const face = (await shapeFaces(natural)).find((candidate) => candidate.surfaceType === "plane"
      && candidate.normal && Math.abs(candidate.normal.x) > 0.99)!;
    const expectedSource = await extrusion("expected-face", 6);
    const expectedFace = (await shapeFaces(expectedSource)).find((candidate) => candidate.surfaceType === "plane"
      && candidate.normal && Math.abs(candidate.normal.x) > 0.99)!;
    const [actualResult, expectedResult] = await Promise.all([
      applySketchFaceDraft(resized, { sourceFaceId: face.id, angle: 5, pullDirection: "y" }),
      applySketchFaceDraft(expectedSource, { sourceFaceId: expectedFace.id, angle: 5, pullDirection: "y" }),
    ]);
    const actual = shapeWithCadResult(resized, actualResult);
    const expected = shapeWithCadResult(expectedSource, expectedResult);
    const actualProperties = await shapeProperties({ ...actual, importedMesh: undefined });
    const expectedProperties = await shapeProperties({ ...expected, importedMesh: undefined });
    expect(actualProperties.volume).toBeCloseTo(expectedProperties.volume, 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("replays the saved resize when a drafted profile is edited", async () => {
    const { store, document } = projectStore();
    const engine = createEngine(store);
    const natural = await extrusion("replayed-face", 3);
    const resized = { ...natural, height: 6 };
    document.shapes = [resized];
    const face = (await shapeFaces(resized)).find((candidate) => candidate.surfaceType === "plane"
      && candidate.normal && Math.abs(candidate.normal.x) > 0.99)!;
    value(await engine.changeShape("resize", resized.id, {
      faceDraft: { sourceFaceId: face.id, angle: 5, pullDirection: "y" },
    }));
    const editedProfile = {
      ...profile,
      points: profile.points.map((point) => ({ ...point, x: point.x * 1.1 })),
    };
    const replayed = value(await engine.changeShape("resize", resized.id, { sketchProfile: editedProfile })).shape;

    const expectedSource = await sketchExtrusionShapeFromRequest({
      id: "expected-replay", profile: editedProfile, height: 6, x: 0, z: 0, elevation: 0, rotation: 0,
    });
    const expectedFace = (await shapeFaces(expectedSource)).find((candidate) => candidate.surfaceType === "plane"
      && candidate.normal && Math.abs(candidate.normal.x) > 0.99)!;
    const expected = shapeWithCadResult(expectedSource, await applySketchFaceDraft(expectedSource, {
      sourceFaceId: expectedFace.id, angle: 5, pullDirection: "y",
    }));
    expect(replayed.faceDraftSourceScale).toEqual({ width: 1, depth: 1, height: 2 });
    expect((await shapeProperties({ ...replayed, importedMesh: undefined })).volume)
      .toBeCloseTo((await shapeProperties({ ...expected, importedMesh: undefined })).volume, 6);
  }, CAD_TEST_TIMEOUT_MS);
});
