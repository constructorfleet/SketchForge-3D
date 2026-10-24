import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { applyDraftPrism, applySketchFaceDraft, meshedCadResult, shapeWithCadResult } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const profile = {
  points: [
    { id: "a", x: 1, z: -1 }, { id: "b", x: 5, z: -2 },
    { id: "c", x: 6, z: 3 }, { id: "d", x: 2, z: 2 },
  ],
  segments: [
    { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
    { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
  ],
};
const PROJECT = "mirrored-drafts";

function projectEngine(shapes: WorkplaneShape[]) {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Mirrored drafts", createdAt: 1,
    shapes, history: [], historyIndex: -1, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let revision = 0;
  return createEngine({
    read: async (id) => id === PROJECT ? document : null,
    write: async (_id, _before, next) => {
      document.shapes = next;
      document.metadata.revision = ++revision;
      return { revision };
    },
    withLock: async <T>(_id: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore);
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

async function extrusion() {
  const source = await sketchExtrusionShapeFromRequest({ id: "mirrored-draft", sketchSourceId: "sketch/mirrored-draft", name: "Mirrored draft", profile, height: 8 });
  return { ...source, x: 17, z: -11, elevation: 4 } satisfies WorkplaneShape;
}

async function mirrorResult(source: WorkplaneShape, result: { brep: string }, axis: "x" | "y" | "z") {
  return withCadKernel((cad) => {
    const solid = cad.fromBREP(result.brep);
    const bounds = cad.getBoundingBox(solid, false);
    const center = { x: (bounds.xmin + bounds.xmax) / 2, y: (bounds.ymin + bounds.ymax) / 2, z: (bounds.zmin + bounds.zmax) / 2 };
    const normal = axis === "x" ? { x: 1, y: 0, z: 0 } : axis === "y" ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const reflected = cad.mirror(solid, center, normal);
    return meshedCadResult(cad, reflected, source);
  });
}

async function expectSameMassProperties(actual: WorkplaneShape, expected: WorkplaneShape) {
  const [actualProperties, expectedProperties] = await Promise.all([shapeProperties(actual), shapeProperties(expected)]);
  expect(actualProperties.volume).toBeCloseTo(expectedProperties.volume, 3);
  expect(actualProperties.centerOfMass.x).toBeCloseTo(expectedProperties.centerOfMass.x, 3);
  expect(actualProperties.centerOfMass.y).toBeCloseTo(expectedProperties.centerOfMass.y, 3);
  expect(actualProperties.centerOfMass.z).toBeCloseTo(expectedProperties.centerOfMass.z, 3);
}

describe("drafts on mirrored retained sketch extrusions", () => {
  it.each(["x", "y", "z"] as const)("drafts a prism and retains a mirror in %s", async (axis) => {
    const plain = await extrusion();
    const mirrored = { ...plain, [`mirror${axis.toUpperCase()}`]: true } as WorkplaneShape;
    const plainDraft = await applyDraftPrism(plain, { angle: -7 });
    const expectedMesh = await mirrorResult(mirrored, plainDraft, axis);
    const expected = shapeWithCadResult(mirrored, expectedMesh);
    const actual = value(await projectEngine([mirrored]).draftPrism(PROJECT, mirrored.id, -7)).shape;

    await expectSameMassProperties(actual, expected);
  }, CAD_TEST_TIMEOUT_MS);

  it.each(["x", "y", "z"] as const)("drafts the face listing after a mirror in %s", async (axis) => {
    const plain = await extrusion();
    const mirrored = { ...plain, [`mirror${axis.toUpperCase()}`]: true } as WorkplaneShape;
    const plainSide = (await shapeFaces(plain)).find((face) => face.surfaceType === "plane" && face.normal && Math.abs(face.normal.y) < 0.5)!;
    const mirroredSide = (await shapeFaces(mirrored)).find((face) => face.id === plainSide.id)!;
    const request = { sourceFaceId: plainSide.id, angle: -6, pullDirection: "y" as const };
    const plainDraft = await applySketchFaceDraft(plain, request);
    const expected = shapeWithCadResult(mirrored, await mirrorResult(mirrored, plainDraft, axis));
    const actual = value(await projectEngine([mirrored]).changeShape(PROJECT, mirrored.id, { faceDraft: request })).shape;

    expect(mirroredSide.normal).not.toEqual(plainSide.normal);
    await expectSameMassProperties(actual, expected);
  }, CAD_TEST_TIMEOUT_MS);

  it("records the drafted source normal and replays a mirrored face draft after a profile edit", async () => {
    const plain = await extrusion();
    const mirrored = { ...plain, mirrorX: true };
    const plainFaces = await shapeFaces(plain);
    const mirroredFaces = await shapeFaces(mirrored);
    const listedFace = mirroredFaces.find((face) => face.surfaceType === "plane" && face.normal
      && Math.abs(face.normal.x) > 0.9
      && plainFaces.find((sourceFace) => sourceFace.id === face.id)?.normal
      && JSON.stringify(plainFaces.find((sourceFace) => sourceFace.id === face.id)?.normal) !== JSON.stringify(face.normal))!;
    const plainFace = plainFaces.find((face) => face.id === listedFace.id)!;
    const request = { sourceFaceId: listedFace.id, angle: -6, pullDirection: "y" as const };
    const mirroredEngine = projectEngine([mirrored]);
    const plainEngine = projectEngine([plain]);

    const mirroredDraft = value(await mirroredEngine.changeShape(PROJECT, mirrored.id, { faceDraft: request })).shape;
    const plainDraft = value(await plainEngine.changeShape(PROJECT, plain.id, { faceDraft: request })).shape;
    expect(mirroredDraft.mirrorX).toBe(true);
    expect(mirroredDraft.faceDraft?.sourceFaceNormal).toEqual(plainFace.normal);
    expect(mirroredDraft.faceDraft?.sourceFaceNormal).not.toEqual(listedFace.normal);

    const editedProfile = { ...profile, points: profile.points.map((point) => point.id === "c" ? { ...point, x: 8, z: 4 } : point) };
    const replayed = value(await mirroredEngine.changeShape(PROJECT, mirrored.id, { sketchProfile: editedProfile })).shape;
    const plainReplayed = value(await plainEngine.changeShape(PROJECT, plain.id, { sketchProfile: editedProfile })).shape;
    expect(replayed.mirrorX).toBe(true);
    expect(replayed.faceDraft?.sourceFaceNormal).not.toEqual(plainDraft.faceDraft?.sourceFaceNormal);
    const expectedMesh = await mirrorResult(replayed, { brep: plainReplayed.cadBrep! }, "x");
    const expected = shapeWithCadResult(replayed, expectedMesh);
    await expectSameMassProperties(replayed, expected);
  }, CAD_TEST_TIMEOUT_MS);

  it("replays a mirrored prism draft after a profile edit", async () => {
    const source = { ...(await extrusion()), mirrorZ: true };
    const engine = projectEngine([source]);
    const drafted = value(await engine.draftPrism(PROJECT, source.id, -7)).shape;
    expect(drafted.mirrorZ).toBe(true);
    const editedProfile = { ...profile, points: profile.points.map((point) => point.id === "c" ? { ...point, x: 8, z: 4 } : point) };
    const replayed = value(await engine.changeShape(PROJECT, source.id, { sketchProfile: editedProfile })).shape;
    expect(replayed.mirrorZ).toBe(true);
    expect(replayed.draftPrismAngle).toBe(-7);
    const base = await sketchExtrusionShapeFromRequest({ id: source.id, sketchSourceId: source.sketchSourceId!, name: source.name, profile: editedProfile, height: source.height });
    const plainDraft = await applyDraftPrism(base, { angle: -7 });
    const expected = shapeWithCadResult(replayed, await mirrorResult(replayed, plainDraft, "z"));
    await expectSameMassProperties(replayed, expected);
  }, CAD_TEST_TIMEOUT_MS);
});
