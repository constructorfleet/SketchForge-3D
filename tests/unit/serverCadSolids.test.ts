import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { serverCadKernel } from "@/lib/serverCadKernel";
import { EXACT_SOLID_KINDS, exactSolidForShape, UnbuildableShapeError } from "@/lib/serverCadSolids";
import { sceneShape } from "@/lib/shapeCatalog";
import type { ShapeKind, WorkplaneShape } from "@/types/sketchforge";

function shape(kind: ShapeKind, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return sceneShape({
    name: kind,
    kind,
    color: "#d41721",
    width: 40,
    depth: 40,
    height: 10,
    size: 40,
    ...overrides,
  });
}

async function measure(subject: WorkplaneShape) {
  const cad = await serverCadKernel();
  const solid = exactSolidForShape(cad, subject);
  const bounds = cad.getBoundingBox(solid, false);
  return {
    volume: cad.getVolume(solid),
    width: bounds.xmax - bounds.xmin,
    height: bounds.ymax - bounds.ymin,
    depth: bounds.zmax - bounds.zmin,
    bottom: bounds.ymin,
    faces: cad.getSubShapes(solid, "face").length,
    isSolid: cad.isSolid(solid),
  };
}

// Loading the OCCT kernel and building solids takes far longer than the default
// 5s budget on a cold CI runner, and it is the kernel's time, not the test's.
describe("exact solids for stored shapes", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("builds a box at its stored size, sitting on the workplane", async () => {
    const measured = await measure(shape("box"));

    expect(measured).toMatchObject({ isSolid: true, faces: 6 });
    expect(measured.width).toBeCloseTo(40, 6);
    expect(measured.depth).toBeCloseTo(40, 6);
    expect(measured.height).toBeCloseTo(10, 6);
    expect(measured.bottom).toBeCloseTo(0, 6);
    expect(measured.volume).toBeCloseTo(40 * 40 * 10, 3);
  });

  it("builds a round cylinder as a true cylinder rather than a prism", async () => {
    const measured = await measure(shape("cylinder"));

    // Three faces -- one curved wall and two flat ends -- is the signature of
    // true geometry. A 96-sided prism would have 98.
    expect(measured.faces).toBe(3);
    expect(measured.volume).toBeCloseTo(Math.PI * 20 * 20 * 10, 1);
    expect(measured.bottom).toBeCloseTo(0, 6);
  });

  it("builds a deliberately faceted cylinder as the prism it is", async () => {
    const measured = await measure(shape("cylinder", { sides: 6 }));

    expect(measured.faces).toBe(8);
    // A hexagon inscribed in a circle of radius 20.
    expect(measured.volume).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 20 * 20 * 10, 1);
  });

  it("builds an oval cylinder as a true ellipse", async () => {
    const measured = await measure(shape("cylinder", { depth: 20 }));

    expect(measured.faces).toBe(3);
    expect(measured.width).toBeCloseTo(40, 3);
    expect(measured.depth).toBeCloseTo(20, 3);
    expect(measured.volume).toBeCloseTo(Math.PI * 20 * 10 * 10, 1);
  });

  it("builds a tapered cylinder as a cone", async () => {
    const measured = await measure(shape("cylinder", { taperTopScale: 0.5 }));

    expect(measured.faces).toBe(3);
    expect(measured.height).toBeCloseTo(10, 6);
    // A frustum: (h/3)·π·(R² + Rr + r²) with R = 20, r = 10.
    expect(measured.volume).toBeCloseTo((10 / 3) * Math.PI * (400 + 200 + 100), 0);
  });

  it("builds a tapered box as a loft between its two ends", async () => {
    const measured = await measure(shape("box", { taperTopScale: 0.5 }));

    expect(measured.isSolid).toBe(true);
    expect(measured.height).toBeCloseTo(10, 6);
    // A rectangular frustum: (h/3)·(A₁ + √(A₁A₂) + A₂).
    const bottomArea = 40 * 40;
    const topArea = 20 * 20;
    expect(measured.volume).toBeCloseTo((10 / 3) * (bottomArea + Math.sqrt(bottomArea * topArea) + topArea), 0);
  });

  // OCCT builds an ellipsoid as a revolved spline, so its volume is right to a
  // fraction of a percent rather than exactly.
  it("builds a sphere sitting on the workplane rather than through it", async () => {
    const measured = await measure(shape("sphere", { height: 40 }));

    expect(measured.bottom).toBeCloseTo(0, 6);
    expect(measured.height).toBeCloseTo(40, 6);
    expect(measured.volume / ((4 / 3) * Math.PI * 20 * 20 * 20)).toBeCloseTo(1, 3);
  });

  it("builds a cone", async () => {
    const measured = await measure(shape("cone", { topRadius: 0 }));

    expect(measured.isSolid).toBe(true);
    expect(measured.volume).toBeCloseTo((1 / 3) * Math.PI * 20 * 20 * 10, 0);
  });

  it("builds a loft between two different profiles", async () => {
    const measured = await measure(shape("loft", { loftBottomShape: "Rectangle", loftTopShape: "Oval", loftTopWidth: 20, loftTopDepth: 20 }));

    expect(measured.isSolid).toBe(true);
    expect(measured.height).toBeCloseTo(10, 3);
    expect(measured.width).toBeCloseTo(40, 3);
  });

  it("builds a six-sided polygon prism", async () => {
    const measured = await measure(shape("polygon"));

    expect(measured.faces).toBe(8);
    expect(measured.volume).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 20 * 20 * 10, 1);
  });

  it("builds a tube with its middle taken out", async () => {
    const measured = await measure(shape("tube", { bevel: 4 }));

    expect(measured.isSolid).toBe(true);
    expect(measured.height).toBeCloseTo(10, 6);
    // An annulus 4mm thick: outer radius 20, inner 16.
    expect(measured.volume).toBeCloseTo(Math.PI * (20 * 20 - 16 * 16) * 10, 0);
  });

  it("leaves a wall on a tube whose thickness exceeds its radius", async () => {
    const measured = await measure(shape("tube", { bevel: 500 }));

    expect(measured.isSolid).toBe(true);
    expect(measured.volume).toBeGreaterThan(0);
    expect(measured.volume).toBeLessThan(Math.PI * 20 * 20 * 10);
  });

  it("builds a half sphere as a dome on the workplane", async () => {
    const measured = await measure(shape("halfSphere", { height: 20 }));

    expect(measured.bottom).toBeCloseTo(0, 6);
    expect(measured.height).toBeCloseTo(20, 3);
    expect(measured.volume / ((2 / 3) * Math.PI * 20 * 20 * 20)).toBeCloseTo(1, 3);
  });

  it("turns a shape the way it sits in the project", async () => {
    const straight = await measure(shape("box", { depth: 10 }));
    const turned = await measure(shape("box", { depth: 10, rotation: 90 }));

    // A quarter turn about the vertical swaps the footprint.
    expect(turned.width).toBeCloseTo(straight.depth, 3);
    expect(turned.depth).toBeCloseTo(straight.width, 3);
    expect(turned.volume).toBeCloseTo(straight.volume, 3);
  });

  it("names a kind it cannot build instead of approximating it", async () => {
    const cad = await serverCadKernel();

    expect(() => exactSolidForShape(cad, shape("gear"))).toThrow(UnbuildableShapeError);
    expect(() => exactSolidForShape(cad, shape("text", { text: "HI" }))).toThrow(/text/);
    expect(() => exactSolidForShape(cad, shape("icosahedron"))).toThrow(/icosahedron/);
  });

  it("builds every kind it claims to", async () => {
    const cad = await serverCadKernel();

    for (const kind of EXACT_SOLID_KINDS) {
      expect(() => exactSolidForShape(cad, shape(kind)), kind).not.toThrow();
    }
  });
});
