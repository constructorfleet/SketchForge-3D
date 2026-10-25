/**
 * A stored boolean result is measured from its exact B-rep (issue #541), not
 * from the display mesh it is drawn with.
 *
 * Before this, `placedSolidForShape` took a result's mesh before its
 * `cadBrep`, so a box with a cylinder cut out of it reported the volume of a
 * faceted bore -- about 0.7% over -- and said `tessellated`, though the cut's
 * exact solid was stored right beside it.
 *
 * Checked by volume and centre of mass against analytic values, never by
 * bounds: a mirrored or turned result keeps the same box size, and only the
 * centre of mass can see it land the wrong way round.
 */
import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";

const CAD_TIMEOUT_MS = 60_000;
const PROJECT = "cut";

function projectWith(shapes: WorkplaneShape[]) {
  let document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Measured cut",
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
    read: async (projectId: string) => projectId === PROJECT ? document : null,
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

// A 20 x 10 x 8 plate at (30, 3, -12) with a radius-3 bore through it, set
// 4 mm along X and 1 mm along Z from the plate's centre so the centre of mass
// moves off it in both directions and a mirror or a turn has something to show.
const PLATE = { width: 20, depth: 10, height: 8, x: 30, z: -12, elevation: 3 };
const BORE = { radius: 3, dx: 4, dz: 1 };
const PLATE_VOLUME = PLATE.width * PLATE.depth * PLATE.height;
const BORE_VOLUME = Math.PI * BORE.radius ** 2 * PLATE.height;
const CUT_VOLUME = PLATE_VOLUME - BORE_VOLUME;
/** The cut's centre of mass, relative to the plate's centre. */
const CUT_OFFSET = { x: -BORE_VOLUME * BORE.dx / CUT_VOLUME, z: -BORE_VOLUME * BORE.dz / CUT_VOLUME };

function plateAndBore() {
  const plate = sceneShape({ id: "plate", name: "plate", kind: "box", color: "#336699", ...PLATE });
  const bore = sceneShape({
    id: "bore", name: "bore", kind: "cylinder", color: "#999999", hole: true,
    width: BORE.radius * 2, depth: BORE.radius * 2, height: PLATE.height + 10,
    x: PLATE.x + BORE.dx, z: PLATE.z + BORE.dz, elevation: PLATE.elevation - 5,
  });
  return [plate, bore];
}

async function cutPlate() {
  const project = projectWith(plateAndBore());
  const group = value(await project.engine.cut(PROJECT, { solidIds: ["plate"], holeIds: ["bore"] })).shape;
  return { ...project, group };
}

const centreY = PLATE.elevation + PLATE.height / 2;

describe("a boolean result is measured from its exact B-rep (#541)", () => {
  it("reports the analytic volume and centre of mass of a box with a bore cut out, and says it is exact", async () => {
    const { engine, group } = await cutPlate();
    expect(group.cadBrep).toBeTruthy();
    expect(group.importedMesh).toBeDefined();

    const properties = value(await engine.properties(PROJECT, group.id));
    expect(properties.volume / CUT_VOLUME).toBeCloseTo(1, 6);
    expect(properties.centerOfMass.x).toBeCloseTo(PLATE.x + CUT_OFFSET.x, 6);
    expect(properties.centerOfMass.y).toBeCloseTo(centreY, 6);
    expect(properties.centerOfMass.z).toBeCloseTo(PLATE.z + CUT_OFFSET.z, 6);
    expect(properties.provenance).toEqual({ source: "brep", precision: "exact" });
  }, CAD_TIMEOUT_MS);

  it("places the B-rep where the result is moved, mirrored and turned", async () => {
    const { engine, group } = await cutPlate();

    value(await engine.changeShape(PROJECT, group.id, { x: 50, z: 7, elevation: -2 }));
    const moved = value(await engine.properties(PROJECT, group.id));
    expect(moved.volume / CUT_VOLUME).toBeCloseTo(1, 6);
    expect(moved.centerOfMass.x).toBeCloseTo(50 + CUT_OFFSET.x, 6);
    expect(moved.centerOfMass.y).toBeCloseTo(-2 + PLATE.height / 2, 6);
    expect(moved.centerOfMass.z).toBeCloseTo(7 + CUT_OFFSET.z, 6);
    expect(moved.provenance).toEqual({ source: "brep", precision: "exact" });

    // A mirror reflects about the shape's own centre, as the viewport does.
    value(await engine.changeShape(PROJECT, group.id, { mirrorX: true }));
    const mirrored = value(await engine.properties(PROJECT, group.id));
    expect(mirrored.volume / CUT_VOLUME).toBeCloseTo(1, 6);
    expect(mirrored.centerOfMass.x).toBeCloseTo(50 - CUT_OFFSET.x, 6);
    expect(mirrored.centerOfMass.z).toBeCloseTo(7 + CUT_OFFSET.z, 6);
    expect(mirrored.provenance.precision).toBe("exact");

    // Mirrored first, then a quarter turn of yaw: (x, z) -> (z, -x) about the centre.
    value(await engine.changeShape(PROJECT, group.id, { rotation: 90 }));
    const turned = value(await engine.properties(PROJECT, group.id));
    expect(turned.volume / CUT_VOLUME).toBeCloseTo(1, 6);
    expect(turned.centerOfMass.x).toBeCloseTo(50 + CUT_OFFSET.z, 6);
    expect(turned.centerOfMass.y).toBeCloseTo(-2 + PLATE.height / 2, 6);
    expect(turned.centerOfMass.z).toBeCloseTo(7 + CUT_OFFSET.x, 6);
    expect(turned.provenance.precision).toBe("exact");

    // A quarter pitch about X, turned about the centre half the height up:
    // (y, z) -> (-z, y), so the Z offset becomes a drop in Y.
    value(await engine.changeShape(PROJECT, group.id, { mirrorX: false, rotation: 0, rotationX: 90 }));
    const pitched = value(await engine.properties(PROJECT, group.id));
    expect(pitched.volume / CUT_VOLUME).toBeCloseTo(1, 6);
    expect(pitched.centerOfMass.x).toBeCloseTo(50 + CUT_OFFSET.x, 6);
    expect(pitched.centerOfMass.y).toBeCloseTo(-2 + PLATE.height / 2 - CUT_OFFSET.z, 6);
    expect(pitched.centerOfMass.z).toBeCloseTo(7, 6);
    expect(pitched.provenance.precision).toBe("exact");
  }, CAD_TIMEOUT_MS);

  it("mirrors before it turns, when a mirror is combined with a pitch or a roll", async () => {
    const { engine, group } = await cutPlate();
    const cx = group.x;
    const cy = (group.elevation ?? 0) + PLATE.height / 2;
    const cz = group.z;

    // Mirrored in X, (dx, 0, dz) -> (-dx, 0, dz); a quarter pitch about X then
    // takes (y, z) -> (-z, y): (-dx, -dz, 0).
    value(await engine.changeShape(PROJECT, group.id, { mirrorX: true, rotationX: 90 }));
    const pitched = value(await engine.properties(PROJECT, group.id));
    expect(pitched.volume / CUT_VOLUME).toBeCloseTo(1, 6);
    expect(pitched.centerOfMass.x).toBeCloseTo(cx - CUT_OFFSET.x, 6);
    expect(pitched.centerOfMass.y).toBeCloseTo(cy - CUT_OFFSET.z, 6);
    expect(pitched.centerOfMass.z).toBeCloseTo(cz, 6);
    expect(pitched.provenance).toEqual({ source: "brep", precision: "exact" });

    // Mirrored in Z, (dx, 0, dz) -> (dx, 0, -dz); a quarter roll about Z then
    // takes (x, y) -> (-y, x): (0, dx, -dz).
    value(await engine.changeShape(PROJECT, group.id, { mirrorX: false, rotationX: 0, mirrorZ: true, rotationZ: 90 }));
    const rolled = value(await engine.properties(PROJECT, group.id));
    expect(rolled.volume / CUT_VOLUME).toBeCloseTo(1, 6);
    expect(rolled.centerOfMass.x).toBeCloseTo(cx, 6);
    expect(rolled.centerOfMass.y).toBeCloseTo(cy + CUT_OFFSET.x, 6);
    expect(rolled.centerOfMass.z).toBeCloseTo(cz - CUT_OFFSET.z, 6);
    expect(rolled.provenance).toEqual({ source: "brep", precision: "exact" });
  }, CAD_TIMEOUT_MS);

  it("measures a revolve with a box cut out of it as the exact half ring", async () => {
    const cutter = sceneShape({ id: "cutter", name: "cutter", kind: "box", color: "#336699", width: 30, depth: 30, height: 20, x: 15, elevation: -5, hole: true });
    const { engine } = projectWith([cutter]);
    const [ring] = value(await engine.addShapes(PROJECT, [
      { kind: "revolve", name: "Ring", profile: [[5, 0], [10, 0], [10, 8], [5, 8]], sides: 24 },
    ])).shapes;
    const group = value(await engine.group(PROJECT, [ring.id, cutter.id])).shape;

    const properties = value(await engine.properties(PROJECT, group.id));
    const halfRing = Math.PI * (10 ** 2 - 5 ** 2) * 8 / 2;
    const halfRingOffset = (4 * (10 ** 3 - 5 ** 3)) / (3 * Math.PI * (10 ** 2 - 5 ** 2));
    expect(properties.volume / halfRing).toBeCloseTo(1, 6);
    expect(properties.centerOfMass.x).toBeCloseTo(ring.x - halfRingOffset, 6);
    expect(properties.centerOfMass.y).toBeCloseTo((ring.elevation ?? 0) + 4, 6);
    expect(properties.centerOfMass.z).toBeCloseTo(ring.z, 6);
    expect(properties.provenance).toEqual({ source: "brep", precision: "exact" });
  }, CAD_TIMEOUT_MS);

  it("feeds the exact solid to interference and to a further cut", async () => {
    const { engine, group } = await cutPlate();
    // A 4 mm slab over the plate's +X end: x 36..40 of the plate's 20..40,
    // which also takes in the part of the bore (x 31..37) that reaches past 36.
    const slab = sceneShape({
      id: "slab", name: "slab", kind: "box", color: "#aa3333",
      width: 8, depth: 20, height: 20, x: 40, z: PLATE.z, elevation: PLATE.elevation - 5,
    });
    value(await engine.addShapes(PROJECT, [{ kind: "box", name: "slab", width: slab.width, depth: slab.depth, height: slab.height, x: slab.x, z: slab.z, elevation: slab.elevation }]));
    const report = value(await engine.interference(PROJECT, {}));
    expect(report.pairs).toHaveLength(1);
    // The circular segment of the bore beyond x = 36: radius 3, centre at
    // 34, so the chord sits 2 mm from the bore's axis.
    const chordDistance = 2;
    const segmentArea = BORE.radius ** 2 * Math.acos(chordDistance / BORE.radius)
      - chordDistance * Math.sqrt(BORE.radius ** 2 - chordDistance ** 2);
    const overlap = (4 * PLATE.depth - segmentArea) * PLATE.height;
    expect(report.pairs[0].overlapVolume / overlap).toBeCloseTo(1, 6);
    expect(report.pairs[0].precision).toBe("exact");

    // Cut the result again, through its -X end: the new cut is made from the
    // first one's exact solid, so it stays exact all the way down.
    const trim = value(await engine.addShapes(PROJECT, [
      { kind: "box", name: "trim", hole: true, width: 10, depth: 20, height: 20, x: PLATE.x - PLATE.width / 2, z: PLATE.z, elevation: PLATE.elevation - 5 },
    ])).shapes[0];
    const recut = value(await engine.cut(PROJECT, { solidIds: [group.id], holeIds: [trim.id] })).shape;
    const recutProperties = value(await engine.properties(PROJECT, recut.id));
    const recutVolume = CUT_VOLUME - 5 * PLATE.depth * PLATE.height;
    expect(recutProperties.volume / recutVolume).toBeCloseTo(1, 6);
    const removedX = PLATE.x - PLATE.width / 2 + 2.5;
    expect(recutProperties.centerOfMass.x).toBeCloseTo(
      (CUT_VOLUME * (PLATE.x + CUT_OFFSET.x) - 5 * PLATE.depth * PLATE.height * removedX) / recutVolume,
      6,
    );
    expect(recutProperties.provenance).toEqual({ source: "brep", precision: "exact" });
    // The stored B-rep of the second cut is itself exact, which it is only if
    // the first cut went in as its B-rep rather than as its triangles.
    const stored = await withCadKernel((cad) => cad.queryBatch([cad.fromBREP(recut.cadBrep!)])[0]!);
    expect(stored.volume / recutVolume).toBeCloseTo(1, 6);
  }, CAD_TIMEOUT_MS);

  it("builds a group record holding the cut from the cut's B-rep, and keeps it exact", async () => {
    const { engine, group } = await cutPlate();
    // A 4 x 10 x 8 block butted against the plate's +X face, grouped with the
    // cut and no hole: a record, measured as its members fused.
    const [block] = value(await engine.addShapes(PROJECT, [
      { kind: "box", name: "block", width: 4, depth: PLATE.depth, height: PLATE.height, x: PLATE.x + PLATE.width / 2 + 2, z: PLATE.z, elevation: PLATE.elevation },
    ])).shapes;
    const record = value(await engine.group(PROJECT, [group.id, block.id])).shape;
    expect(record.cadBrep).toBeFalsy();
    const properties = value(await engine.properties(PROJECT, record.id));
    const blockVolume = 4 * PLATE.depth * PLATE.height;
    const volume = CUT_VOLUME + blockVolume;
    expect(properties.volume / volume).toBeCloseTo(1, 6);
    expect(properties.centerOfMass.x).toBeCloseTo(
      (CUT_VOLUME * (PLATE.x + CUT_OFFSET.x) + blockVolume * (PLATE.x + PLATE.width / 2 + 2)) / volume,
      6,
    );
    expect(properties.provenance).toEqual({ source: "brep", precision: "exact" });
  }, CAD_TIMEOUT_MS);

  it("keeps the mesh path for a result resized after the cut, which the B-rep does not reflect", async () => {
    const { engine, group } = await cutPlate();
    value(await engine.changeShape(PROJECT, group.id, { width: (group.width ?? group.size) * 1.5 }));
    const resized = value(await engine.properties(PROJECT, group.id));
    expect(resized.provenance).toEqual({ source: "mesh", precision: "tessellated" });
    // The faceted bore, stretched: within a percent or two of the analytic
    // stretched cut, but not it.
    expect(resized.volume / (CUT_VOLUME * 1.5)).toBeCloseTo(1, 1);
    expect(Math.abs(resized.volume / (CUT_VOLUME * 1.5) - 1)).toBeGreaterThan(1e-4);
  }, CAD_TIMEOUT_MS);

  it("keeps the mesh path for a resize of well under a tenth of a percent", async () => {
    const { engine, group } = await cutPlate();
    // 20 -> 20.015 mm: 0.075%, which a tolerance relative to the size would
    // wave through, measuring the stale B-rep and calling it exact.
    value(await engine.changeShape(PROJECT, group.id, { width: (group.width ?? group.size) + 0.015 }));
    const resized = value(await engine.properties(PROJECT, group.id));
    expect(resized.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  }, CAD_TIMEOUT_MS);

  it("reports a resized group record holding a cut as the triangles it was built from", async () => {
    const { engine, group } = await cutPlate();
    const [block] = value(await engine.addShapes(PROJECT, [
      { kind: "box", name: "block", width: 4, depth: PLATE.depth, height: PLATE.height, x: PLATE.x + PLATE.width / 2 + 2, z: PLATE.z, elevation: PLATE.elevation },
    ])).shapes;
    const record = value(await engine.group(PROJECT, [group.id, block.id])).shape;
    // Stretching the record stretches the cut inside it, which its B-rep does
    // not follow, so the cut is sewn from its mesh and the record says so.
    value(await engine.changeShape(PROJECT, record.id, { width: (record.width ?? record.size) * 1.5 }));
    const properties = value(await engine.properties(PROJECT, record.id));
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
    const stretched = (CUT_VOLUME + 4 * PLATE.depth * PLATE.height) * 1.5;
    expect(properties.volume / stretched).toBeCloseTo(1, 1);
    expect(Math.abs(properties.volume / stretched - 1)).toBeGreaterThan(1e-4);
  }, CAD_TIMEOUT_MS);

  it("keeps the mesh path for a stored B-rep with the mesh's box but not its volume", async () => {
    // A cut with a wide bore, and in place of its B-rep the uncut plate: the
    // same box exactly, so only the volume can tell them apart.
    const plate = sceneShape({ id: "plate", name: "plate", kind: "box", color: "#336699", ...PLATE });
    const bore = sceneShape({
      id: "bore", name: "bore", kind: "cylinder", color: "#999999", hole: true,
      width: 9, depth: 9, height: PLATE.height + 10, x: PLATE.x, z: PLATE.z, elevation: PLATE.elevation - 5,
    });
    const { engine } = projectWith([plate, bore]);
    const group = value(await engine.cut(PROJECT, { solidIds: ["plate"], holeIds: ["bore"] })).shape;
    const exact = await shapeProperties(group);
    expect(exact.provenance).toEqual({ source: "brep", precision: "exact" });

    const uncut = await withCadKernel((cad) => cad.toBREP(cad.translate(cad.makeBox(PLATE.width, PLATE.height, PLATE.depth), -PLATE.width / 2, 0, -PLATE.depth / 2)));
    const stale = await shapeProperties({ ...group, cadBrep: uncut });
    expect(stale.provenance).toEqual({ source: "mesh", precision: "tessellated" });
    expect(stale.volume / exact.volume).toBeCloseTo(1, 1);
  }, CAD_TIMEOUT_MS);

  it("keeps the mesh path for a result whose stored B-rep does not match its mesh", async () => {
    const { group } = await cutPlate();
    // A B-rep of some other solid entirely: a 2 mm cube. A result carrying
    // geometry like this has been edited without its B-rep being cleared, and
    // the mesh is what is on screen.
    const stray = await withCadKernel((cad) => cad.toBREP(cad.makeBox(2, 2, 2)));
    const properties = await shapeProperties({ ...group, cadBrep: stray });
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
    expect(properties.volume / CUT_VOLUME).toBeCloseTo(1, 1);
  }, CAD_TIMEOUT_MS);

  it("keeps the mesh path for a cut made from a mesh operand, whose B-rep is only as good as the triangles", async () => {
    const [plate, bore] = plateAndBore();
    // The plate as a mesh: twelve triangles of the same box, in its own frame.
    const { width: w, depth: d, height: h } = PLATE;
    const corners = [
      [-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2],
      [-w / 2, h, -d / 2], [w / 2, h, -d / 2], [w / 2, h, d / 2], [-w / 2, h, d / 2],
    ];
    const quads = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
    const positions = quads.flatMap(([a, b, c, e]) => [a, b, c, a, c, e].flatMap((index) => corners[index]));
    const meshPlate: WorkplaneShape = {
      ...plate,
      kind: "mesh",
      importedMesh: { positions, baseWidth: w, baseDepth: d, baseHeight: h, triangleCount: 12, sourceFormat: "stl" },
    };
    const { engine } = projectWith([meshPlate, bore]);
    const group = value(await engine.cut(PROJECT, { solidIds: ["plate"], holeIds: ["bore"] })).shape;
    expect(group.cadBrep).toBeTruthy();
    const properties = value(await engine.properties(PROJECT, group.id));
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  }, CAD_TIMEOUT_MS);
});
