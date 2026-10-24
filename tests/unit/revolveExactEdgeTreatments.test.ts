import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// #347: a revolve carries no exact B-rep of its own, so `GET /edges` listed the
// edges of its sewn tessellation (288 for a 24-sided ring), every `treat` but
// an all-edge chamfer rounded facets, and selected-edge indexes named facets.
// These tests drive the engine with the probe geometry from the issue and check
// the results against closed forms, by volume and centre of mass.

// The probe: a rectangle 2..4 out from the axis and 4 tall, turned 24-sided.
const INNER = 2;
const OUTER = 4;
const HEIGHT = 4;
const PROBE = { kind: "revolve", name: "Probe ring", profile: [[INNER, -2], [OUTER, -2], [OUTER, 2], [INNER, 2]], sides: 24 };
const SHARP_VOLUME = Math.PI * (OUTER ** 2 - INNER ** 2) * HEIGHT;

/**
 * Material a treatment of radius/distance `r` removes along one convex 90-degree
 * circular edge at radius `radius`, by Pappus: area times the distance its
 * centroid travels. `outward` is +1 when the material lies inside the edge's
 * radius (an outer edge) and -1 when it lies outside it (an inner edge).
 */
function removedAlongCircle(kind: "fillet" | "chamfer", r: number, radius: number, outward: 1 | -1) {
  const area = kind === "fillet" ? r * r * (1 - Math.PI / 4) : (r * r) / 2;
  // Centroid of the removed corner, measured from the sharp corner along each leg.
  const offset = kind === "fillet" ? (r * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI)) : r / 3;
  return { volume: 2 * Math.PI * (radius - outward * offset) * area, offset };
}

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Revolve edges",
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
    read: async (projectId: string) => projectId === "rev" ? structuredClone(document) : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      writes += 1;
      document.shapes = structuredClone(shapes);
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

async function revolve(request: Record<string, unknown> = PROBE) {
  const project = projectStore();
  const engine = createEngine(project.store);
  const shape = value(await engine.addShapes("rev", [request as never])).shapes[0]!;
  expect(shape.sketchOperation).toBe("revolve");
  expect(shape.cadBrep).toBeUndefined();
  return { ...project, engine, shape };
}

/** Volume and centre of mass of the stored exact B-rep itself, not of its display mesh. */
function brepProperties(shape: WorkplaneShape) {
  expect(shape.cadBrep).toBeTruthy();
  return withCadKernel((cad) => {
    const solid = cad.fromBREP(shape.cadBrep!);
    const query = cad.queryBatch([solid])[0]!;
    return { volume: query.volume, centerOfMass: query.centerOfMass, isValid: query.isValid };
  });
}

function surfaceCounts(faces: Awaited<ReturnType<typeof shapeFaces>>) {
  const counts: Record<string, number> = {};
  for (const face of faces) counts[face.surfaceType] = (counts[face.surfaceType] ?? 0) + 1;
  return counts;
}

describe("a plain full-turn revolve is listed and treated from its exact solid", () => {
  it("lists the analytic edges of the probe ring, not its facets", async () => {
    const { engine, shape } = await revolve();

    const edges = value(await engine.edges("rev", shape.id));

    // Four circles where the rectangle's corners turn, and the two seams of the
    // cylindrical walls -- which cannot be rounded and say so.
    const filletable = edges.filter((edge) => edge.filletable);
    expect(filletable).toHaveLength(4);
    expect(filletable.every((edge) => edge.curveType === "circle")).toBe(true);
    expect(filletable.map((edge) => edge.length).sort((a, b) => a - b)).toEqual([
      expect.closeTo(2 * Math.PI * INNER, 6), expect.closeTo(2 * Math.PI * INNER, 6),
      expect.closeTo(2 * Math.PI * OUTER, 6), expect.closeTo(2 * Math.PI * OUTER, 6),
    ]);
    expect(edges.filter((edge) => !edge.filletable)).toHaveLength(2);
    expect(edges.filter((edge) => !edge.filletable).every((edge) => edge.curveType === "line")).toBe(true);
    expect(edges).toHaveLength(6);
  }, CAD_TEST_TIMEOUT_MS);

  it("lists one filletable circle per profile corner for a longer profile", async () => {
    // An L-shaped section: six corners, six circles, three cylindrical seams.
    const { engine, shape } = await revolve({
      kind: "revolve", name: "Stepped ring", profile: [[2, -2], [5, -2], [5, 0], [3, 0], [3, 2], [2, 2]], sides: 24,
    });

    const edges = value(await engine.edges("rev", shape.id));

    expect(edges.filter((edge) => edge.filletable)).toHaveLength(6);
    expect(edges.filter((edge) => edge.filletable).every((edge) => edge.curveType === "circle")).toBe(true);
    expect(edges.filter((edge) => !edge.filletable)).toHaveLength(3);
  }, CAD_TEST_TIMEOUT_MS);

  it("measures the same edges the listing numbers", async () => {
    const { engine, shape } = await revolve();

    const edges = value(await engine.edges("rev", shape.id));
    const measured = value(await engine.measurements("rev", shape.id)).filter((entry) => entry.entity === "edge");

    expect(measured.map((entry) => entry.index)).toEqual(edges.map((edge) => edge.index));
    expect(measured.map((entry) => entry.length)).toEqual(edges.map((edge) => expect.closeTo(edge.length, 6)));
    const radii = measured.filter((entry) => entry.geometryType === "circle").map((entry) => entry.radius);
    expect(radii.sort((a, b) => a! - b!)).toEqual([
      expect.closeTo(INNER, 6), expect.closeTo(INNER, 6), expect.closeTo(OUTER, 6), expect.closeTo(OUTER, 6),
    ]);
  }, CAD_TEST_TIMEOUT_MS);

  it("fillets every edge of the exact solid: toroidal blends, the closed-form volume, a fraction of the faceted triangles", async () => {
    const r = 0.2;
    const filleted = await revolve();
    const chamfered = await revolve();

    const fillet = value(await filleted.engine.treat("rev", filleted.shape.id, { kind: "fillet", amount: r })).shape;
    const chamfer = value(await chamfered.engine.treat("rev", chamfered.shape.id, { kind: "chamfer", amount: r })).shape;

    // Two outer corners (material inside the radius) and two inner ones.
    const removed = (kind: "fillet" | "chamfer") => 2 * removedAlongCircle(kind, r, OUTER, 1).volume
      + 2 * removedAlongCircle(kind, r, INNER, -1).volume;
    const [filletProps, chamferProps] = await Promise.all([brepProperties(fillet), brepProperties(chamfer)]);
    expect(filletProps.isValid).toBe(true);
    expect(filletProps.volume).toBeCloseTo(SHARP_VOLUME - removed("fillet"), 4);
    expect(chamferProps.volume).toBeCloseTo(SHARP_VOLUME - removed("chamfer"), 4);
    // A fillet removes material, but less than a chamfer of the same size.
    expect(filletProps.volume).toBeLessThan(SHARP_VOLUME);
    expect(filletProps.volume).toBeGreaterThan(chamferProps.volume);
    // Still a ring about its own axis, halfway up.
    expect(filletProps.centerOfMass.x).toBeCloseTo(0, 6);
    expect(filletProps.centerOfMass.z).toBeCloseTo(0, 6);
    expect(filletProps.centerOfMass.y).toBeCloseTo(HEIGHT / 2, 6);

    // A circular edge between a flat face and a cylinder blends as a torus.
    const surfaces = surfaceCounts(await shapeFaces(fillet));
    expect(surfaces.torus).toBe(4);
    // The faceted fillet this replaces drew 7568 triangles. The exact one is
    // meshed at the server's usual 0.1 mm deflection, which spends most of its
    // triangles on the four small tori: 1664 here, against 416 for the chamfer.
    expect(fillet.importedMesh!.triangleCount).toBeLessThan(2000);
    expect(fillet.importedMesh!.triangleCount).toBeGreaterThan(chamfer.importedMesh!.triangleCount);
    expect(fillet.edgeTreatments).toEqual([expect.objectContaining({ kind: "fillet", amount: r, allEdges: true, edgeCount: 4 })]);
  }, CAD_TEST_TIMEOUT_MS);

  it("fillets only the edges a caller names by their listing index", async () => {
    const r = 0.3;
    const { engine, shape } = await revolve();
    const edges = value(await engine.edges("rev", shape.id));
    // The outer edge at the top of the ring, found the way a script would: by
    // its length and its midpoint.
    const topOuter = edges.find((edge) => edge.filletable
      && Math.abs(edge.length - 2 * Math.PI * OUTER) < 1e-6 && edge.midpoint.y > HEIGHT / 2);
    expect(topOuter).toBeDefined();

    const treated = value(await engine.treat("rev", shape.id, { kind: "fillet", amount: r, edges: [topOuter!.index] })).shape;

    const { volume: removed, offset } = removedAlongCircle("fillet", r, OUTER, 1);
    const props = await brepProperties(treated);
    expect(props.volume).toBeCloseTo(SHARP_VOLUME - removed, 4);
    // Material came off the top only, so the centre of mass drops.
    const expectedY = (SHARP_VOLUME * (HEIGHT / 2) - removed * (HEIGHT - offset)) / (SHARP_VOLUME - removed);
    expect(props.centerOfMass.y).toBeCloseTo(expectedY, 5);
    expect(props.centerOfMass.y).toBeLessThan(HEIGHT / 2);
    expect(props.centerOfMass.x).toBeCloseTo(0, 6);
    expect(props.centerOfMass.z).toBeCloseTo(0, 6);
    expect(surfaceCounts(await shapeFaces(treated)).torus).toBe(1);
    expect(treated.edgeTreatments).toEqual([expect.objectContaining({ kind: "fillet", amount: r, edgeCount: 1 })]);
  }, CAD_TEST_TIMEOUT_MS);

  it("builds a second treatment on the first instead of rebuilding the revolve from its profile", async () => {
    const { engine, shape } = await revolve();
    const topOuter = value(await engine.edges("rev", shape.id)).find((edge) => edge.filletable
      && Math.abs(edge.length - 2 * Math.PI * OUTER) < 1e-6 && edge.midpoint.y > HEIGHT / 2)!;
    const filleted = value(await engine.treat("rev", shape.id, { kind: "fillet", amount: 0.3, edges: [topOuter.index] })).shape;

    // An all-edge chamfer used to rebuild a revolve from its profile whatever
    // it carried, which silently threw the fillet away.
    const chamfered = value(await engine.treat("rev", shape.id, { kind: "chamfer", amount: 0.1 })).shape;

    expect(surfaceCounts(await shapeFaces(chamfered)).torus).toBe(1);
    const [filletProps, chamferProps] = await Promise.all([brepProperties(filleted), brepProperties(chamfered)]);
    expect(chamferProps.volume).toBeLessThan(filletProps.volume);
    expect(chamfered.edgeTreatments?.map((feature) => feature.kind)).toEqual(["fillet", "chamfer"]);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a seam named by its listing index", async () => {
    const { engine, shape, writeCount } = await revolve();
    const seam = value(await engine.edges("rev", shape.id)).find((edge) => !edge.filletable)!;
    const writes = writeCount();

    const result = await engine.treat("rev", shape.id, { kind: "fillet", amount: 0.2, edges: [seam.index] });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.failure).toMatchObject({ reason: "cad_refused", status: 400 });
    expect(writeCount()).toBe(writes);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps the analytic solid at a revolve's drawn size after it is made taller", async () => {
    const r = 0.2;
    const { engine, shape } = await revolve();
    const resized = value(await engine.changeShape("rev", shape.id, { height: HEIGHT * 2 })).shape;
    expect(resized.height).toBeCloseTo(HEIGHT * 2, 6);

    const treated = value(await engine.treat("rev", resized.id, { kind: "chamfer", amount: r })).shape;

    // The section is stretched twice as tall before it is chamfered.
    const tallVolume = Math.PI * (OUTER ** 2 - INNER ** 2) * HEIGHT * 2;
    const removed = 2 * removedAlongCircle("chamfer", r, OUTER, 1).volume + 2 * removedAlongCircle("chamfer", r, INNER, -1).volume;
    const props = await brepProperties(treated);
    expect(props.volume).toBeCloseTo(tallVolume - removed, 3);
    expect(props.centerOfMass.y).toBeCloseTo(HEIGHT, 5);
    expect(props.centerOfMass.x).toBeCloseTo(0, 6);
    expect(treated.height).toBeCloseTo(HEIGHT * 2, 4);
    expect(treated.width).toBeCloseTo(OUTER * 2, 4);
    // Still turned surfaces, not B-spline approximations of them.
    expect(surfaceCounts(await shapeFaces(treated)).bspline).toBeUndefined();
  }, CAD_TEST_TIMEOUT_MS);

  it("scales a revolve widened evenly across its axis radially", async () => {
    const r = 0.2;
    const { engine, shape } = await revolve();
    const resized = value(await engine.changeShape("rev", shape.id, { width: OUTER * 3, depth: OUTER * 3 })).shape;

    const treated = value(await engine.treat("rev", resized.id, { kind: "fillet", amount: r })).shape;

    // Radii 3 and 6 instead of 2 and 4, at the original height.
    const inner = INNER * 1.5;
    const outer = OUTER * 1.5;
    const removed = 2 * removedAlongCircle("fillet", r, outer, 1).volume + 2 * removedAlongCircle("fillet", r, inner, -1).volume;
    const props = await brepProperties(treated);
    expect(props.volume).toBeCloseTo(Math.PI * (outer ** 2 - inner ** 2) * HEIGHT - removed, 3);
    expect(surfaceCounts(await shapeFaces(treated)).torus).toBe(4);
  }, CAD_TEST_TIMEOUT_MS);
});

describe("a revolve with no exact solid refuses treatments instead of rounding its facets", () => {
  const unsupported: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a partial turn", { ...PROBE, sweepAngle: 180 }, /full turn/i],
    ["a helical sweep", { ...PROBE, pitch: 6, turns: 2 }, /helical/i],
  ];

  it.each(unsupported)("refuses fillets, chamfers and the edge listing on %s", async (_label, request, reason) => {
    const { engine, shape, writeCount, store } = await revolve(request);
    const before = (await store.read("rev"))!.shapes;
    const writes = writeCount();

    for (const treatment of [
      { kind: "fillet" as const, amount: 0.2 },
      { kind: "chamfer" as const, amount: 0.2 },
      { kind: "fillet" as const, amount: 0.2, edges: [0] },
    ]) {
      const result = await engine.treat("rev", shape.id, treatment);
      expect(result.ok, JSON.stringify(treatment)).toBe(false);
      expect(result.ok ? undefined : result.failure).toMatchObject({ reason: "cad_refused", status: 422 });
      expect(result.ok ? "" : (result.failure as { message: string }).message).toMatch(reason);
    }
    const listing = await engine.edges("rev", shape.id);
    expect(listing.ok).toBe(false);
    expect(listing.ok ? "" : (listing.failure as { message: string }).message).toMatch(reason);

    expect(writeCount()).toBe(writes);
    expect((await store.read("rev"))!.shapes).toEqual(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a revolve stretched unevenly across its axis, which is no longer round", async () => {
    const { engine, shape, writeCount } = await revolve();
    const stretched = value(await engine.changeShape("rev", shape.id, { width: OUTER * 3 })).shape;
    const writes = writeCount();

    const result = await engine.treat("rev", stretched.id, { kind: "fillet", amount: 0.2 });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.failure).toMatchObject({ reason: "cad_refused", status: 422 });
    expect(result.ok ? "" : (result.failure as { message: string }).message).toMatch(/unevenly/);
    expect(writeCount()).toBe(writes);
  }, CAD_TEST_TIMEOUT_MS);
});
