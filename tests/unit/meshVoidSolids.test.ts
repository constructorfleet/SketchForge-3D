import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { solidFromMeshPositions, ServerCadError } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { checkInterference } from "@constructorfleet/sketchforge-engine/serverCadInterference";
import { buildGroupFromSelection } from "@constructorfleet/sketchforge-engine/serverShapeBooleans";
import { sectionShapesToSvg } from "@constructorfleet/sketchforge-engine/serverCadSection";
import { projectShapesToSvg } from "@constructorfleet/sketchforge-engine/serverCadProjection";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

// #501: a watertight mesh with a sealed internal void (a float, a pressure
// vessel, a group of a solid and an enclosed hole) was refused by every exact
// path with "is not a closed solid, so it cannot be filleted".

type Vec3 = [number, number, number];

/** An axis-aligned box's 12 triangles, outward-wound unless `inward`. */
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

function measure(positions: number[]) {
  return withCadKernel((cad) => {
    const solid = solidFromMeshPositions(cad, positions);
    return {
      volume: cad.getVolume(solid),
      center: cad.getCenterOfMass(solid),
      valid: Boolean(cad.isValid(solid)),
    };
  });
}

/** A 20 mm cube centred on the origin, less a 10 mm cube void off-centre in X, as the issue's STL. */
function hollowCube(innerInward = true) {
  return [...boxTriangles([-10, 0, -10], [10, 20, 10]), ...boxTriangles([-2, 5, -5], [8, 15, 5], innerInward)];
}

/** A stored mesh shape whose local triangles are `positions`, placed at (x, elevation, z). */
function meshShape(id: string, positions: number[], placement: { x?: number; elevation?: number; z?: number } = {}): WorkplaneShape {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((value, index) => {
    min[index % 3] = Math.min(min[index % 3], value);
    max[index % 3] = Math.max(max[index % 3], value);
  });
  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const depth = max[2] - min[2];
  return {
    ...sceneShape({
      id,
      name: id,
      kind: "mesh",
      color: "#123456",
      width,
      depth,
      height,
      importedMesh: { positions, baseWidth: width, baseDepth: depth, baseHeight: height, triangleCount: positions.length / 9, sourceFormat: "stl" },
    }),
    ...placement,
  };
}

// The cube's material: 8000 - 1000 mm^3, with the void's centroid at x=3, y=10.
const HOLLOW_VOLUME = 7000;
const HOLLOW_CENTER_X = (8000 * 0 - 1000 * 3) / 7000;

describe("mesh solids with an internal void (#501)", () => {
  it.each([
    ["wound inward, as an exporter writes a cavity", true],
    ["wound outward, a cavity only by nesting", false],
  ])("sews a hollow cube whose void is %s", async (_label, inward) => {
    const measured = await measure(hollowCube(inward));

    expect(measured.volume).toBeCloseTo(HOLLOW_VOLUME, 3);
    expect(measured.center.x).toBeCloseTo(HOLLOW_CENTER_X, 4);
    expect(measured.center.y).toBeCloseTo(10, 4);
    expect(measured.center.z).toBeCloseTo(0, 4);
    expect(measured.valid).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a solid island inside the void", async () => {
    // Outer 20 cube, a 12 cube void, and a 4 cube floating in the void at x=+2.
    const positions = [
      ...boxTriangles([-10, 0, -10], [10, 20, 10]),
      ...boxTriangles([-6, 4, -6], [6, 16, 6], true),
      ...boxTriangles([0, 8, -2], [4, 12, 2]),
    ];
    const measured = await measure(positions);

    const volume = 8000 - 1728 + 64;
    expect(measured.volume).toBeCloseTo(volume, 3);
    expect(measured.center.x).toBeCloseTo((64 * 2) / volume, 4);
    expect(measured.center.y).toBeCloseTo(10, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("sews separate closed shells as separate bodies", async () => {
    const positions = [...boxTriangles([-10, 0, -2], [-6, 4, 2]), ...boxTriangles([6, 0, -1], [8, 2, 1])];
    const measured = await measure(positions);

    expect(measured.volume).toBeCloseTo(72, 4);
    expect(measured.center.x).toBeCloseTo((64 * -8 + 8 * 7) / 72, 4);
    expect(measured.center.y).toBeCloseTo((64 * 2 + 8 * 1) / 72, 4);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses an open mesh without mentioning a fillet nobody asked for", async () => {
    const open = boxTriangles([-1, 0, -1], [1, 2, 1]).slice(0, 9 * 11);
    const failure = await withCadKernel((cad) => {
      try {
        solidFromMeshPositions(cad, open);
        return null;
      } catch (error) {
        return error;
      }
    });

    expect(failure).toBeInstanceOf(ServerCadError);
    expect((failure as Error).message).toMatch(/not a closed solid/);
    expect((failure as Error).message).not.toMatch(/fillet/i);
  }, CAD_TEST_TIMEOUT_MS);

  describe("through the tools that refused it", () => {
    const hollow = () => meshShape("hollow", hollowCube(), { x: 0, elevation: 0, z: 0 });

    it("reports shape properties with the void subtracted", async () => {
      const properties = await shapeProperties(hollow());

      expect(properties.volume).toBeCloseTo(HOLLOW_VOLUME, 3);
      expect(properties.isValid).toBe(true);
    }, CAD_TEST_TIMEOUT_MS);

    it("checks interference against the material, not the cavity", async () => {
      // A 2 mm cube sitting entirely in the void touches no material at all.
      const inVoid = sceneShape({ id: "in-void", name: "In void", kind: "box", color: "#654321", width: 2, depth: 2, height: 2 });
      const floating = { ...inVoid, x: 3, elevation: 9, z: 0 };
      // A 4 mm cube straddling the +Z wall (z 8..12) overlaps 4x4x2 of material.
      const straddling = { ...inVoid, id: "wall", name: "Wall", width: 4, depth: 4, height: 4, x: -6, elevation: 8, z: 10 };

      const result = await checkInterference([hollow(), floating, straddling]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const overlap = (other: string) => result.value.pairs.find((pair) => [pair.a.id, pair.b.id].includes("hollow") && [pair.a.id, pair.b.id].includes(other));
      expect(overlap("wall")?.overlapVolume).toBeCloseTo(32, 3);
      expect(overlap("in-void")?.overlapVolume ?? 0).toBeCloseTo(0, 6);
    }, CAD_TEST_TIMEOUT_MS);

    it("cuts a hole through the wall and into the void", async () => {
      // A 4 mm square bore along Y through the void's centre: it removes the
      // material above and below the void, 4*4*(5 + 5) = 160 mm^3.
      const bore = { ...sceneShape({ id: "bore", name: "Bore", kind: "box", color: "#000000", width: 4, depth: 4, height: 30 }), x: 3, elevation: -5, z: 0, hole: true };

      const outcome = await buildGroupFromSelection([hollow(), bore]);

      expect("group" in outcome).toBe(true);
      if (!("group" in outcome) || !outcome.group) return;
      const properties = await shapeProperties(outcome.group);
      expect(properties.volume).toBeCloseTo(HOLLOW_VOLUME - 160, 2);
      expect(properties.centerOfMass.y).toBeCloseTo(10, 3);
      expect(properties.isValid).toBe(true);
    }, CAD_TEST_TIMEOUT_MS);

    it("cuts again into a group that sealed a hole inside a solid", async () => {
      // The issue's own recipe: group a solid with a fully enclosed hole, then
      // cut the result. The first step succeeded and stored a two-shell mesh;
      // the second was refused.
      const block = sceneShape({ id: "block", name: "Block", kind: "box", color: "#123456", width: 20, depth: 20, height: 20 });
      const chamber = { ...sceneShape({ id: "chamber", name: "Chamber", kind: "box", color: "#123456", width: 10, depth: 10, height: 10 }), elevation: 5, hole: true };
      const sealed = await buildGroupFromSelection([block, chamber]);
      expect("group" in sealed && sealed.group).toBeTruthy();
      if (!("group" in sealed) || !sealed.group) return;
      expect((await shapeProperties(sealed.group)).volume).toBeCloseTo(7000, 2);

      // A 4 mm bore along Y at x=7.5 runs through the wall beside the chamber: 4*4*20.
      const bore = { ...sceneShape({ id: "bore", name: "Bore", kind: "box", color: "#000000", width: 4, depth: 4, height: 30 }), x: 7.5, elevation: -5, z: 0, hole: true };
      const cut = await buildGroupFromSelection([sealed.group, bore]);

      expect("group" in cut ? null : cut).toBeNull();
      if (!("group" in cut) || !cut.group) return;
      const properties = await shapeProperties(cut.group);
      expect(properties.volume).toBeCloseTo(7000 - 320, 2);
      expect(properties.centerOfMass.x).toBeCloseTo((-320 * 7.5) / (7000 - 320), 3);
      expect(properties.centerOfMass.y).toBeCloseTo(10, 3);
    }, CAD_TEST_TIMEOUT_MS);

    it("draws a section through the void", async () => {
      const svg = await sectionShapesToSvg([hollow()], { plane: "xy", offset: 0 });

      expect(svg).toContain("<svg");
    }, CAD_TEST_TIMEOUT_MS);

    it("draws a hidden-line projection, as project_view and capture_image do", async () => {
      const svg = await projectShapesToSvg([hollow()]);

      expect(svg).toContain("<svg");
    }, CAD_TEST_TIMEOUT_MS);
  });
});
