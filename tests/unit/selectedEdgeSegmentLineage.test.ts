import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { shapeEdges } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { uniqueSketchSourceEdge } from "@constructorfleet/sketchforge-engine/sketchEdgeSegmentLineage";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { apiShapeSummary } from "@/lib/apiShapes";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// #350: a selected-edge fillet or chamfer used to carry only transient edge
// indexes, so any later sketch edit was refused. A cap edge of a straight
// single-region extrusion is now recorded by the sketch segment it was swept
// from and the cap it bounds, and replayed by that identity.

const HEIGHT = 3;

/** A rectangle 2 wide in X whose `ab` side sits at z = `abZ`; `cd` stays at z = 1. */
function rectangle(abZ = -1, ids: { ab?: string } = {}): SketchProfile {
  return {
    points: [
      { id: "a", x: -1, z: abZ }, { id: "b", x: 1, z: abZ },
      { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
    ],
    segments: [
      { id: ids.ab ?? "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
  };
}

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Selected-edge lineage", createdAt: 1,
    shapes: [], history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === "lineage" ? structuredClone(document) : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      writes += 1;
      document.shapes = structuredClone(shapes);
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

async function extrusion() {
  const project = projectStore();
  const shape = await sketchExtrusionShapeFromRequest({
    id: "lineage-extrusion", sketchSourceId: "sketch/lineage-extrusion", name: "Lineage extrusion",
    profile: rectangle(), height: HEIGHT, x: 4, z: -2, elevation: 1,
  });
  project.document.shapes = [shape];
  return { ...project, engine: createEngine(project.store), shape };
}

/** The listed index of the line edge running along X at (z, y), as a caller of `GET /edges` would find it. */
async function edgeIndexAt(shape: WorkplaneShape, z: number, y: number) {
  const edges = (await shapeEdges(shape)).filter((edge) => edge.curveType === "line"
    && Math.abs(edge.midpoint.x) < 1e-6 && Math.abs(edge.midpoint.z - z) < 1e-6 && Math.abs(edge.midpoint.y - y) < 1e-6);
  expect(edges).toHaveLength(1);
  return edges[0]!.index;
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
      size: { x: bounds.xmax - bounds.xmin, y: bounds.ymax - bounds.ymin, z: bounds.zmax - bounds.zmin },
    };
  });
}

/**
 * A box `depth` deep in Z with both X-running edges of its z-min face rounded
 * by `r`. Each removes r^2 (1 - pi/4) along its length 2, centred r (10 - 3pi)
 * / (12 - 3pi) in from the z-min face, so the centre of mass moves toward +Z.
 */
function filletedBoxClosedForm(depth: number, r: number) {
  const box = 2 * depth * HEIGHT;
  const removedEach = 2 * r * r * (1 - Math.PI / 4);
  const offset = (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);
  const volume = box - 2 * removedEach;
  const centerZ = (box * depth / 2 - 2 * removedEach * offset) / volume;
  return { volume, center: { x: 1, y: HEIGHT / 2, z: centerZ } };
}

describe("uniqueSketchSourceEdge", () => {
  const segments = [
    { id: "ab", start: { x: -1, z: -1 }, end: { x: 1, z: -1 } },
    { id: "bc", start: { x: 1, z: -1 }, end: { x: 1, z: 1 } },
  ];
  const line = (from: [number, number, number], to: [number, number, number]) => ({
    curveType: "line",
    vertices: [{ x: from[0], y: from[1], z: from[2] }, { x: to[0], y: to[1], z: to[2] }],
  });

  it("names a cap edge by its segment and cap, in either direction", () => {
    expect(uniqueSketchSourceEdge(line([-1, 3, -1], [1, 3, -1]), segments, { bottom: 0, top: 3 }))
      .toEqual({ status: "matched", segmentId: "ab", cap: "top" });
    expect(uniqueSketchSourceEdge(line([1, 0, -1], [-1, 0, -1]), segments, { bottom: 0, top: 3 }))
      .toEqual({ status: "matched", segmentId: "ab", cap: "bottom" });
  });

  it("reports a vertical or curved edge as missing", () => {
    expect(uniqueSketchSourceEdge(line([1, 0, -1], [1, 3, -1]), segments, { bottom: 0, top: 3 })).toEqual({ status: "missing" });
    expect(uniqueSketchSourceEdge({ ...line([-1, 3, -1], [1, 3, -1]), curveType: "circle" }, segments, { bottom: 0, top: 3 }))
      .toEqual({ status: "missing" });
  });

  it("reports an edge two segments both describe as ambiguous", () => {
    const overlapping = [...segments, { id: "ba", start: { x: 1, z: -1 }, end: { x: -1, z: -1 } }];
    expect(uniqueSketchSourceEdge(line([-1, 3, -1], [1, 3, -1]), overlapping, { bottom: 0, top: 3 })).toEqual({ status: "ambiguous" });
  });
});

describe("selected-edge treatments replay by sketch-segment lineage", () => {
  it("records segment and cap for a selected-edge fillet and replays it after the segment moves", async () => {
    const r = 0.25;
    const { engine, shape, writeCount, store } = await extrusion();
    const top = await edgeIndexAt(shape, -1, HEIGHT);
    const bottom = await edgeIndexAt(shape, -1, 0);

    const treated = value(await engine.treat("lineage", shape.id, { kind: "fillet", amount: r, edges: [top, bottom] })).shape;

    const sourceEdges = [{ segmentId: "ab", cap: "top" }, { segmentId: "ab", cap: "bottom" }];
    expect(treated.edgeTreatments).toEqual([{ kind: "fillet", amount: r, edgeCount: 2, sourceEdges }]);
    expect(treated.edgeTreatmentHistory?.[0]?.feature).toEqual(treated.edgeTreatments?.[0]);
    // The persisted identity is the sketch lineage; the transient indexes are not stored.
    expect(JSON.stringify(treated.edgeTreatments)).not.toContain("\"edges\"");
    const original = await exactMassProperties(treated);
    const originalExpected = filletedBoxClosedForm(2, r);
    expect(original.volume).toBeCloseTo(originalExpected.volume, 6);
    expect(original.center.z).toBeCloseTo(originalExpected.center.z, 6);

    // The lineage survives `.skf`, and the restored project is what is edited.
    const saved = (await store.read("lineage"))!;
    const restored = await importSkfProject(await exportSkfProject({ ...saved, modifiedAt: 1 }));
    expect(restored.shapes[0]!.edgeTreatments).toEqual(treated.edgeTreatments);
    const reopened = projectStore();
    reopened.document.shapes = restored.shapes;
    const reopenedEngine = createEngine(reopened.store);

    const moved = rectangle(-1.5);
    const changed = await reopenedEngine.changeShape("lineage", shape.sketchSourceId!, { sketchProfile: moved });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    expect(reopened.writeCount()).toBe(1);
    const updated = value(changed).shape;
    expect(updated.sketchProfile).toEqual(moved);
    expect(updated.edgeTreatments).toEqual([{ kind: "fillet", amount: r, edgeCount: 2, sourceEdges }]);
    expect(updated.edgeTreatmentHistory).toHaveLength(1);
    expect(updated.edgeTreatmentHistory?.[0]?.feature).toEqual(updated.edgeTreatments?.[0]);
    expect(updated.edgeTreatmentHistory?.[0]?.before.edgeTreatments).toBeUndefined();

    // Ground truth by closed form: a 2 x 2.5 x 3 box with the two edges of
    // the moved z-min face rounded. Rounding the opposite (cd) face instead
    // would put the centre of mass on the other side of the middle.
    const replayed = await exactMassProperties(updated);
    const expected = filletedBoxClosedForm(2.5, r);
    expect(replayed.size.z).toBeCloseTo(2.5, 6);
    expect(replayed.volume).toBeCloseTo(expected.volume, 6);
    expect(replayed.center.x).toBeCloseTo(expected.center.x, 6);
    expect(replayed.center.y).toBeCloseTo(expected.center.y, 6);
    expect(replayed.center.z).toBeCloseTo(expected.center.z, 6);
    expect(replayed.center.z).toBeGreaterThan(2.5 / 2);
    expect(writeCount()).toBe(1);

    // The REST summary carries neither the treatment record nor any edge index.
    const summary = JSON.stringify(apiShapeSummary(updated));
    expect(summary).not.toMatch(/"edges"|"edgeTreatments"|"sourceEdges"/);
  }, CAD_TEST_TIMEOUT_MS);

  // A chamfer is distance `amount` along the side face (Y) and amount * tan(angle)
  // across the cap (Z), so a 30-degree chamfer removes a right triangle with
  // unequal legs and moves the centroid by different amounts in Y and Z. A
  // replay that dropped the recorded angle would cut the 45-degree triangle.
  it.each([45, 30])("replays a selected-edge %s-degree chamfer at its own angle", async (angle) => {
    const amount = 0.2;
    const { engine, shape } = await extrusion();
    const top = await edgeIndexAt(shape, -1, HEIGHT);
    const treated = value(await engine.treat("lineage", shape.id, { kind: "chamfer", amount, angle, edges: [top] })).shape;
    expect(treated.edgeTreatments).toEqual([
      { kind: "chamfer", amount, edgeCount: 1, chamferAngle: angle, sourceEdges: [{ segmentId: "ab", cap: "top" }] },
    ]);

    const updated = value(await engine.changeShape("lineage", shape.sketchSourceId!, { sketchProfile: rectangle(-1.5) })).shape;
    expect(updated.edgeTreatments?.[0]?.chamferAngle).toBe(angle);

    const legY = amount;
    const legZ = amount * Math.tan(angle * Math.PI / 180);
    const replayed = await exactMassProperties(updated);
    const box = 2 * 2.5 * HEIGHT;
    const removed = 2 * legY * legZ / 2;
    expect(box - replayed.volume).toBeCloseTo(removed, 6);
    expect(replayed.center.z).toBeCloseTo((box * 1.25 - removed * (legZ / 3)) / (box - removed), 6);
    expect(replayed.center.y).toBeCloseTo((box * 1.5 - removed * (HEIGHT - legY / 3)) / (box - removed), 6);
  }, CAD_TEST_TIMEOUT_MS);

  it("counts and records an edge named twice once", async () => {
    const { engine, shape } = await extrusion();
    const top = await edgeIndexAt(shape, -1, HEIGHT);
    const treated = value(await engine.treat("lineage", shape.id, { kind: "fillet", amount: 0.2, edges: [top, top] })).shape;
    expect(treated.edgeTreatments).toEqual([
      { kind: "fillet", amount: 0.2, edgeCount: 1, sourceEdges: [{ segmentId: "ab", cap: "top" }] },
    ]);
  }, CAD_TEST_TIMEOUT_MS);

  const breaking: Array<[string, SketchProfile, RegExp]> = [
    ["the segment is gone", rectangle(-1.5, { ab: "renamed" }), /sketch segment ab \(top cap\) is missing/],
    ["the profile gains a hole", {
      points: [
        ...rectangle(-1.5).points,
        { id: "h1", x: -0.3, z: -0.3 }, { id: "h2", x: 0.3, z: -0.3 }, { id: "h3", x: 0.3, z: 0.3 }, { id: "h4", x: -0.3, z: 0.3 },
      ],
      segments: [
        ...rectangle(-1.5).segments,
        { id: "h12", startId: "h1", endId: "h2" }, { id: "h23", startId: "h2", endId: "h3" },
        { id: "h34", startId: "h3", endId: "h4" }, { id: "h41", startId: "h4", endId: "h1" },
      ],
    }, /outside selected-edge lineage/],
  ];

  it.each(breaking)("refuses the edit atomically when %s", async (_label, edited, reason) => {
    const { engine, shape, store, writeCount } = await extrusion();
    const top = await edgeIndexAt(shape, -1, HEIGHT);
    value(await engine.treat("lineage", shape.id, { kind: "fillet", amount: 0.2, edges: [top] }));
    const before = (await store.read("lineage"))!.shapes;
    const writes = writeCount();

    const changed = await engine.changeShape("lineage", shape.sketchSourceId!, { sketchProfile: edited });

    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.failure.reason).toBe("sweep_failed");
    expect(JSON.stringify(changed.failure)).toMatch(reason);
    expect(writeCount()).toBe(writes);
    expect((await store.read("lineage"))!.shapes).toEqual(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("records no lineage for a side edge, and still refuses a later sketch edit", async () => {
    const { engine, shape, store, writeCount } = await extrusion();
    const side = (await shapeEdges(shape)).find((edge) => edge.curveType === "line"
      && Math.abs(edge.midpoint.y - HEIGHT / 2) < 1e-6)!;
    const treated = value(await engine.treat("lineage", shape.id, { kind: "fillet", amount: 0.2, edges: [side.index] })).shape;
    expect(treated.edgeTreatments?.[0]?.sourceEdges).toBeUndefined();
    const before = (await store.read("lineage"))!.shapes;
    const writes = writeCount();

    const changed = await engine.changeShape("lineage", shape.sketchSourceId!, { sketchProfile: rectangle(-1.5) });

    expect(changed.ok).toBe(false);
    expect(writeCount()).toBe(writes);
    expect((await store.read("lineage"))!.shapes).toEqual(before);
  }, CAD_TEST_TIMEOUT_MS);

  type Corruption = (document: ProjectDocument) => void;
  const malformed: Array<[string, Corruption, RegExp]> = [
    ["an unknown cap", (document) => {
      document.shapes[0]!.edgeTreatments![0]!.sourceEdges = [{ segmentId: "ab", cap: "middle" as "top" }];
    }, /edgeTreatments\[0\]\.sourceEdges/],
    ["the same edge twice", (document) => {
      document.shapes[0]!.edgeTreatments![0]!.sourceEdges = [{ segmentId: "ab", cap: "top" }, { segmentId: "ab", cap: "top" }];
    }, /edgeTreatments\[0\]\.sourceEdges/],
    ["a bad entry only in the history record", (document) => {
      document.shapes[0]!.edgeTreatmentHistory![0]!.feature.sourceEdges = [{ segmentId: "", cap: "top" }];
    }, /edgeTreatmentHistory\[0\]\.feature\.sourceEdges/],
  ];

  it.each(malformed)("refuses a .skf whose treatment lineage has %s", async (_label, corrupt, label) => {
    const { engine, shape, store } = await extrusion();
    const top = await edgeIndexAt(shape, -1, HEIGHT);
    value(await engine.treat("lineage", shape.id, { kind: "fillet", amount: 0.2, edges: [top] }));
    // Through JSON, so the feature and its history entry are separate objects
    // and corrupting one leaves the other well formed.
    const corrupted = JSON.parse(JSON.stringify((await store.read("lineage"))!)) as ProjectDocument;
    corrupt(corrupted);
    await expect(importSkfProject(await exportSkfProject({ ...corrupted, modifiedAt: 1 }))).rejects.toThrow(label);
  }, CAD_TEST_TIMEOUT_MS);
});
