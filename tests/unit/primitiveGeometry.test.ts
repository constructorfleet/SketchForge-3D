/**
 * The editor's mesh primitives, measured.
 *
 * These seven builders existed twice -- once in `WorkplaneViewport.tsx` for the
 * thing on screen, once in `SketchForgeEditor.tsx` as the operands of a mesh
 * boolean -- and this is the first test in the repository that can see any of
 * them. It could not have been written before they moved: the harness has no
 * JSX plugin and no DOM environment, so nothing in a `.tsx` file is reachable
 * from a test at all. That is why one of the pair had already drifted from the
 * other without anyone noticing.
 *
 * Volume and centroid rather than bounding extents. A bounding box cannot see a
 * mirrored or a misordered solid: a roof flipped about its ridge, a pyramid
 * built from its corner, a winding reversed -- all of them leave the box exactly
 * as it was. The extents are asserted too, but only as the weakest of the
 * checks, and never on its own.
 *
 * Every closed form here is derived independently of the builder: a prism's
 * centroid is a third of the way up its triangle, a pyramid's a quarter, a
 * half-ellipsoid's three-eighths, a half-ellipse's `4b/3pi`. Where the mesh
 * tessellates a curve it is also asserted to come in *under* the smooth volume,
 * which is what inscribing a polygon in a circle must do -- a builder that
 * started circumscribing instead would fail here even though its volume would
 * still be within tolerance.
 *
 * Dimensions are deliberately three different awkward numbers. With a cube, or
 * with width equal to depth, a builder that swapped two axes would pass
 * everything below.
 */
import { describe, expect, it } from "vitest";
import {
  createHalfSphereGeometry,
  createHollowCylinderGeometry,
  createPyramidGeometry,
  createRoofGeometry,
  createRoundRoofGeometry,
  createTorusGeometry,
  createWedgeGeometry,
  putGeometryOnBase,
  type PrimitiveGeometryOptions,
} from "@constructorfleet/sketchforge-engine/primitiveGeometry";
import { regularPolygonFootprintScale } from "@constructorfleet/sketchforge-engine/regularPolygonFootprint";
import { measureMesh, meshExtents } from "./support/meshMeasure";

const W = 41;
const H = 13;
const D = 23;
const RX = W / 2;
const RZ = D / 2;

/** How the boolean path asks for these, which is not how the viewport asks. */
const BOOLEAN: PrimitiveGeometryOptions = { indexed: true, halfSphereNormals: "computed" };

function expectRelative(actual: number, expected: number, fraction: number, what: string) {
  expect(Math.abs(actual - expected) / Math.abs(expected), `${what}: got ${actual}, wanted ${expected}`)
    .toBeLessThan(fraction);
}

function expectExtents(geometry: ReturnType<typeof createRoofGeometry>, minY: number, what: string) {
  const extents = meshExtents(geometry);
  expect(extents.size[0], `${what} width`).toBeCloseTo(W, 6);
  expect(extents.size[1], `${what} height`).toBeCloseTo(H, 6);
  expect(extents.size[2], `${what} depth`).toBeCloseTo(D, 6);
  expect(extents.min[0], `${what} left`).toBeCloseTo(-RX, 6);
  expect(extents.min[2], `${what} back`).toBeCloseTo(-RZ, 6);
  expect(extents.min[1], `${what} base`).toBeCloseTo(minY, 6);
}

describe("exact polyhedra", () => {
  it("a roof is a triangular prism with its ridge centred", () => {
    const measured = measureMesh(createRoofGeometry(W, H, D));
    expect(measured.triangles).toBe(8);
    // Half a block: the cross-section is a triangle of base W and height H.
    expectRelative(measured.volume, 0.5 * W * H * D, 1e-9, "roof volume");
    expect(measured.centroid[0], "roof is centred in x").toBeCloseTo(0, 9);
    // A triangle's centroid is a third of the way up.
    expect(measured.centroid[1], "roof centroid height").toBeCloseTo(H / 3, 9);
    expect(measured.centroid[2], "roof is centred in z").toBeCloseTo(0, 9);
    expectExtents(createRoofGeometry(W, H, D), 0, "roof");
  });

  it("a wedge is that prism with its ridge over one side", () => {
    const measured = measureMesh(createWedgeGeometry(W, H, D));
    expect(measured.triangles).toBe(8);
    expectRelative(measured.volume, 0.5 * W * H * D, 1e-9, "wedge volume");
    // The one builder here whose centroid is off the origin in x, which is what
    // makes it the useful one: a wedge mirrored about x has the same volume, the
    // same extents and the same height, and only this number moves.
    expect(measured.centroid[0], "wedge leans toward +x").toBeCloseTo(W / 6, 9);
    expect(measured.centroid[1], "wedge centroid height").toBeCloseTo(H / 3, 9);
    expect(measured.centroid[2], "wedge is centred in z").toBeCloseTo(0, 9);
    expectExtents(createWedgeGeometry(W, H, D), 0, "wedge");
  });

  it("a four-sided pyramid is a rectangle drawn to an apex", () => {
    const measured = measureMesh(createPyramidGeometry(W, H, D, 4));
    expect(measured.triangles).toBe(6);
    expectRelative(measured.volume, (W * D * H) / 3, 1e-9, "pyramid volume");
    expect(measured.centroid[0]).toBeCloseTo(0, 9);
    // A cone of any cross-section has its centroid a quarter of the way up.
    expect(measured.centroid[1], "pyramid centroid height").toBeCloseTo(H / 4, 9);
    expect(measured.centroid[2]).toBeCloseTo(0, 9);
    expectExtents(createPyramidGeometry(W, H, D, 4), 0, "pyramid");
  });

  it("a six-sided pyramid is the regular hexagon fitted to the footprint", () => {
    const measured = measureMesh(createPyramidGeometry(W, H, D, 6));
    expect(measured.triangles).toBe(12);
    const footprint = regularPolygonFootprintScale(W, D, 6);
    // Area of a regular hexagon inscribed in the footprint ellipse.
    const area = 0.5 * 6 * Math.sin((2 * Math.PI) / 6) * footprint.x * footprint.z;
    expectRelative(measured.volume, (area * H) / 3, 1e-6, "hexagonal pyramid volume");
    expect(measured.centroid[1], "pyramid centroid height").toBeCloseTo(H / 4, 6);
    expectExtents(createPyramidGeometry(W, H, D, 6), 0, "hexagonal pyramid");
  });
});

describe("tessellated curves", () => {
  it("a barrel roof is a half ellipse extruded", () => {
    const measured = measureMesh(createRoundRoofGeometry(W, H, D, 64));
    expect(measured.triangles).toBe(512);
    const smooth = (Math.PI / 2) * RX * H * D;
    expectRelative(measured.volume, smooth, 0.005, "barrel roof volume");
    // Inscribed, so under: a builder that circumscribed the arc instead would
    // still be within tolerance above but would fail this.
    expect(measured.volume, "barrel roof inscribes its arc").toBeLessThan(smooth);
    expect(measured.centroid[0]).toBeCloseTo(0, 6);
    // Centroid of a half ellipse of semi-axis H: 4H/3pi.
    expect(measured.centroid[1], "barrel roof centroid height").toBeCloseTo((4 * H) / (3 * Math.PI), 2);
    expect(measured.centroid[2]).toBeCloseTo(0, 6);
    expectExtents(createRoundRoofGeometry(W, H, D, 64), 0, "barrel roof");
  });

  it("a half sphere is the top half of an ellipsoid of the full height", () => {
    const measured = measureMesh(createHalfSphereGeometry(W, H, D, 32));
    expect(measured.triangles).toBe(2048);
    const smooth = (2 / 3) * Math.PI * RX * RZ * H;
    expectRelative(measured.volume, smooth, 0.01, "half sphere volume");
    expect(measured.volume, "half sphere inscribes its dome").toBeLessThan(smooth);
    expect(measured.centroid[0]).toBeCloseTo(0, 6);
    // Centroid of a solid half ellipsoid: three eighths of its height.
    expect(measured.centroid[1], "half sphere centroid height").toBeCloseTo((3 * H) / 8, 1);
    expect(measured.centroid[2]).toBeCloseTo(0, 6);
    expectExtents(createHalfSphereGeometry(W, H, D, 32), 0, "half sphere");
  });

  it("a tube is an elliptical wall of its bevel thickness", () => {
    const thickness = 4;
    const measured = measureMesh(createHollowCylinderGeometry(W, H, D, thickness, 144));
    expect(measured.triangles).toBe(1152);
    const smooth = Math.PI * (RX * RZ - (RX - thickness) * (RZ - thickness)) * H;
    expectRelative(measured.volume, smooth, 0.005, "tube volume");
    expect(measured.volume, "tube inscribes its ellipses").toBeLessThan(smooth);
    expect(measured.centroid[0]).toBeCloseTo(0, 6);
    // A constant cross-section sits half way up.
    expect(measured.centroid[1], "tube centroid height").toBeCloseTo(H / 2, 6);
    expect(measured.centroid[2]).toBeCloseTo(0, 6);
    expectExtents(createHollowCylinderGeometry(W, H, D, thickness, 144), 0, "tube");
  });

  // The wall thickness is clamped into [0.1, min(RX, RZ) - 0.1] before the bore
  // is sized, and the clamp has to be measured where it actually bites. An
  // earlier version of this test used a thickness of 500, which looked like a
  // thorough edge case and was in fact worthless: at 500 the `Math.max(0.1, ..)`
  // floor on each bore semi-axis gives the same answer whether the clamp ran or
  // not, so removing the clamp altogether passed. These two thicknesses are
  // chosen to sit inside the window where the clamp changes the result.
  const clampedTubeVolume = (thickness: number) => {
    const innerX = Math.max(0.1, RX - thickness);
    const innerZ = Math.max(0.1, RZ - thickness);
    return Math.PI * (RX * RZ - innerX * innerZ) * H;
  };

  /**
   * The bore's semi-axis on X, read straight off the vertices.
   *
   * At angle zero the builder emits the inner and outer wall at `z = 0`, so the
   * smallest positive x among the vertices on that plane *is* the bore radius.
   * Volume cannot see this: once the thickness passes the smaller semi-axis the
   * bore is a sliver either way, and clamping or not changes the volume by under
   * a fifth of a percent -- which is how an unclamped build passed an earlier
   * version of this test.
   */
  const boreSemiAxisX = (geometry: ReturnType<typeof createHollowCylinderGeometry>) => {
    const position = geometry.getAttribute("position");
    let smallest = Infinity;
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      if (Math.abs(position.getZ(vertex)) > 1e-6) continue;
      const x = position.getX(vertex);
      if (x > 1e-6) smallest = Math.min(smallest, x);
    }
    return smallest;
  };

  it("a tube's wall is capped just short of the smaller radius", () => {
    // 15 is thicker than RZ - 0.1 = 11.4 but thinner than RX, so the cap is what
    // decides how much bore is left on the wide axis.
    const capped = Math.min(RX, RZ) - 0.1;
    const geometry = createHollowCylinderGeometry(W, H, D, 15, 144);
    const measured = measureMesh(geometry);
    expectRelative(measured.volume, clampedTubeVolume(capped), 0.005, "over-thick tube volume");
    expect(measured.volume, "an over-thick tube is still hollow").toBeLessThan(Math.PI * RX * RZ * H);
    expect(measured.volume, "and is not inside out").toBeGreaterThan(0);
    expect(boreSemiAxisX(geometry), "the bore is sized from the capped thickness")
      .toBeCloseTo(RX - capped, 6);
    expectExtents(createHollowCylinderGeometry(W, H, D, 15, 144), 0, "over-thick tube");
  });

  it("a tube's wall has a floor, so a nominal zero still leaves a wall", () => {
    const measured = measureMesh(createHollowCylinderGeometry(W, H, D, 0.05, 144));
    expectRelative(measured.volume, clampedTubeVolume(0.1), 0.01, "paper-thin tube volume");
    expect(measured.volume, "a paper-thin tube is still a solid").toBeGreaterThan(0);
    expect(
      Math.abs(measured.volume - clampedTubeVolume(0.05)) / measured.volume,
      "an unclamped 0.05 mm wall would be a different solid",
    ).toBeGreaterThan(0.05);
  });

  it("a torus lies flat and is centred on the workplane rather than sitting on it", () => {
    const measured = measureMesh(createTorusGeometry(W, H, D));
    expect(measured.triangles).toBe(10368);
    const tube = Math.max(0.1, H / 2);
    const major = Math.max(0.2, Math.min(W, D) / 2 - tube);
    const outerDiameter = (major + tube) * 2;
    const smooth = 2 * Math.PI ** 2 * major * tube ** 2 * (W / outerDiameter) * (D / outerDiameter);
    expectRelative(measured.volume, smooth, 0.01, "torus volume");
    expect(measured.volume, "torus inscribes its tube").toBeLessThan(smooth);
    measured.centroid.forEach((value, axis) => {
      expect(value, `torus centroid on ${"xyz"[axis]}`).toBeCloseTo(0, 6);
    });
    // The one kind that is not sitting on y = 0 -- `putGeometryOnBase` lifts
    // it for the viewport, and the exact builder in `cadSolids.ts` matches that.
    expectExtents(createTorusGeometry(W, H, D), -H / 2, "torus");
  });
});

describe("winding", () => {
  // Each triangle contributes the signed volume of its tetrahedron on the
  // origin, so a positive total means the faces point outward. A reversed
  // winding turns a solid into a hole for the CSG evaluator without changing
  // one vertex, and so without changing any bounding box.
  const builders: Array<[string, (options?: PrimitiveGeometryOptions) => ReturnType<typeof createRoofGeometry>]> = [
    ["roof", (options) => createRoofGeometry(W, H, D, options)],
    ["wedge", (options) => createWedgeGeometry(W, H, D, options)],
    ["pyramid", (options) => createPyramidGeometry(W, H, D, 4, options)],
    ["hexagonal pyramid", (options) => createPyramidGeometry(W, H, D, 6, options)],
    ["barrel roof", (options) => createRoundRoofGeometry(W, H, D, 64, options)],
    ["half sphere", (options) => createHalfSphereGeometry(W, H, D, 32, options)],
    ["tube", () => createHollowCylinderGeometry(W, H, D, 4, 144)],
    ["torus", (options) => createTorusGeometry(W, H, D, options)],
  ];
  for (const [label, build] of builders) {
    it(`a ${label} has its faces pointing outward`, () => {
      expect(measureMesh(build()).volume, `${label} for the viewport`).toBeGreaterThan(0);
      // And the same solid for the boolean path, which keeps the index buffer:
      // a CSG evaluator handed a reversed winding cuts where it should add.
      expect(measureMesh(build(BOOLEAN)).volume, `${label} for the boolean path`).toBeGreaterThan(0);
    });
  }
});

describe("the two options the duplicate copies disagreed on", () => {
  // `indexed` and `halfSphereNormals` exist only because the two copies of
  // these builders differed in exactly those two ways. Both are preserved
  // rather than reconciled, so these assert that both behaviours are still
  // reachable -- an option quietly collapsing to one branch is the failure this
  // is guarding against.
  const indexedKinds: Array<[string, (options?: PrimitiveGeometryOptions) => ReturnType<typeof createRoofGeometry>]> = [
    ["roof", (options) => createRoofGeometry(W, H, D, options)],
    ["wedge", (options) => createWedgeGeometry(W, H, D, options)],
    ["pyramid", (options) => createPyramidGeometry(W, H, D, 4, options)],
    ["hexagonal pyramid", (options) => createPyramidGeometry(W, H, D, 6, options)],
    ["torus", (options) => createTorusGeometry(W, H, D, options)],
  ];

  for (const [label, build] of indexedKinds) {
    it(`a ${label} is flattened by default and keeps its index on request`, () => {
      const flat = build();
      const indexed = build(BOOLEAN);
      expect(flat.index, `${label} default is non-indexed`).toBeNull();
      expect(indexed.index, `${label} keeps its index`).not.toBeNull();
      // Same solid either way: the index buffer is a storage choice, and a
      // builder that dropped triangles while flattening would show up here.
      const flatMeasure = measureMesh(flat);
      const indexedMeasure = measureMesh(indexed);
      expect(indexedMeasure.triangles).toBe(flatMeasure.triangles);
      expectRelative(indexedMeasure.volume, flatMeasure.volume, 1e-9, `${label} volume by index`);
      indexedMeasure.centroid.forEach((value, axis) => {
        expect(value, `${label} centroid on ${"xyz"[axis]}`).toBeCloseTo(flatMeasure.centroid[axis], 6);
      });
    });
  }

  it("the kinds that are already triangle soup ignore the index option", () => {
    // The tube and the half sphere are assembled vertex by vertex. The barrel
    // roof is less obvious: `THREE.ExtrudeGeometry` comes back non-indexed
    // already, so the viewport's `.toNonIndexed()` on it was always a no-op --
    // one that three.js logs a warning for, which is preserved here along with
    // everything else rather than quietly tidied away in a move.
    expect(createHollowCylinderGeometry(W, H, D, 4, 144).index).toBeNull();
    expect(createHalfSphereGeometry(W, H, D, 32, BOOLEAN).index).toBeNull();
    expect(createRoundRoofGeometry(W, H, D, 64, BOOLEAN).index).toBeNull();
    expect(createRoundRoofGeometry(W, H, D, 64).index).toBeNull();
  });

  it("the half sphere's two normal strategies are both still reachable and differ", () => {
    const analytic = createHalfSphereGeometry(W, H, D, 32, { halfSphereNormals: "analytic" });
    const computed = createHalfSphereGeometry(W, H, D, 32, { halfSphereNormals: "computed" });
    const analyticNormals = analytic.getAttribute("normal");
    const computedNormals = computed.getAttribute("normal");

    // Same vertices.
    expect(Array.from(computed.getAttribute("position").array))
      .toEqual(Array.from(analytic.getAttribute("position").array));
    expect(computedNormals.count).toBe(analyticNormals.count);

    // Different shading. The rim between the dome and its cap is where they
    // part: analytic keeps it hard, computed averages it round.
    let differing = 0;
    for (let vertex = 0; vertex < analyticNormals.count; vertex += 1) {
      const dx = analyticNormals.getX(vertex) - computedNormals.getX(vertex);
      const dy = analyticNormals.getY(vertex) - computedNormals.getY(vertex);
      const dz = analyticNormals.getZ(vertex) - computedNormals.getZ(vertex);
      if (Math.hypot(dx, dy, dz) > 1e-4) differing += 1;
    }
    expect(differing, "the two strategies disagree somewhere").toBeGreaterThan(0);

    // Analytic normals are unit length, and the cap is dead flat.
    for (let vertex = 0; vertex < analyticNormals.count; vertex += 1) {
      const length = Math.hypot(analyticNormals.getX(vertex), analyticNormals.getY(vertex), analyticNormals.getZ(vertex));
      expect(length, `analytic normal ${vertex} is a unit vector`).toBeCloseTo(1, 5);
    }
    const capStart = analyticNormals.count - 3 * 64;
    for (let vertex = capStart; vertex < analyticNormals.count; vertex += 1) {
      expect(analyticNormals.getX(vertex)).toBeCloseTo(0, 9);
      expect(analyticNormals.getY(vertex), "the cap faces straight down").toBeCloseTo(-1, 9);
      expect(analyticNormals.getZ(vertex)).toBeCloseTo(0, 9);
    }
  });
});

describe("putGeometryOnBase", () => {
  it("drops a geometry onto the workplane", () => {
    const based = putGeometryOnBase(createTorusGeometry(W, H, D));
    expectExtents(based, 0, "based torus");
    const measured = measureMesh(based);
    expect(measured.centroid[1], "a centred torus rises by half its height").toBeCloseTo(H / 2, 6);
  });

  it("leaves something already on the workplane where it is", () => {
    const measured = measureMesh(putGeometryOnBase(createRoofGeometry(W, H, D)));
    expect(measured.centroid[1]).toBeCloseTo(H / 3, 9);
    expectExtents(putGeometryOnBase(createRoofGeometry(W, H, D)), 0, "based roof");
  });

  it("recomputes vertex normals, so a builder's own normals do not survive it", () => {
    // Worth pinning down rather than leaving as folklore: the viewport's half
    // sphere computes analytic ellipsoid normals and then hands the result to
    // `putGeometryOnBase`, which averages face normals over the top of them. So
    // the analytic strategy is what the builder returns, not what the viewport
    // ends up drawing, and the divergence between the two old copies was
    // narrower on screen than it looks in the source.
    const analytic = createHalfSphereGeometry(W, H, D, 32, { halfSphereNormals: "analytic" });
    const before = Array.from(analytic.getAttribute("normal").array);
    const after = Array.from(putGeometryOnBase(analytic).getAttribute("normal").array);
    expect(after).not.toEqual(before);

    const computed = putGeometryOnBase(createHalfSphereGeometry(W, H, D, 32, { halfSphereNormals: "computed" }));
    expect(Array.from(computed.getAttribute("normal").array)).toEqual(after);
  });
});
