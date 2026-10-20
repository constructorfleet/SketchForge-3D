import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { serverCadKernel } from "@sketchforge/engine/serverCadKernel";
import { EXACT_SOLID_KINDS, exactSolidForShape, UnbuildableShapeError } from "@sketchforge/engine/cadSolids";
import { sceneShape } from "@sketchforge/engine/shapeCatalog";
import { REQUESTABLE_SHAPE_KINDS, shapeFromRequest } from "@sketchforge/engine/shapeRequests";
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
    centerX: (bounds.xmin + bounds.xmax) / 2,
    centerZ: (bounds.zmin + bounds.zmax) / 2,
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

  it("centres every kind it builds on the origin, so one can be placed against another", async () => {
    // Every builder promises a local frame centred in X and Z. A kind that
    // breaks that promise still fillets correctly, because the result is
    // recentred -- but a hole placed against it lands half a shape away, which
    // is why this is measured at all. The bound is loose rather than exact
    // because OCCT's box around a curved surface carries a little slack of its
    // own; it is still two orders of magnitude tighter than a shape built from
    // a corner instead of its middle.
    for (const kind of EXACT_SOLID_KINDS) {
      const measured = await measure(shape(kind, { depth: 20 }));
      expect(Math.abs(measured.centerX), `${kind} is off-centre in X`).toBeLessThan(0.5);
      expect(Math.abs(measured.centerZ), `${kind} is off-centre in Z`).toBeLessThan(0.5);
    }
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

  it("builds a sphere sitting on the workplane rather than through it", async () => {
    const measured = await measure(shape("sphere", { height: 40 }));

    expect(measured.bottom).toBeCloseTo(0, 6);
    expect(measured.height).toBeCloseTo(40, 6);
    // A ball of three equal radii is a true sphere, so this is exact rather
    // than right to a fraction of a percent: OCCT's ellipsoid is a revolved
    // spline and measured 4187.0 where the sphere measures 4188.79.
    expect(measured.volume).toBeCloseTo((4 / 3) * Math.PI * 20 * 20 * 20, 6);
  });

  it("still builds an elliptical ball as the spline it has to be", async () => {
    // Only the equal-radii case can be analytic; a 40x40x20 ball is a genuine
    // ellipsoid and keeps the spline, approximation and all.
    const measured = await measure(shape("sphere", { height: 20 }));

    expect(measured.height).toBeCloseTo(20, 6);
    expect(measured.volume / ((4 / 3) * Math.PI * 20 * 10 * 20)).toBeCloseTo(1, 3);
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

  it("builds a gable roof as a triangular prism", async () => {
    const measured = await measure(shape("roof"));

    expect(measured.isSolid).toBe(true);
    expect(measured.bottom).toBeCloseTo(0, 6);
    expect(measured.width).toBeCloseTo(40, 6);
    expect(measured.depth).toBeCloseTo(40, 6);
    expect(measured.volume).toBeCloseTo(0.5 * 40 * 10 * 40, 3);
  });

  it("builds a wedge with one vertical face", async () => {
    const measured = await measure(shape("wedge"));

    // Same triangle area as the roof, with the apex over one side instead of
    // the middle -- so the volume matches but the shape does not.
    expect(measured.volume).toBeCloseTo(0.5 * 40 * 10 * 40, 3);
    expect(measured.faces).toBe(5);
  });

  it("builds a barrel roof as half an ellipse extruded", async () => {
    const measured = await measure(shape("roundRoof"));

    expect(measured.bottom).toBeCloseTo(0, 6);
    expect(measured.height).toBeCloseTo(10, 3);
    // Half an ellipse with semi-axes 20 and 10, extruded 40 deep.
    expect(measured.volume).toBeCloseTo(0.5 * Math.PI * 20 * 10 * 40, 1);
  });

  it("builds a square pyramid", async () => {
    const measured = await measure(shape("pyramid"));

    expect(measured.faces).toBe(5);
    expect(measured.volume).toBeCloseTo((1 / 3) * 40 * 40 * 10, 3);
  });

  it("builds a pyramid on a polygon base, fitted to width and depth", async () => {
    const measured = await measure(shape("pyramid", { sides: 6 }));

    expect(measured.faces).toBe(7);
    expect(measured.width).toBeCloseTo(40, 3);
    expect(measured.depth).toBeCloseTo(40, 3);
    // A positive volume is the check that the sewn faces ended up facing out.
    expect(measured.volume).toBeGreaterThan(0);
  });

  it("builds a torus the size the editor draws, centred on the workplane", async () => {
    const measured = await measure(shape("torus", { height: 10 }));

    // Tube radius from the height, major radius from the smaller footprint,
    // and centred rather than sitting on the plane -- the one kind that is.
    expect(measured.width).toBeCloseTo(40, 1);
    expect(measured.depth).toBeCloseTo(40, 1);
    expect(measured.height).toBeCloseTo(10, 3);
    expect(measured.bottom).toBeCloseTo(-5, 3);
    expect(measured.volume / (2 * Math.PI ** 2 * 15 * 25)).toBeCloseTo(1, 2);
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

  it("can build every kind the API accepts, except the ones it names", async () => {
    const cad = await serverCadKernel();
    // The API accepts more kinds than the server can build exactly -- a gear's
    // teeth and a letterform are tessellations, not surfaces -- and those are
    // the only ones it may refuse.
    const expectedRefusals = ["text", "gear", "icosahedron"];

    const refused = REQUESTABLE_SHAPE_KINDS.filter((kind) => {
      const subject = shapeFromRequest({ kind, width: 40, depth: 40, height: 20, text: "HI" });
      if (!subject) return false;
      try {
        exactSolidForShape(cad, subject);
        return false;
      } catch {
        return true;
      }
    });

    expect([...refused].sort()).toEqual([...expectedRefusals].sort());
  });

  it("builds every kind it claims to", async () => {
    const cad = await serverCadKernel();

    for (const kind of EXACT_SOLID_KINDS) {
      expect(() => exactSolidForShape(cad, shape(kind)), kind).not.toThrow();
    }
  });
});
