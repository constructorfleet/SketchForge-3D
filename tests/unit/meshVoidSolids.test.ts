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

/** Each `M...` subpath of every path in an SVG, as its points. */
function svgSubpaths(svg: string): [number, number][][] {
  return [...svg.matchAll(/ d="([^"]+)"/g)].flatMap((path) =>
    path[1].split("M").filter(Boolean).map((sub) =>
      [...sub.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m): [number, number] => [Number(m[1]), Number(m[2])])));
}

/** A loop's distinct corner points in a fixed order: collinear midpoints dropped, so loops compare by shape. */
function sortedCorners(points: [number, number][]) {
  const distinct = [...new Map(points.map((p) => [p.join(","), p])).values()];
  const isCorner = (p: [number, number]) => {
    const xs = distinct.map((q) => q[0]);
    const ys = distinct.map((q) => q[1]);
    return (p[0] === Math.min(...xs) || p[0] === Math.max(...xs)) && (p[1] === Math.min(...ys) || p[1] === Math.max(...ys));
  };
  return distinct.filter(isCorner).map((p) => p.join(",")).sort();
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

  it.each([
    // A pokes its corner into B: A's extreme vertex along the nesting ray lies
    // inside B, so by parity alone A reads as B's void (review of #522).
    ["one body's corner inside the other", [0, 0, 0] as Vec3, [5, 5, 5] as Vec3],
    // Overlapping along X only: neither extreme vertex is inside the other.
    ["side by side, sharing a slab", [0, 0, 0] as Vec3, [5, 0, 0] as Vec3],
  ])("refuses closed shells that overlap without nesting: %s", async (_label, a, b) => {
    const cube = (at: Vec3) => boxTriangles(at, [at[0] + 10, at[1] + 10, at[2] + 10]);
    const failure = await withCadKernel((cad) => {
      try {
        const solid = solidFromMeshPositions(cad, [...cube(a), ...cube(b)]);
        return { volume: cad.getVolume(solid), center: cad.getCenterOfMass(solid) };
      } catch (error) {
        return error;
      }
    });

    // Not B less A (875 mm^3), and not a silent union either: the mesh's own
    // signed volume disagrees with any solid the kernel could assemble.
    expect(failure).toBeInstanceOf(ServerCadError);
    expect((failure as Error).message).toMatch(/overlap/);
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
      expect(properties.centerOfMass.x).toBeCloseTo(HOLLOW_CENTER_X, 4);
      expect(properties.centerOfMass.y).toBeCloseTo(10, 4);
      expect(properties.centerOfMass.z).toBeCloseTo(0, 4);
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
      // The bore is off-centre at x=3, so x is what a misplaced cut would move.
      expect(properties.centerOfMass.x).toBeCloseTo((HOLLOW_VOLUME * HOLLOW_CENTER_X - 160 * 3) / (HOLLOW_VOLUME - 160), 3);
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

    it("cuts again into a group that sealed a curved chamber, as the issue's revolve recipe does", async () => {
      // Tessellated curved shells -- a cylindrical chamber sealed in a block,
      // then a cylindrical bore -- are what need the sewing tolerance ladder,
      // which flat boxes never reach.
      const block = sceneShape({ id: "block", name: "Block", kind: "box", color: "#123456", width: 20, depth: 20, height: 20 });
      const chamber = { ...sceneShape({ id: "chamber", name: "Chamber", kind: "cylinder", color: "#123456", width: 10, depth: 10, height: 10 }), elevation: 5, hole: true };
      const sealed = await buildGroupFromSelection([block, chamber]);
      expect("group" in sealed ? null : sealed).toBeNull();
      if (!("group" in sealed) || !sealed.group) return;
      const before = await shapeProperties(sealed.group);
      // The chamber is a faceted cylinder, so a little smaller than pi r^2 h.
      expect(Math.abs(before.volume / (8000 - Math.PI * 25 * 10) - 1)).toBeLessThan(0.02);

      // A 4 mm bore along Y at x=7.5 runs through the wall beside the chamber.
      const bore = { ...sceneShape({ id: "bore", name: "Bore", kind: "cylinder", color: "#000000", width: 4, depth: 4, height: 30 }), x: 7.5, elevation: -5, z: 0, hole: true };
      const cut = await buildGroupFromSelection([sealed.group, bore]);

      expect("group" in cut ? null : cut).toBeNull();
      if (!("group" in cut) || !cut.group) return;
      const after = await shapeProperties(cut.group);
      const removed = before.volume - after.volume;
      // A 20 mm length of a 4 mm faceted bore, within 2% of pi r^2 L.
      expect(Math.abs(removed / (Math.PI * 4 * 20) - 1)).toBeLessThan(0.02);
      // Taken from beside the chamber at x=7.5, not from the chamber's side.
      expect(after.centerOfMass.x).toBeCloseTo((before.volume * before.centerOfMass.x - removed * 7.5) / after.volume, 2);
      expect(after.centerOfMass.y).toBeCloseTo(10, 2);
      expect(after.isValid).toBe(true);
    }, CAD_TEST_TIMEOUT_MS);

    // Section and projection read the mesh directly (#511, #513) rather than
    // through the sewing this file fixes, so these two are regression cover for
    // a void mesh, not proof of #501: they check the void is in the drawing.
    it("draws a section through the void with the void's own loop", async () => {
      // Plan section at mid-height: the outer 20 mm square and the void's
      // 10 mm square, x -2..8 by -5..5.
      const svg = await sectionShapesToSvg([hollow()], { plane: "xy", offset: 10 });

      const loops = svgSubpaths(svg).map(sortedCorners);
      expect(loops).toContainEqual(sortedCorners([[-10, -10], [10, -10], [10, 10], [-10, 10]]));
      expect(loops).toContainEqual(sortedCorners([[-2, -5], [8, -5], [8, 5], [-2, 5]]));
    }, CAD_TEST_TIMEOUT_MS);

    it("draws the void as hidden lines in a projection, as project_view and capture_image do", async () => {
      const svg = await projectShapesToSvg([hollow()]);

      // The front view's visible outline spans the cube's 20 mm in X; its
      // hidden lines include the void's sides at x=-2 and x=8.
      const front = svg.slice(0, svg.indexOf("</g>"));
      const xs = (stroke: RegExp) => {
        const d = front.match(stroke)?.[1] ?? "";
        return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
      };
      const visible = xs(/<path d="([^"]+)" fill="none" stroke="#111111"/);
      const hidden = xs(/<path d="([^"]+)" fill="none" stroke="#9aa0a6"[^>]*stroke-dasharray/);
      const left = Math.min(...visible);
      const perMm = (Math.max(...visible) - left) / 20;
      const at = (x: number) => left + (x + 10) * perMm;
      expect(hidden.some((x) => Math.abs(x - at(-2)) < 0.05)).toBe(true);
      expect(hidden.some((x) => Math.abs(x - at(8)) < 0.05)).toBe(true);
    }, CAD_TEST_TIMEOUT_MS);
  });
});
