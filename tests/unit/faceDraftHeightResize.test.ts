import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// #546: a face draft on a sketch extrusion resized in height rebuilt the
// extrusion at its resized height and then applied the height resize again,
// so a 2x2x3 extrusion resized to 4x2x6 and drafted came back 12 tall.

const DRAWN_HEIGHT = 3;
const ANGLE = 5;

/** A rectangle `2 * halfWidth` wide in X and 2 deep in Z. */
function rectangle(halfWidth = 1): SketchProfile {
  return {
    points: [
      { id: "a", x: -halfWidth, z: -1 }, { id: "b", x: halfWidth, z: -1 },
      { id: "c", x: halfWidth, z: 1 }, { id: "d", x: -halfWidth, z: 1 },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
  };
}

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Face draft after height resize", createdAt: 1,
    shapes: [], history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === "draft" ? structuredClone(document) : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      writes += 1;
      document.shapes = structuredClone(shapes);
      document.metadata.revision = writes;
      return { revision: writes };
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

/** The planar side face whose outward normal points along +X. */
async function plusXFace(shape: WorkplaneShape) {
  const face = (await shapeFaces(shape)).find((candidate) => candidate.surfaceType === "plane"
    && (candidate.normal?.x ?? 0) > 0.99);
  expect(face).toBeDefined();
  return face!;
}

type Placement = { rotation?: number; rotationX?: number };

/**
 * A sketch extrusion drawn from `profile` at `height` and `placement`,
 * optionally resized through `changeShape`. Placed at the same spot every
 * time, so the centres of mass compare directly.
 */
async function extrusion(profile: SketchProfile, height: number, resize: { width?: number; height?: number } = {}, placement: Placement = {}) {
  const project = projectStore();
  const shape = await sketchExtrusionShapeFromRequest({
    id: "drafted", sketchSourceId: "sketch/drafted", name: "Drafted extrusion",
    profile, height, x: 4, z: -2, elevation: 1, ...placement,
  });
  project.document.shapes = [shape];
  const engine = createEngine(project.store);
  const source = Object.keys(resize).length > 0
    ? value(await engine.changeShape("draft", shape.id, resize)).shape
    : shape;
  return { engine, source };
}

/** As `extrusion`, then given a face draft on its +X side (in its sketch frame). */
async function draftedExtrusion(profile: SketchProfile, height: number, resize: { width?: number; height?: number } = {}, placement: Placement = {}) {
  const { engine, source } = await extrusion(profile, height, resize, placement);
  // The face is chosen on the unturned extrusion, whose faces carry the same IDs.
  const unturned = Object.keys(placement).length > 0 ? { ...source, rotation: 0, rotationX: 0, rotationZ: 0 } : source;
  const face = await plusXFace(unturned);
  const drafted = value(await engine.changeShape("draft", source.id, {
    faceDraft: { sourceFaceId: face.id, angle: ANGLE, pullDirection: "y" },
  })).shape;
  return { engine, drafted };
}

async function expectSameSolid(actual: WorkplaneShape, expected: WorkplaneShape) {
  expect(actual.height).toBeCloseTo(expected.height, 4);
  expect(actual.width).toBeCloseTo(expected.width, 4);
  expect(actual.depth).toBeCloseTo(expected.depth, 4);
  const [actualProperties, expectedProperties] = await Promise.all([shapeProperties(actual), shapeProperties(expected)]);
  // The draft really changed the solid: a plain 2-deep box at this size would have this volume.
  expect(expectedProperties.volume).not.toBeCloseTo(expected.width * expected.depth * expected.height, 2);
  expect(actualProperties.volume).toBeCloseTo(expectedProperties.volume, 3);
  expect(actualProperties.centerOfMass.x).toBeCloseTo(expectedProperties.centerOfMass.x, 3);
  expect(actualProperties.centerOfMass.y).toBeCloseTo(expectedProperties.centerOfMass.y, 3);
  expect(actualProperties.centerOfMass.z).toBeCloseTo(expectedProperties.centerOfMass.z, 3);
}

describe("a face draft on a sketch extrusion resized in height (#546)", () => {
  it("drafts a height-only resize as a reference drawn at that height", async () => {
    const { drafted: actual } = await draftedExtrusion(rectangle(), DRAWN_HEIGHT, { height: DRAWN_HEIGHT * 2 });
    const { drafted: expected } = await draftedExtrusion(rectangle(), DRAWN_HEIGHT * 2);

    expect(actual.height).toBeCloseTo(DRAWN_HEIGHT * 2, 4);
    await expectSameSolid(actual, expected);
  }, CAD_TEST_TIMEOUT_MS);

  it("drafts a combined width and height resize as a reference drawn at that size", async () => {
    const { drafted: actual } = await draftedExtrusion(rectangle(), DRAWN_HEIGHT, { width: 4, height: DRAWN_HEIGHT * 2 });
    const { drafted: expected } = await draftedExtrusion(rectangle(2), DRAWN_HEIGHT * 2);

    expect(actual.height).toBeCloseTo(DRAWN_HEIGHT * 2, 4);
    await expectSameSolid(actual, expected);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps the resized height when the draft angle is changed", async () => {
    const { engine, drafted } = await draftedExtrusion(rectangle(), DRAWN_HEIGHT, { width: 4, height: DRAWN_HEIGHT * 2 });
    const reference = await draftedExtrusion(rectangle(2), DRAWN_HEIGHT * 2);
    // The first draft already has the resized height, so the angle change starts from it.
    await expectSameSolid(drafted, reference.drafted);

    const changed = value(await engine.changeShape("draft", drafted.id, {
      faceDraft: { ...drafted.faceDraft!, angle: ANGLE * 2 },
    })).shape;
    const expected = value(await reference.engine.changeShape("draft", reference.drafted.id, {
      faceDraft: { ...reference.drafted.faceDraft!, angle: ANGLE * 2 },
    })).shape;

    expect(changed.height).toBeCloseTo(DRAWN_HEIGHT * 2, 4);
    await expectSameSolid(changed, expected);
  }, CAD_TEST_TIMEOUT_MS);

  it("drafts a resized extrusion on a turned sketch plane as a reference drawn at that size", async () => {
    const placement = { rotation: 30, rotationX: 90 };
    const { drafted: actual } = await draftedExtrusion(rectangle(), DRAWN_HEIGHT, { width: 4, height: DRAWN_HEIGHT * 2 }, placement);
    const { drafted: expected } = await draftedExtrusion(rectangle(2), DRAWN_HEIGHT * 2, {}, placement);

    await expectSameSolid(actual, expected);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps the resized height when an absent draft is cleared", async () => {
    const { engine, source } = await extrusion(rectangle(), DRAWN_HEIGHT, { width: 4, height: DRAWN_HEIGHT * 2 });
    const cleared = value(await engine.changeShape("draft", source.id, { faceDraft: null })).shape;
    const { source: expected } = await extrusion(rectangle(2), DRAWN_HEIGHT * 2);

    expect(cleared.height).toBeCloseTo(DRAWN_HEIGHT * 2, 4);
    expect(cleared.width).toBeCloseTo(4, 4);
    const [actualProperties, expectedProperties] = await Promise.all([shapeProperties(cleared), shapeProperties(expected)]);
    expect(actualProperties.volume).toBeCloseTo(4 * 2 * DRAWN_HEIGHT * 2, 3);
    expect(actualProperties.volume).toBeCloseTo(expectedProperties.volume, 3);
    expect(actualProperties.centerOfMass.x).toBeCloseTo(expectedProperties.centerOfMass.x, 3);
    expect(actualProperties.centerOfMass.y).toBeCloseTo(expectedProperties.centerOfMass.y, 3);
    expect(actualProperties.centerOfMass.z).toBeCloseTo(expectedProperties.centerOfMass.z, 3);
  }, CAD_TEST_TIMEOUT_MS);
});
