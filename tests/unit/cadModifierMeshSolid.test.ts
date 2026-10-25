/**
 * The editor's CAD modifier rebuilding a stored mesh part as a solid (#527).
 *
 * A watertight mesh with a sealed internal void -- a group that sealed a hole
 * inside a solid, or an imported hollow STL -- has two closed shells. Sewn as
 * one, OCCT could make no solid of it and the editor refused to fillet,
 * chamfer or cut it, although the server (#501) already took it.
 *
 * Measured by volume and centre of mass: a void that is dropped, filled, or
 * read as a separate body leaves the bounding box exactly as it was.
 */

import { describe, expect, it } from "vitest";
import type { OcctKernel } from "occt-wasm";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { LocalizedError } from "@/i18n/LocalizedError";
import { meshPartSolid } from "@/lib/cadModifierMeshSolid";
import { buildEditorShell } from "@/lib/engine/editorShell";
import { interferenceBetweenSolids, sampledWallThickness } from "@/lib/engine/cadAnalysis";
import type { CadModifierMeshPart } from "@/lib/cadModifierTypes";

type Vec3 = [number, number, number];

/** An axis-aligned box's 12 triangles as flat corners, outward-wound unless `inward`. */
function boxTriangles(min: Vec3, max: Vec3, inward = false): number[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces: Vec3[] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ];
  return faces.flatMap(([a, b, c]) => (inward ? [a, c, b] : [a, b, c]).flatMap((index) => v[index]));
}

/** A mesh part as the editor sends one: unwelded corners and an index per corner. */
function meshPart(corners: number[]): CadModifierMeshPart {
  return {
    positions: new Float32Array(corners),
    indices: Uint32Array.from({ length: corners.length / 3 }, (_, index) => index),
    hole: false,
  };
}

/** A 20 mm cube on the ground, less a 10 mm cube void off-centre in X. */
function hollowCube(innerInward = true) {
  return meshPart([...boxTriangles([-10, 0, -10], [10, 20, 10]), ...boxTriangles([-2, 5, -5], [8, 15, 5], innerInward)]);
}

// 8000 - 1000 mm^3, with the void's centroid at x=3, y=10.
const HOLLOW_VOLUME = 7000;
const HOLLOW_CENTER_X = (8000 * 0 - 1000 * 3) / 7000;

function attempt<T>(run: (cad: OcctKernel) => T) {
  return withCadKernel((cad) => {
    try {
      return run(cad);
    } catch (error) {
      return error;
    }
  });
}

describe("the CAD modifier's mesh part solids (#527)", () => {
  it.each([
    ["wound inward, as an exporter writes a cavity", true],
    ["wound outward, a cavity only by nesting", false],
  ])("rebuilds a hollow cube whose void is %s", async (_label, inward) => {
    const measured = await attempt((cad) => {
      const solid = meshPartSolid(cad, hollowCube(inward));
      return { volume: cad.getVolume(solid), center: cad.getCenterOfMass(solid), valid: Boolean(cad.isValid(solid)) };
    });

    expect(measured).not.toBeInstanceOf(Error);
    const { volume, center, valid } = measured as { volume: number; center: { x: number; y: number; z: number }; valid: boolean };
    expect(volume).toBeCloseTo(HOLLOW_VOLUME, 3);
    expect(center.x).toBeCloseTo(HOLLOW_CENTER_X, 4);
    expect(center.y).toBeCloseTo(10, 4);
    expect(center.z).toBeCloseTo(0, 4);
    expect(valid).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("fillets an outer edge of the hollow cube and keeps the void", async () => {
    // The edge along X at the top front (y=20, z=10). A fillet of radius r on
    // a right-angled edge of length L removes (1 - pi/4) r^2 L.
    const radius = 2;
    const measured = await attempt((cad) => {
      const solid = meshPartSolid(cad, hollowCube());
      const edge = cad.getSubShapes(solid, "edge").find((handle) => {
        const box = cad.getBoundingBox(handle);
        return Math.abs(box.ymin - 20) < 1e-6 && Math.abs(box.zmin - 10) < 1e-6 && box.xmax - box.xmin > 19;
      });
      if (edge === undefined) throw new Error("no top front edge");
      const filleted = cad.fillet(solid, [edge], radius);
      return { volume: cad.getVolume(filleted), center: cad.getCenterOfMass(filleted), valid: Boolean(cad.isValid(filleted)) };
    });

    expect(measured).not.toBeInstanceOf(Error);
    const { volume, center, valid } = measured as { volume: number; center: { x: number; y: number; z: number }; valid: boolean };
    const removed = (1 - Math.PI / 4) * radius * radius * 20;
    expect(volume).toBeCloseTo(HOLLOW_VOLUME - removed, 2);
    // Taken from the whole width at x=0, so x only scales by the lost volume.
    expect(center.x).toBeCloseTo((HOLLOW_VOLUME * HOLLOW_CENTER_X) / (HOLLOW_VOLUME - removed), 3);
    // The removed spandrel's centroid sits this far in from the edge along
    // both y and z: the corner square less the quarter disc, by moments.
    const inset = (radius ** 3 / 2 - (Math.PI * radius ** 2 / 4) * (radius - (4 * radius) / (3 * Math.PI))) / ((1 - Math.PI / 4) * radius ** 2);
    expect(center.y).toBeCloseTo((HOLLOW_VOLUME * 10 - removed * (20 - inset)) / (HOLLOW_VOLUME - removed), 3);
    expect(center.z).toBeCloseTo((HOLLOW_VOLUME * 0 - removed * (10 - inset)) / (HOLLOW_VOLUME - removed), 3);
    expect(valid).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("still rebuilds a single closed shell", async () => {
    const measured = await attempt((cad) => {
      const solid = meshPartSolid(cad, meshPart(boxTriangles([0, 0, 0], [4, 2, 3])));
      return { volume: cad.getVolume(solid), center: cad.getCenterOfMass(solid) };
    });

    expect(measured).not.toBeInstanceOf(Error);
    const { volume, center } = measured as { volume: number; center: { x: number; y: number; z: number } };
    expect(volume).toBeCloseTo(24, 4);
    expect(center.x).toBeCloseTo(2, 4);
    expect(center.y).toBeCloseTo(1, 4);
    expect(center.z).toBeCloseTo(1.5, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it.each([
    ["one body's corner inside the other", [0, 0, 0] as Vec3, [5, 5, 5] as Vec3],
    ["side by side, sharing a slab", [0, 0, 0] as Vec3, [5, 0, 0] as Vec3],
  ])("refuses two closed bodies that overlap without nesting: %s", async (_label, a, b) => {
    const cube = (at: Vec3) => boxTriangles(at, [at[0] + 10, at[1] + 10, at[2] + 10]);
    const failure = await attempt((cad) => {
      const solid = meshPartSolid(cad, meshPart([...cube(a), ...cube(b)]));
      return { volume: cad.getVolume(solid) };
    });

    expect(failure).toBeInstanceOf(LocalizedError);
    expect((failure as LocalizedError).key).toBe("errors.cadModifier.meshShellsOverlap");
  }, CAD_TEST_TIMEOUT_MS);

  it("still refuses an open mesh as not manifold", async () => {
    const open = boxTriangles([-1, 0, -1], [1, 2, 1]).slice(0, 9 * 11);
    const failure = await attempt((cad) => meshPartSolid(cad, meshPart(open)));

    expect(failure).toBeInstanceOf(LocalizedError);
    expect((failure as LocalizedError).key).toBe("errors.cadModifier.meshNotManifold");
  }, CAD_TEST_TIMEOUT_MS);

  // The single-part callers below never saw more than one shell from the old
  // worker, which refused every multi-shell mesh outright.
  describe("through the worker's single-part tools", () => {
    /** Two separate cubes: 4 mm at x -10..-6 and 2 mm at x 6..8, 12 mm apart. */
    const separateBodies = () => meshPart([...boxTriangles([-10, 0, -2], [-6, 4, 2]), ...boxTriangles([6, 0, -1], [8, 2, 1])]);
    /** A 40 mm cube with a centred 10 mm void. */
    const centredVoid = () => meshPart([...boxTriangles([-20, 0, -20], [20, 40, 20]), ...boxTriangles([-5, 15, -5], [5, 25, 5], true)]);

    it.each([
      ["the hollow cube", () => hollowCube(), 0.5],
      ["a 40 mm cube with a centred void, thin wall", () => centredVoid(), 0.5],
      ["a 40 mm cube with a centred void, thick wall", () => centredVoid(), 2],
      ["two separate bodies", () => separateBodies(), 0.5],
    ])("refuses to hollow %s, saying why", async (_label, part, thickness) => {
      const failure = await attempt((cad) => buildEditorShell(cad, meshPartSolid(cad, part()), { thickness, openFaces: [] }));

      expect(failure).toBeInstanceOf(LocalizedError);
      expect((failure as LocalizedError).key).toBe("errors.cadModifier.shell.severalShells");
    }, CAD_TEST_TIMEOUT_MS);

    it("measures wall thickness within each body, not across the gap between them", async () => {
      // 1 mm apart: a gap thinner than either body must not read as a wall.
      const close = meshPart([...boxTriangles([0, 0, 0], [4, 4, 4]), ...boxTriangles([5, 0, 0], [8, 4, 4])]);
      const measured = await attempt((cad) => sampledWallThickness(cad, meshPartSolid(cad, close)));

      expect(measured).not.toBeInstanceOf(Error);
      expect((measured as { minimum: number | null }).minimum).toBeCloseTo(3, 6);
    }, CAD_TEST_TIMEOUT_MS);

    it("measures the hollow cube's thinnest wall, between the outside and the void", async () => {
      // The void spans x -2..8 in a cube spanning -10..10: the +X wall is 2 mm.
      const measured = await attempt((cad) => sampledWallThickness(cad, meshPartSolid(cad, hollowCube())));

      expect(measured).not.toBeInstanceOf(Error);
      expect((measured as { minimum: number | null }).minimum).toBeCloseTo(2, 6);
    }, CAD_TEST_TIMEOUT_MS);

    it("checks interference against each body and not the gap between them", async () => {
      const result = await attempt((cad) => {
        const operands = [
          { id: "bodies", name: "Bodies", tessellated: true, solid: () => meshPartSolid(cad, separateBodies()) },
          // In the gap between the bodies, inside their combined bounding box.
          { id: "gap", name: "Gap", tessellated: false, solid: () => cad.makeBoxFromCorners({ x: -2, y: 0, z: -1 }, { x: 2, y: 2, z: 1 }) },
          // Overlapping the 2 mm cube by 1 x 2 x 2 at x 7..8.
          { id: "overlap", name: "Overlap", tessellated: false, solid: () => cad.makeBoxFromCorners({ x: 7, y: 0, z: -1 }, { x: 9, y: 2, z: 1 }) },
        ];
        return interferenceBetweenSolids(cad, operands, (operand) => operand.solid());
      });

      expect(result).not.toBeInstanceOf(Error);
      const report = result as ReturnType<typeof interferenceBetweenSolids>;
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const pair = (other: string) => report.value.pairs.find((entry) => [entry.a.id, entry.b.id].includes("bodies") && [entry.a.id, entry.b.id].includes(other));
      expect(pair("overlap")?.overlapVolume).toBeCloseTo(4, 4);
      expect(pair("gap")).toBeUndefined();
    }, CAD_TEST_TIMEOUT_MS);
  });
});
