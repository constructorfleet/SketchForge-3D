import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { unrotatedSolidForShape } from "@constructorfleet/sketchforge-engine/cadSolids";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { applyEdgeTreatment, shapeWithCadResult } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { applyShell } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// #413: a fillet, chamfer or shell stores its result as a mesh in the shape's
// own frame and clears `mirrorX/Y/Z`, but the solid it treated was built
// without the mirror -- so a mirrored shape came back as its unmirrored self
// and the operation reported success. These tests compare where the shape's
// material is drawn before and after, by volume and centre of mass: a bounding
// box cannot see a reflection.

type Vec = { x: number; y: number; z: number };

/**
 * How the viewport places a shape's local geometry (`updateShapeObjectTransform`):
 * translate to its centre, rotate by Euler XYZ, then mirror -- so the mirror is
 * applied first, in the shape's own frame, about its mid-height for Y.
 */
function drawnPoint(shape: WorkplaneShape, local: Vec): Vec {
  const centerY = shape.height / 2;
  const point = new THREE.Vector3(local.x, local.y - centerY, local.z)
    .multiply(new THREE.Vector3(shape.mirrorX ? -1 : 1, shape.mirrorY ? -1 : 1, shape.mirrorZ ? -1 : 1))
    .applyEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shape.rotation ?? 0),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ));
  return { x: point.x + shape.x, y: point.y + (shape.elevation ?? 0) + centerY, z: point.z + shape.z };
}

/** Signed volume and centre of mass of a closed triangle soup; an inside-out mesh has negative volume. */
function meshProperties(positions: readonly number[]) {
  let volume = 0;
  const moment = { x: 0, y: 0, z: 0 };
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(index, index + 9) as [number, number, number, number, number, number, number, number, number];
    const signed = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    volume += signed;
    moment.x += signed * (ax + bx + cx) / 4;
    moment.y += signed * (ay + by + cy) / 4;
    moment.z += signed * (az + bz + cz) / 4;
  }
  return { volume, center: { x: moment.x / volume, y: moment.y / volume, z: moment.z / volume } };
}

function distance(a: Vec, b: Vec) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Where the treated shape's material is drawn, from the mesh the viewport draws. */
function drawnResult(treated: WorkplaneShape) {
  const mesh = meshProperties(treated.importedMesh!.positions);
  return { volume: mesh.volume, center: drawnPoint(treated, mesh.center) };
}

const unmirrored = (shape: WorkplaneShape) => ({ ...shape, mirrorX: undefined, mirrorY: undefined, mirrorZ: undefined });

/**
 * An L-shaped block stored as exact geometry, as a shape is after a previous
 * treatment or a STEP import: 30 wide, a 6-high foot and a 20-high tower at +X,
 * so its centre of mass is off-centre in both X and Y.
 */
async function storedLBlock(fields: Partial<WorkplaneShape>) {
  const { brep, volume, center } = await withCadKernel((cad) => {
    const outline: [number, number][] = [[-15, 0], [15, 0], [15, 20], [7, 20], [7, 6], [-15, 6]];
    const wire = cad.makeWire(outline.map(([x, y], index) => {
      const [nx, ny] = outline[(index + 1) % outline.length]!;
      return cad.makeLineEdge({ x, y, z: -10 }, { x: nx, y: ny, z: -10 });
    }));
    const solid = cad.extrude(cad.makeFace(wire), 0, 0, 20);
    return { brep: cad.toBREP(solid), volume: cad.getVolume(solid), center: cad.getCenterOfMass(solid) };
  });
  const shape = {
    ...shapeFromRequest({ kind: "box", width: 30, depth: 20, height: 20 }),
    kind: "mesh",
    cadBrep: brep,
    ...fields,
  } as WorkplaneShape;
  return { shape, volume, center };
}

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Mirrored treatments",
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
  return {
    read: async (projectId: string) => projectId === "mirror" ? structuredClone(document) : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      writes += 1;
      document.shapes = structuredClone(shapes);
      document.metadata.revision = writes;
      return { revision: writes };
    },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("edge treatments on a mirrored shape (#413)", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("fillets a mirrored, turned shape stored as exact geometry on its mirrored side", async () => {
    const { shape, volume, center } = await storedLBlock({ x: 50, z: -10, elevation: 5, rotation: 40, mirrorX: true, mirrorY: true });
    const expected = drawnPoint(shape, center);
    const wrongSide = drawnPoint(unmirrored(shape), center);
    // The two candidates are far apart, so landing near one is a real answer.
    expect(distance(expected, wrongSide)).toBeGreaterThan(8);

    const treated = shapeWithCadResult(shape, await applyEdgeTreatment(shape, { kind: "fillet", amount: 0.5 }));
    const drawn = drawnResult(treated);

    expect(treated).toMatchObject({ mirrorX: undefined, mirrorY: undefined, mirrorZ: undefined, rotation: 40 });
    // A 0.5mm fillet takes a little material and leaves the solid right way out.
    expect(drawn.volume).toBeGreaterThan(volume * 0.97);
    expect(drawn.volume).toBeLessThan(volume);
    expect(distance(drawn.center, expected)).toBeLessThan(0.2);
  });

  it("chamfers a mirrored stored shape on its mirrored side", async () => {
    const { shape, volume, center } = await storedLBlock({ x: -20, z: 30, mirrorZ: true, mirrorX: true });
    const expected = drawnPoint(shape, center);

    const treated = shapeWithCadResult(shape, await applyEdgeTreatment(shape, { kind: "chamfer", amount: 0.5 }));
    const drawn = drawnResult(treated);

    expect(drawn.volume).toBeGreaterThan(volume * 0.97);
    expect(drawn.volume).toBeLessThan(volume);
    expect(distance(drawn.center, expected)).toBeLessThan(0.2);
    // Mirrored in X, the tower is drawn on the -X side of the shape's centre.
    expect(drawn.center.x).toBeLessThan(shape.x - 3);
  });

  it("hollows a mirrored stored shape on its mirrored side", async () => {
    const { shape, center } = await storedLBlock({ x: 10, mirrorY: true });
    const expected = drawnPoint(shape, center);
    const wrongSide = drawnPoint(unmirrored(shape), center);

    const treated = shapeWithCadResult(shape, await applyShell(shape, { thickness: 1 }));
    const drawn = drawnResult(treated);

    expect(drawn.volume).toBeGreaterThan(0);
    // A hollow redistributes material, so it is judged by which side it lands on.
    expect(distance(drawn.center, expected)).toBeLessThan(distance(drawn.center, wrongSide) / 4);
  });

  it("fillets a mirrored revolve on its mirrored side", async () => {
    // A tapered ring, wide at one end of its profile and narrow at the other,
    // so most of its material is at one end and a Y mirror moves it.
    const engine = createEngine(projectStore());
    const created = value(await engine.addShapes("mirror", [{
      kind: "revolve", name: "Tapered ring", profile: [[2, -2], [4, -2], [2.5, 2], [2, 2]], sides: 24,
    } as never])).shapes[0]!;
    expect(created.sketchOperation).toBe("revolve");
    const shape = { ...created, x: 5, z: 7, elevation: 2, mirrorY: true } as WorkplaneShape;
    const source = meshProperties(shape.importedMesh!.positions);
    const expected = drawnPoint(shape, source.center);
    const wrongSide = drawnPoint(unmirrored(shape), source.center);
    expect(Math.abs(expected.y - wrongSide.y)).toBeGreaterThan(0.5);

    const treated = shapeWithCadResult(shape, await applyEdgeTreatment(shape, { kind: "fillet", amount: 0.2 }));
    const drawn = drawnResult(treated);

    expect(drawn.volume).toBeGreaterThan(0);
    expect(drawn.center.x).toBeCloseTo(shape.x, 1);
    expect(drawn.center.z).toBeCloseTo(shape.z, 1);
    expect(Math.abs(drawn.center.y - expected.y)).toBeLessThan(0.1);
  });

  it("fillets a mirrored, turned parametric shape mirrored before it is turned", async () => {
    // A wedge's material is mostly at its tall +X end. Yawed 30 degrees, the
    // editor mirrors it in its own frame and then turns it; doing those the
    // other way round lands the material 5mm away in Z.
    // The mirror is set on the shape rather than in the request, which does not take one.
    const shape = {
      ...shapeFromRequest({ kind: "wedge", width: 30, depth: 18, height: 12, x: 14, z: -7, elevation: 3, rotation: 30 }),
      mirrorX: true,
    } as WorkplaneShape;
    const { volume, center } = await withCadKernel((cad) => {
      const solid = unrotatedSolidForShape(cad, shape);
      return { volume: cad.getVolume(solid), center: cad.getCenterOfMass(solid) };
    });
    const expected = drawnPoint(shape, center);
    const wrongSide = drawnPoint(unmirrored(shape), center);
    expect(distance(expected, wrongSide)).toBeGreaterThan(8);

    const treated = shapeWithCadResult(shape, await applyEdgeTreatment(shape, { kind: "fillet", amount: 0.2 }));
    const drawn = drawnResult(treated);

    expect(treated).toMatchObject({ mirrorX: undefined, rotation: 0 });
    expect(drawn.volume).toBeGreaterThan(volume * 0.97);
    expect(drawn.volume).toBeLessThan(volume);
    // Rounding the wedge's thin edge trims its bounds at that end, which shifts
    // the recentred result a few tenths; the wrong order is 5mm away.
    expect(distance(drawn.center, expected)).toBeLessThan(0.6);
  });
});
