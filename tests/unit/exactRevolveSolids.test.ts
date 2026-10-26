/**
 * A plain revolve is measured, cut and exported as its exact OCCT solid
 * (issue #523), not as the sewn tessellation it is stored as.
 *
 * The revolves here are deliberately coarse -- 24 sides -- so the faceted mesh
 * is about 1.1% short of the analytic volume and the two cannot be confused.
 * Checked by volume and centre of mass (Pappus), never by bounds: a partial
 * sweep turned the wrong way round its axis keeps the same box size.
 */
import { describe, expect, it } from "vitest";
import { createEngine, exportProjectScene, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { solidFromBrepOnKernel } from "@constructorfleet/sketchforge-engine/sketchFaceDraftKernel";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { revolvedShapeFromRequest } from "@constructorfleet/sketchforge-engine/revolveRequests";
import { normalizeSketchRevolveSettings } from "@constructorfleet/sketchforge-engine/sketchRevolve";
import manifoldModule from "manifold-3d";

const CAD_TIMEOUT_MS = 60_000;

function projectWith(shapes: WorkplaneShape[]) {
  let document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Exact revolve",
    createdAt: 0,
    shapes,
    history: [],
    historyIndex: -1,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(),
    sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let revision = 0;
  const store = {
    read: async (projectId: string) => projectId === "revolve" ? document : null,
    write: async (_projectId: string, next: ProjectDocument, nextShapes: WorkplaneShape[]) => {
      revision += 1;
      document = { ...next, shapes: nextShapes, metadata: { ...next.metadata, revision } };
      return { revision };
    },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { engine: createEngine(store), document: () => document };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

/** Radial centroid of an annular sector of inner radius r, outer R, total angle theta. */
function sectorCentroidRadius(r: number, R: number, theta: number) {
  const half = theta / 2;
  return (2 * Math.sin(half) / (3 * half)) * (R ** 3 - r ** 3) / (R ** 2 - r ** 2);
}

// A request's outline is [distance from the axis, z], and z runs down the
// section: the point at the largest z is the revolve's base.
const RING = [[5, 0], [10, 0], [10, 8], [5, 8]];
const RING_VOLUME = Math.PI * (10 ** 2 - 5 ** 2) * 8;
// A right triangle with its right angle on the axis side at the top: area 50,
// centroid 25/3 from the axis and 20/3 above the base.
const TRIANGLE = [[5, 0], [15, 0], [5, 10]];
const TRIANGLE_VOLUME = 2 * Math.PI * (25 / 3) * 50;

describe("a plain revolve is measured as its exact solid (#523)", () => {
  it("reports the analytic volume and centre of mass of a full turn, and says it is exact", async () => {
    const { engine } = projectWith([]);
    const [cone] = value(await engine.addShapes("revolve", [
      { kind: "revolve", name: "Cone", profile: TRIANGLE, sides: 24, x: 12, z: -7, elevation: 3 },
    ])).shapes;
    expect(cone.importedMesh).toBeDefined();

    const properties = value(await engine.properties("revolve", cone.id));
    expect(properties.volume / TRIANGLE_VOLUME).toBeCloseTo(1, 6);
    expect(properties.centerOfMass.x).toBeCloseTo(12, 6);
    expect(properties.centerOfMass.z).toBeCloseTo(-7, 6);
    // The solid's centroid height weights the section by radius: with r = 5 + a
    // at height a, it is the integral of r*a over that of r, which is 7.
    expect(properties.centerOfMass.y).toBeCloseTo(3 + 7, 6);
    expect(properties.provenance).toEqual({ source: "parametric", precision: "exact" });
  }, CAD_TIMEOUT_MS);

  it("keeps a partial sweep about its recorded axis, turned, mirrored and resized", async () => {
    const { engine } = projectWith([]);
    const [quarter] = value(await engine.addShapes("revolve", [
      { kind: "revolve", name: "Quarter", profile: RING, sides: 24, sweepAngle: 90, x: 100, z: -20 },
    ])).shapes;
    const volume = (Math.PI / 4) * (10 ** 2 - 5 ** 2) * 8;
    const offset = sectorCentroidRadius(5, 10, Math.PI / 2) * Math.SQRT1_2;

    const plain = value(await engine.properties("revolve", quarter.id));
    expect(plain.volume / volume).toBeCloseTo(1, 6);
    // Manifold sweeps from +X towards the editor's -Z, about the axis at (100, -20).
    expect(plain.centerOfMass.x).toBeCloseTo(100 + offset, 6);
    expect(plain.centerOfMass.z).toBeCloseTo(-20 - offset, 6);
    expect(plain.centerOfMass.y).toBeCloseTo(4, 6);
    expect(plain.provenance.precision).toBe("exact");

    // A mirror reflects about the shape's box centre, as the viewport does.
    value(await engine.changeShape("revolve", quarter.id, { mirrorX: true }));
    const mirrored = value(await engine.properties("revolve", quarter.id));
    expect(mirrored.volume / volume).toBeCloseTo(1, 6);
    expect(mirrored.centerOfMass.x).toBeCloseTo(2 * quarter.x - plain.centerOfMass.x, 6);
    expect(mirrored.centerOfMass.z).toBeCloseTo(plain.centerOfMass.z, 6);
    expect(mirrored.provenance.precision).toBe("exact");

    // A quarter turn of yaw carries the centre of mass round the box centre.
    value(await engine.changeShape("revolve", quarter.id, { mirrorX: false, rotation: 90 }));
    const turned = value(await engine.properties("revolve", quarter.id));
    const dx = plain.centerOfMass.x - quarter.x;
    const dz = plain.centerOfMass.z - quarter.z;
    expect(turned.centerOfMass.x).toBeCloseTo(quarter.x + dz, 6);
    expect(turned.centerOfMass.z).toBeCloseTo(quarter.z - dx, 6);

    // An even resize across the axis scales the section radially.
    value(await engine.changeShape("revolve", quarter.id, { rotation: 0, width: quarter.width * 2, depth: quarter.depth * 2 }));
    const resized = value(await engine.properties("revolve", quarter.id));
    expect(resized.volume / (volume * 4)).toBeCloseTo(1, 6);
    expect(resized.provenance.precision).toBe("exact");
  }, CAD_TIMEOUT_MS);

  it("turns a negative partial sweep from where it ends, as the mesh sweep does", async () => {
    const { engine } = projectWith([]);
    const [arc] = value(await engine.addShapes("revolve", [
      { kind: "revolve", name: "Arc", profile: RING, sides: 24, sweepAngle: -90, startAngle: 30, x: -40, z: 15 },
    ])).shapes;
    // Swept back from 30 degrees to -60, so its middle is at -15 degrees, where
    // an angle runs from +X towards the editor's -Z.
    const radius = sectorCentroidRadius(5, 10, Math.PI / 2);
    const middle = (-15 * Math.PI) / 180;
    const properties = value(await engine.properties("revolve", arc.id));
    expect(properties.volume / ((Math.PI / 4) * 75 * 8)).toBeCloseTo(1, 6);
    expect(properties.centerOfMass.x).toBeCloseTo(-40 + radius * Math.cos(middle), 6);
    expect(properties.centerOfMass.z).toBeCloseTo(15 - radius * Math.sin(middle), 6);
  }, CAD_TIMEOUT_MS);

  it("leaves a helical revolve tessellated", async () => {
    const { engine } = projectWith([]);
    const [spring] = value(await engine.addShapes("revolve", [
      { kind: "revolve", name: "Spring", profile: [[8, 0], [10, 0], [10, 2], [8, 2]], sides: 24, pitch: 4, turns: 2 },
    ])).shapes;
    const properties = value(await engine.properties("revolve", spring.id));
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  }, CAD_TIMEOUT_MS);

  it("reports interference against a revolve as exact", async () => {
    const box = sceneShape({ id: "block", name: "block", kind: "box", color: "#336699", width: 10, depth: 10, height: 8, x: 10 });
    const { engine } = projectWith([box]);
    value(await engine.addShapes("revolve", [{ kind: "revolve", name: "Ring", profile: RING, sides: 24 }]));
    const report = value(await engine.interference("revolve", {}));
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0].precision).toBe("exact");
  }, CAD_TIMEOUT_MS);

  it("cuts a box out of a revolve exactly, and stores the cut's analytic surfaces", async () => {
    // The box covers every point with x >= 0, so it takes exactly half the ring.
    const cutter = sceneShape({ id: "cutter", name: "cutter", kind: "box", color: "#336699", width: 30, depth: 30, height: 20, x: 15, elevation: -5, hole: true });
    const { engine } = projectWith([cutter]);
    const [ring] = value(await engine.addShapes("revolve", [{ kind: "revolve", name: "Ring", profile: RING, sides: 24 }])).shapes;

    const group = value(await engine.group("revolve", [ring.id, cutter.id])).shape;
    // The cut's exact geometry is what is stored beside its display mesh, in
    // the result's own frame: centred on the group in X and Z, base at Y=0.
    expect(group.cadBrep).toBeTruthy();
    const stored = await withCadKernel((cad) => cad.queryBatch([solidFromBrepOnKernel(cad, group.cadBrep!)])[0]!);
    expect(stored.volume / (RING_VOLUME / 2)).toBeCloseTo(1, 6);
    // The half ring's centroid sits 4(R^3-r^3)/(3pi(R^2-r^2)) on the -X side.
    const halfRingOffset = (4 * (10 ** 3 - 5 ** 3)) / (3 * Math.PI * (10 ** 2 - 5 ** 2));
    expect(stored.centerOfMass.x + group.x).toBeCloseTo(ring.x - halfRingOffset, 6);
    expect(stored.centerOfMass.z + group.z).toBeCloseTo(ring.z, 6);
    expect(stored.centerOfMass.y + (group.elevation ?? 0)).toBeCloseTo((ring.elevation ?? 0) + 4, 6);

    const faces = value(await engine.faces("revolve", group.id, "exact"));
    // Two half cylinders, top, bottom and the two cut faces: no facets.
    expect(faces.filter((face) => face.surfaceType === "cylinder")).toHaveLength(2);
    expect(faces).toHaveLength(6);

  }, CAD_TIMEOUT_MS);

  it("exports a cut group to STEP from its members: the exact revolve, with the box cut out of it", async () => {
    // A STEP export takes a group apart into its members rather than writing
    // the group's stored B-rep, so this is the revolve's own exact solid, from
    // the exporter's `exactBrepFor`, with the box hole subtracted there.
    const cutter = sceneShape({ id: "cutter", name: "cutter", kind: "box", color: "#336699", width: 30, depth: 30, height: 20, x: 15, elevation: -5, hole: true });
    const { engine, document } = projectWith([cutter]);
    const [ring] = value(await engine.addShapes("revolve", [{ kind: "revolve", name: "Ring", profile: RING, sides: 24 }])).shapes;
    value(await engine.group("revolve", [ring.id, cutter.id]));

    const artifact = await exportProjectScene(document(), { format: "step" });
    expect(artifact.skipped).toEqual([]);
    const step = new TextDecoder().decode(artifact.data);
    expect(step.match(/CYLINDRICAL_SURFACE/g)?.length).toBe(2);
    const imported = await withCadKernel((cad) => cad.queryBatch([cad.importStep(step)])[0]!);
    expect(imported.volume / (RING_VOLUME / 2)).toBeCloseTo(1, 6);
  }, CAD_TIMEOUT_MS);

  it("meshes a cut through a revolve at least as finely as the revolve's own sides", async () => {
    // Before the revolve was exact, the cut was made from its faceted mesh, so
    // the stored result was as fine as `sides` asked. The exact cut is
    // tessellated for display, STL and measurement, and must be no coarser.
    const triangles: number[] = [];
    for (const sides of [24, 64, 256]) {
      const cutter = sceneShape({ id: "cutter", name: "cutter", kind: "box", color: "#336699", width: 30, depth: 30, height: 20, x: 15, elevation: -5, hole: true });
      const { engine } = projectWith([cutter]);
      const [ring] = value(await engine.addShapes("revolve", [{ kind: "revolve", name: "Ring", profile: RING, sides }])).shapes;
      const group = value(await engine.group("revolve", [ring.id, cutter.id])).shape;
      const measured = value(await engine.properties("revolve", group.id));
      // A polygon of `sides` facets holds this fraction of its circle's area.
      const faceted = (sides / (2 * Math.PI)) * Math.sin((2 * Math.PI) / sides);
      const error = 1 - measured.volume / (RING_VOLUME / 2);
      expect(error, `${sides} sides`).toBeGreaterThanOrEqual(-1e-9);
      // OCCT lands on the faceted error almost exactly (64 sides: 0.1606%
      // against 0.16066%), so allow a quarter over it; the fixed-chord mesh
      // this guards against was over three times it.
      expect(error, `${sides} sides`).toBeLessThanOrEqual((1 - faceted) * 1.25);
      triangles.push(group.importedMesh!.positions.length / 9);
    }
    expect(triangles[1]).toBeGreaterThan(triangles[0]);
    expect(triangles[2]).toBeGreaterThan(triangles[1]);
  }, CAD_TIMEOUT_MS);

  it("builds a curved profile revolve from its exact Bezier edge", async () => {
    const runtime = await manifoldModule();
    runtime.setup();
    const point = (id: string, x: number, z: number, extra: Record<string, unknown> = {}) => ({ id, x, z, mode: "corner" as const, ...extra });
    const profile = (kind: "line" | "bezier") => ({
      points: [
        point("a", -5, 0),
        point("b", -10, 0, { handleOut: { x: -13, z: 2 } }),
        point("c", -10, 8, { handleIn: { x: -13, z: 6 } }),
        point("d", -5, 8),
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b", kind: "line" as const },
        { id: "bc", startId: "b", endId: "c", kind },
        { id: "cd", startId: "c", endId: "d", kind: "line" as const },
        { id: "da", startId: "d", endId: "a", kind: "line" as const },
      ],
      images: [],
    });
    const settings = normalizeSketchRevolveSettings({ sides: 24 });
    const curved = revolvedShapeFromRequest(runtime, { profile: profile("bezier"), settings }, {});
    const curvedProperties = await shapeProperties(curved);
    expect(curvedProperties.provenance).toEqual({ source: "parametric", precision: "exact" });
    // The cubic radius is 10 + 9t(1-t) and its axial coordinate is
    // 6t + 6t^2 - 4t^3. Integrating pi*(R^2 - 5^2) dz gives 6126*pi/7.
    // The centre remains at mid-height and on the revolve axis.
    expect(curvedProperties.volume / ((6126 / 7) * Math.PI)).toBeCloseTo(1, 6);
    expect(curvedProperties.centerOfMass.x).toBeCloseTo(0, 6);
    expect(curvedProperties.centerOfMass.z).toBeCloseTo(0, 6);
    expect(curvedProperties.centerOfMass.y).toBeCloseTo(4, 6);
    // The same outline with that edge drawn straight is exact.
    const straight = revolvedShapeFromRequest(runtime, { profile: profile("line"), settings }, {});
    const properties = await shapeProperties(straight);
    expect(properties.provenance).toEqual({ source: "parametric", precision: "exact" });
    expect(properties.volume / RING_VOLUME).toBeCloseTo(1, 6);
  }, CAD_TIMEOUT_MS);

  it("exports a standalone revolve to STEP with its analytic surfaces", async () => {
    const { engine, document } = projectWith([]);
    value(await engine.addShapes("revolve", [{ kind: "revolve", name: "Ring", profile: RING, sides: 24 }]));
    const artifact = await exportProjectScene(document(), { format: "step" });
    expect(artifact.exportedCount).toBe(1);
    const step = new TextDecoder().decode(artifact.data);
    expect(step.match(/CYLINDRICAL_SURFACE/g)?.length).toBe(2);
  }, CAD_TIMEOUT_MS);

  it("exports a placed partial sweep to STEP where it stands", async () => {
    const { engine, document } = projectWith([]);
    const [quarter] = value(await engine.addShapes("revolve", [
      { kind: "revolve", name: "Quarter", profile: RING, sides: 24, sweepAngle: 90, x: 100, z: -20, elevation: 3, rotation: 30 },
    ])).shapes;
    value(await engine.changeShape("revolve", quarter.id, { mirrorZ: true }));
    const placed = value(await engine.properties("revolve", quarter.id));
    expect(placed.provenance.precision).toBe("exact");

    const step = new TextDecoder().decode((await exportProjectScene(document(), { format: "step" })).data);
    const imported = await withCadKernel((cad) => cad.queryBatch([cad.importStep(step)])[0]!);
    expect(imported.volume / placed.volume).toBeCloseTo(1, 6);
    // STEP is Z-up: the editor's (x, y, z) is written as (x, -z, y).
    expect(imported.centerOfMass.x).toBeCloseTo(placed.centerOfMass.x, 4);
    expect(imported.centerOfMass.y).toBeCloseTo(-placed.centerOfMass.z, 4);
    expect(imported.centerOfMass.z).toBeCloseTo(placed.centerOfMass.y, 4);
  }, CAD_TIMEOUT_MS);
});
