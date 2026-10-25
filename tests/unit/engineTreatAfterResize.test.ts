import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { shapeEdges } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// #539: a sketch extrusion resized after it was made kept its exact B-rep at
// the drawn-from size, and a fillet, chamfer or shell built from that B-rep.
// The treated shape came back at the original size and the resize was gone.

const HEIGHT = 3;
const R = 0.25;

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
    metadata: { revision: 0 }, projectName: "Treat after resize", createdAt: 1,
    shapes: [], history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === "resize" ? structuredClone(document) : null,
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

/** A 2x2x3 sketch extrusion, then widened to 4 (and given any other changes) through `changeShape`. */
async function resizedExtrusion(changes: { height?: number } = {}) {
  const project = projectStore();
  const shape = await sketchExtrusionShapeFromRequest({
    id: "resized", sketchSourceId: "sketch/resized", name: "Resized extrusion",
    profile: rectangle(), height: HEIGHT, x: 4, z: -2, elevation: 1,
  });
  project.document.shapes = [shape];
  const engine = createEngine(project.store);
  const resized = value(await engine.changeShape("resize", shape.id, { width: 4, ...changes })).shape;
  expect(resized.width).toBeCloseTo(4, 9);
  return { ...project, engine, resized };
}

/** Exact volume, and centre of mass measured from the solid's own minimum corner. */
async function exactMassProperties(shape: WorkplaneShape) {
  return withCadKernel((cad) => {
    const solid = cad.fromBREP(shape.cadBrep!);
    const { volume, centerOfMass } = cad.queryBatch([solid])[0]!;
    const bounds = cad.getBoundingBox(solid, false);
    return {
      volume,
      center: { x: centerOfMass.x - bounds.xmin, y: centerOfMass.y - bounds.ymin, z: centerOfMass.z - bounds.zmin },
    };
  });
}

function expectMass(actual: Awaited<ReturnType<typeof exactMassProperties>>, volume: number, center: { x: number; y: number; z: number }) {
  expect(actual.volume).toBeCloseTo(volume, 3);
  expect(actual.center.x).toBeCloseTo(center.x, 3);
  expect(actual.center.y).toBeCloseTo(center.y, 3);
  expect(actual.center.z).toBeCloseTo(center.z, 3);
}

function expectSize(shape: WorkplaneShape, width: number, depth: number, height: number) {
  expect(shape.width).toBeCloseTo(width, 4);
  expect(shape.depth).toBeCloseTo(depth, 4);
  expect(shape.height).toBeCloseTo(height, 4);
}

/** A box with every edge rounded by r: the inner box swept by a sphere of radius r. */
function roundedBoxVolume(a: number, b: number, c: number, r: number) {
  const [ia, ib, ic] = [a - 2 * r, b - 2 * r, c - 2 * r];
  return ia * ib * ic + 2 * r * (ia * ib + ib * ic + ia * ic) + Math.PI * r * r * (ia + ib + ic) + (4 / 3) * Math.PI * r ** 3;
}

/**
 * A box `width` wide with the X-running edge where its z-min and y-max faces
 * meet rounded by r. That removes r^2 (1 - pi/4) along `width`, its centroid
 * r (10 - 3pi) / (12 - 3pi) in from each of those two faces.
 */
function topEdgeFilletClosedForm(width: number, depth: number, r: number) {
  const box = width * depth * HEIGHT;
  const removed = width * r * r * (1 - Math.PI / 4);
  const offset = (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);
  const volume = box - removed;
  return {
    volume,
    center: {
      x: width / 2,
      y: (box * HEIGHT / 2 - removed * (HEIGHT - offset)) / volume,
      z: (box * depth / 2 - removed * offset) / volume,
    },
  };
}

/** The listed index of the top-cap edge running along X at z = -1 in the extrusion's sketch frame. */
async function topFrontEdgeIndex(shape: WorkplaneShape) {
  const edges = (await shapeEdges(shape)).filter((edge) => edge.curveType === "line"
    && Math.abs(edge.midpoint.x) < 1e-6 && Math.abs(edge.midpoint.z + 1) < 1e-6 && Math.abs(edge.midpoint.y - HEIGHT) < 1e-6);
  expect(edges).toHaveLength(1);
  return edges[0]!;
}

describe("treatments on a resized sketch extrusion keep the resize (#539)", () => {
  it("rounds every edge of the widened solid, not the drawn-from one", async () => {
    const { engine, resized } = await resizedExtrusion();

    const treated = value(await engine.treat("resize", resized.id, { kind: "fillet", amount: R })).shape;

    expectSize(treated, 4, 2, HEIGHT);
    expectMass(await exactMassProperties(treated), roundedBoxVolume(4, 2, HEIGHT, R), { x: 2, y: HEIGHT / 2, z: 1 });
  }, CAD_TEST_TIMEOUT_MS);

  it("rounds the selected edge along its widened length and records its sketch lineage", async () => {
    const { engine, resized } = await resizedExtrusion();
    const edge = await topFrontEdgeIndex(resized);
    expect(edge.length).toBeCloseTo(4, 6);

    const treated = value(await engine.treat("resize", resized.id, { kind: "fillet", amount: R, edges: [edge.index] })).shape;

    expectSize(treated, 4, 2, HEIGHT);
    const expected = topEdgeFilletClosedForm(4, 2, R);
    expectMass(await exactMassProperties(treated), expected.volume, expected.center);
    expect(treated.edgeTreatments?.[0]?.sourceEdges).toEqual([{ segmentId: "ab", cap: "top" }]);
  }, CAD_TEST_TIMEOUT_MS);

  it("chamfers the widened solid", async () => {
    const { engine, resized } = await resizedExtrusion();
    const drawn = await sketchExtrusionShapeFromRequest({ id: "drawn", profile: rectangle(2), height: HEIGHT, x: 0, z: 0, elevation: 0 });
    const { engine: reference } = await (async () => {
      const project = projectStore();
      project.document.shapes = [drawn];
      return { engine: createEngine(project.store) };
    })();

    const treated = value(await engine.treat("resize", resized.id, { kind: "chamfer", amount: R })).shape;
    const expected = value(await reference.treat("resize", drawn.id, { kind: "chamfer", amount: R })).shape;

    expectSize(treated, 4, 2, HEIGHT);
    const expectedMass = await exactMassProperties(expected);
    expect(expectedMass.volume).toBeLessThan(4 * 2 * HEIGHT);
    expectMass(await exactMassProperties(treated), expectedMass.volume, expectedMass.center);
  }, CAD_TEST_TIMEOUT_MS);

  it("shells the widened solid", async () => {
    const { engine, resized } = await resizedExtrusion();
    const t = 0.2;

    const shelled = value(await engine.shell("resize", resized.id, { thickness: t, openFaces: ["top"] })).shape;

    expectSize(shelled, 4, 2, HEIGHT);
    const outer = 4 * 2 * HEIGHT;
    const cavity = (4 - 2 * t) * (2 - 2 * t) * (HEIGHT - t);
    const volume = outer - cavity;
    expectMass(await exactMassProperties(shelled), volume, {
      x: 2, z: 1, y: (outer * HEIGHT / 2 - cavity * (t + (HEIGHT - t) / 2)) / volume,
    });
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps both the resize and an all-edge fillet through a later profile edit", async () => {
    const { engine, resized } = await resizedExtrusion();
    value(await engine.treat("resize", resized.id, { kind: "fillet", amount: R }));

    // Drawn 3 wide now; the earlier resize doubled the width, so 6.
    const edited = value(await engine.changeShape("resize", resized.id, { sketchProfile: rectangle(1.5) })).shape;

    expectSize(edited, 6, 2, HEIGHT);
    expect(edited.edgeTreatments).toHaveLength(1);
    expectMass(await exactMassProperties(edited), roundedBoxVolume(6, 2, HEIGHT, R), { x: 3, y: HEIGHT / 2, z: 1 });
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a resize in height as well as width through a later profile edit", async () => {
    const { engine, resized } = await resizedExtrusion({ height: HEIGHT * 2 });
    value(await engine.treat("resize", resized.id, { kind: "fillet", amount: R }));

    const edited = value(await engine.changeShape("resize", resized.id, { sketchProfile: rectangle(1.5) })).shape;

    expectSize(edited, 6, 2, HEIGHT * 2);
    expectMass(await exactMassProperties(edited), roundedBoxVolume(6, 2, HEIGHT * 2, R), { x: 3, y: HEIGHT, z: 1 });
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps both the resize and a selected-edge fillet through a later profile edit", async () => {
    const { engine, resized } = await resizedExtrusion();
    const edge = await topFrontEdgeIndex(resized);
    value(await engine.treat("resize", resized.id, { kind: "fillet", amount: R, edges: [edge.index] }));

    const edited = value(await engine.changeShape("resize", resized.id, { sketchProfile: rectangle(1.5) })).shape;

    expectSize(edited, 6, 2, HEIGHT);
    expect(edited.edgeTreatments?.[0]?.sourceEdges).toEqual([{ segmentId: "ab", cap: "top" }]);
    const expected = topEdgeFilletClosedForm(6, 2, R);
    expectMass(await exactMassProperties(edited), expected.volume, expected.center);
  }, CAD_TEST_TIMEOUT_MS);

  it("ignores a cleared face draft's resize when the extrusion is widened again", async () => {
    const { engine, resized } = await resizedExtrusion();
    const side = (await shapeFaces(resized)).find((face) => face.surfaceType === "plane" && (face.normal?.x ?? 0) > 0.99)!;
    value(await engine.changeShape("resize", resized.id, { faceDraft: { sourceFaceId: side.id, angle: 5, pullDirection: "y" } }));
    const cleared = value(await engine.changeShape("resize", resized.id, { faceDraft: null })).shape;
    expectSize(cleared, 4, 2, HEIGHT);
    const widened = value(await engine.changeShape("resize", resized.id, { width: 8 })).shape;

    expect((await topFrontEdgeIndex(widened)).length).toBeCloseTo(8, 6);
    const treated = value(await engine.treat("resize", resized.id, { kind: "fillet", amount: R })).shape;

    expectSize(treated, 8, 2, HEIGHT);
    expectMass(await exactMassProperties(treated), roundedBoxVolume(8, 2, HEIGHT, R), { x: 4, y: HEIGHT / 2, z: 1 });
  }, CAD_TEST_TIMEOUT_MS);
});

describe("a treatment recorded before #539 keeps its profile-edit behaviour", () => {
  it("rebuilds at the profile's own size when the stored shape does not match the recorded resize", async () => {
    // Before the fix, a 2-wide extrusion widened to 4 and filleted was stored 2
    // wide while its record's `before` said 4. That record's resize was never
    // applied, so a profile edit must not apply it now.
    const project = projectStore();
    const drawn = await sketchExtrusionShapeFromRequest({
      id: "legacy", sketchSourceId: "sketch/legacy", profile: rectangle(), height: HEIGHT, x: 0, z: 0, elevation: 0,
    });
    project.document.shapes = [drawn];
    const engine = createEngine(project.store);
    value(await engine.treat("resize", drawn.id, { kind: "fillet", amount: R }));
    const legacy = project.document.shapes[0]!;
    legacy.edgeTreatmentHistory![0]!.before = { ...legacy.edgeTreatmentHistory![0]!.before, width: 4, size: 4 };
    expectSize(legacy, 2, 2, HEIGHT);

    const edited = value(await engine.changeShape("resize", drawn.id, { sketchProfile: rectangle(1.5) })).shape;

    expectSize(edited, 3, 2, HEIGHT);
    expectMass(await exactMassProperties(edited), roundedBoxVolume(3, 2, HEIGHT, R), { x: 1.5, y: HEIGHT / 2, z: 1 });
  }, CAD_TEST_TIMEOUT_MS);
});

describe("an uneven resize of an asymmetric, turned and mirrored extrusion", () => {
  /** An L in sketch coordinates well away from the origin. */
  const lProfile = (sx = 1, sz = 1): SketchProfile => {
    const corners: Array<[number, number]> = [[2, 1], [6, 1], [6, 3], [4, 3], [4, 5], [2, 5]];
    // Scaled about the profile's own centre, (4, 3), as a resize scales it.
    const points = corners.map(([x, z], index) => ({ id: `p${index}`, x: 4 + (x - 4) * sx, z: 3 + (z - 3) * sz }));
    return {
      points,
      segments: points.map((point, index) => ({ id: `s${index}`, startId: point.id, endId: points[(index + 1) % points.length]!.id })),
    };
  };

  async function treatedL(profile: SketchProfile, height: number, resize: { width?: number; depth?: number; height?: number }) {
    const project = projectStore();
    const shape = await sketchExtrusionShapeFromRequest({
      id: "l", sketchSourceId: "sketch/l", profile, height, x: -3, z: 7, elevation: 2,
    });
    project.document.shapes = [shape];
    const engine = createEngine(project.store);
    const placed = value(await engine.changeShape("resize", shape.id, {
      ...(resize.width ? { width: shape.width * resize.width } : {}),
      ...(resize.depth ? { depth: shape.depth * resize.depth } : {}),
      ...(resize.height ? { height: shape.height * resize.height } : {}),
      rotation: 30,
      mirrorX: true,
    })).shape;
    const treated = value(await engine.treat("resize", placed.id, { kind: "fillet", amount: 0.2 })).shape;
    return shapeProperties(treated);
  }

  it("fillets it where and as a reference drawn at the new size is filleted", async () => {
    const actual = await treatedL(lProfile(), 2, { width: 2, depth: 0.5, height: 1.5 });
    const expected = await treatedL(lProfile(2, 0.5), 3, {});

    expect(actual.volume).toBeLessThan(8 * 2 * 3 - 4 * 1 * 3);
    expect(actual.volume).toBeCloseTo(expected.volume, 2);
    expect(actual.centerOfMass.x).toBeCloseTo(expected.centerOfMass.x, 3);
    expect(actual.centerOfMass.y).toBeCloseTo(expected.centerOfMass.y, 3);
    expect(actual.centerOfMass.z).toBeCloseTo(expected.centerOfMass.z, 3);
  }, CAD_TEST_TIMEOUT_MS);
});
