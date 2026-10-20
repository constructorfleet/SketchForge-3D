/**
 * The editor's cuts, measured against closed-form geometry.
 *
 * Upstream #118 ("combining a negative space cylinder with a block results in a
 * broken mesh") and #111 ("Tapered Box combined with other object results in
 * square not tapered hole") are both mesh-CSG artifacts, so both are checked
 * here the only way a mesh artifact can be checked without eyes: the volume and
 * the centre of mass of the result, against the arithmetic for the same cut,
 * plus the cross-section of the hole at two depths for the tapered case.
 *
 * Volume and centre of mass rather than bounding extents, deliberately. A hole
 * cut at the wrong size, in the wrong place, or with its taper dropped leaves
 * the result's bounding box completely unchanged -- it is still the block.
 *
 * The `mesh cutter` block measures what the mesh path feeds its CSG for the
 * same two cuts: a cutter grown by `CUTTER_PADDING` and, for the cylinder, a
 * 96-sided prism instead of a cylinder. Those are the before numbers.
 */

import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { paddedCutterShape } from "@constructorfleet/sketchforge-engine/cutterPadding";
import { exactCutPartsForSelection, shapeHasExactBooleanSolid } from "@constructorfleet/sketchforge-engine/exactBooleanParts";
import { exactCutFromParts, exactPartSolid, meshedExactCut } from "@constructorfleet/sketchforge-engine/exactBooleanSolids";
import { serverCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { ROUND_CYLINDER_SIDES, polygonRing } from "@constructorfleet/sketchforge-engine/stepProfiles";
import { shapeOverallFootprintDimensions } from "@constructorfleet/sketchforge-engine/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

const PLATE_WIDTH = 40;
const PLATE_DEPTH = 40;
const PLATE_HEIGHT = 10;
const PLATE_VOLUME = PLATE_WIDTH * PLATE_DEPTH * PLATE_HEIGHT;
const PLATE_SECTION = PLATE_WIDTH * PLATE_DEPTH;

function shape(overrides: Partial<WorkplaneShape> & Pick<WorkplaneShape, "kind">): WorkplaneShape {
  return sceneShape({ name: overrides.kind, color: "#d41721", ...overrides });
}

const plate = () => shape({
  kind: "box",
  width: PLATE_WIDTH,
  depth: PLATE_DEPTH,
  height: PLATE_HEIGHT,
  size: PLATE_WIDTH,
});

/** A blind pocket from a round cutter, stopping flush with the plate's top face. */
const POCKET_RADIUS = 6;
const POCKET_DEPTH = 4;
const POCKET_X = 8;
const POCKET_Z = -5;
const cylinderHole = () => shape({
  kind: "cylinder",
  hole: true,
  width: POCKET_RADIUS * 2,
  depth: POCKET_RADIUS * 2,
  size: POCKET_RADIUS * 2,
  height: POCKET_DEPTH,
  x: POCKET_X,
  z: POCKET_Z,
  elevation: PLATE_HEIGHT - POCKET_DEPTH,
});

/**
 * A tapered box cutter: a 20 mm opening in the top face narrowing to 10 mm at
 * its floor, which is what the "square not tapered hole" of #111 should not be.
 */
const TAPER_TOP = 20;
const TAPER_BOTTOM = 10;
const TAPER_DEPTH = 6;
const TAPER_FLOOR = PLATE_HEIGHT - TAPER_DEPTH;
const taperedHole = () => shape({
  kind: "box",
  hole: true,
  width: TAPER_TOP,
  depth: TAPER_TOP,
  size: TAPER_TOP,
  height: TAPER_DEPTH,
  elevation: TAPER_FLOOR,
  taperBottomWidth: TAPER_BOTTOM,
  taperBottomDepth: TAPER_BOTTOM,
});

/** The volume of a frustum slice of the tapered pocket between two heights. */
function taperedPocketVolumeBetween(fromY: number, toY: number) {
  const side = (y: number) => TAPER_BOTTOM + ((y - TAPER_FLOOR) * (TAPER_TOP - TAPER_BOTTOM)) / TAPER_DEPTH;
  const lower = side(fromY) ** 2;
  const upper = side(toY) ** 2;
  return ((toY - fromY) / 3) * (lower + upper + Math.sqrt(lower * upper));
}

/** Area of a regular polygon inscribed in a circle, which is what a tessellated cylinder is. */
function inscribedPolygonArea(radius: number, sides: number) {
  return 0.5 * sides * radius * radius * Math.sin((2 * Math.PI) / sides);
}

type Measurement = { volume: number; centerX: number; centerY: number; centerZ: number };

function measure(cad: OcctKernel, solid: ShapeHandle): Measurement {
  const center = cad.getCenterOfMass(solid);
  return { volume: cad.getVolume(solid), centerX: center.x, centerY: center.y, centerZ: center.z };
}

/** Volume of the result lying below a height, for measuring where a pocket's floor ended up. */
function volumeBelow(cad: OcctKernel, solid: ShapeHandle, y: number) {
  const slab = cad.makeBoxFromCorners(
    { x: -PLATE_WIDTH, y: -1, z: -PLATE_DEPTH },
    { x: PLATE_WIDTH, y, z: PLATE_DEPTH },
  );
  return cad.getVolume(cad.common(solid, slab));
}

/** How much material the hole removed between two heights: the hole's cross-section, integrated. */
function holeVolumeBetween(cad: OcctKernel, solid: ShapeHandle, fromY: number, toY: number) {
  return PLATE_SECTION * (toY - fromY) - (volumeBelow(cad, solid, toY) - volumeBelow(cad, solid, fromY));
}

/** The cut, run exactly, the way the editor now runs it. */
async function cutExactly(selection: WorkplaneShape[]) {
  const cad = await serverCadKernel();
  const request = exactCutPartsForSelection(selection);
  if (!request) throw new Error("Expected an exact cut request for this selection");
  const exact = exactCutFromParts(cad, request.parts, (part) => {
    if (!part.exact) throw new Error("Expected every operand to be built exactly");
    return exactPartSolid(cad, part.exact);
  });
  return { cad, ...exact };
}

/** A prism with `ROUND_CYLINDER_SIDES` flats: a tessellated cylinder, as a mesh CSG sees one. */
function tessellatedCylinder(cad: OcctKernel, cutter: WorkplaneShape) {
  const radiusX = (cutter.width ?? cutter.size) / 2;
  const radiusZ = (cutter.depth ?? cutter.size) / 2;
  const ring = polygonRing(radiusX, radiusZ, ROUND_CYLINDER_SIDES, 0);
  const edges = ring.map(([x, y, z], index) => {
    const [nx, ny, nz] = ring[(index + 1) % ring.length];
    return cad.makeLineEdge({ x, y, z }, { x: nx, y: ny, z: nz });
  });
  const prism = cad.extrude(cad.makeFace(cad.makeWire(edges)), 0, cutter.height, 0);
  return cad.translate(prism, cutter.x, cutter.elevation ?? 0, cutter.z);
}

describe("exact editor booleans", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  describe("a negative cylinder in a block (upstream #118)", () => {
    it("removes exactly the cylinder's volume, from exactly where it sat", async () => {
      const { cad, cut } = await cutExactly([plate(), cylinderHole()]);
      const measured = measure(cad, cut);

      const removed = Math.PI * POCKET_RADIUS ** 2 * POCKET_DEPTH;
      const remaining = PLATE_VOLUME - removed;
      expect(measured.volume).toBeCloseTo(remaining, 4);
      // The pocket is off-centre in both X and Z, so a cut placed from a corner
      // rather than a middle, or placed on the wrong axis, moves these.
      expect(measured.centerX).toBeCloseTo((-POCKET_X * removed) / remaining, 6);
      expect(measured.centerY).toBeCloseTo(
        ((PLATE_HEIGHT / 2) * PLATE_VOLUME - (PLATE_HEIGHT - POCKET_DEPTH / 2) * removed) / remaining,
        6,
      );
      expect(measured.centerZ).toBeCloseTo((-POCKET_Z * removed) / remaining, 6);
    });

    it("leaves the pocket at the depth it was asked for, with no padding under its floor", async () => {
      const { cad, cut } = await cutExactly([plate(), cylinderHole()]);

      // Everything below the pocket floor is untouched plate. The mesh path
      // grows the cutter by CUTTER_PADDING, which bites into this.
      expect(volumeBelow(cad, cut, PLATE_HEIGHT - POCKET_DEPTH)).toBeCloseTo(
        PLATE_SECTION * (PLATE_HEIGHT - POCKET_DEPTH),
        6,
      );
    });

    it("leaves the pocket wall as one cylindrical surface, not a ring of flats", async () => {
      const { cad, cut } = await cutExactly([plate(), cylinderHole()]);
      const surfaces = cad.getSubShapes(cut, "face").map((face) => cad.surfaceType(face));

      // Six plate faces, the pocket floor, and one cylinder. A tessellated
      // cutter leaves ninety-six planes here, which is both the broken mesh of
      // #118 and the reason a later fillet of this pocket has nothing to blend.
      expect(surfaces.filter((type) => type === "cylinder")).toHaveLength(1);
      expect(surfaces.filter((type) => type === "plane")).toHaveLength(7);
    });

    it("keeps the exact result alongside the mesh, so a later fillet or STEP reads surfaces", async () => {
      // Measured on a plate that does not sit on the origin: the stored BREP is
      // recentred into the result shape's own frame, and a plate already
      // centred there would not notice if that recentring went missing.
      const OFFSET_X = 13;
      const OFFSET_Z = -7;
      const OFFSET_Y = 5;
      const offsetPlate = { ...plate(), x: OFFSET_X, z: OFFSET_Z, elevation: OFFSET_Y };
      const offsetHole = {
        ...cylinderHole(),
        x: OFFSET_X + POCKET_X,
        z: OFFSET_Z + POCKET_Z,
        elevation: OFFSET_Y + PLATE_HEIGHT - POCKET_DEPTH,
      };
      const { cad, cut } = await cutExactly([offsetPlate, offsetHole]);
      const meshed = meshedExactCut(cad, cut);

      expect(meshed.triangleCount).toBeGreaterThan(0);
      expect(meshed.positions).toHaveLength(meshed.triangleCount * 9);
      expect(meshed.normals).toHaveLength(meshed.positions.length);
      expect(meshed.brep).toContain("CASCADE Topology");
      // The mesh is in world space, where the plate actually is.
      expect(meshed.positions[1]).toBeGreaterThanOrEqual(OFFSET_Y - 1e-6);

      const restored = cad.fromBREP(meshed.brep);
      expect(cad.getVolume(restored)).toBeCloseTo(cad.getVolume(cut), 4);
      // The BREP is not: centred in X and Z, base on y = 0.
      const restoredBounds = cad.getBoundingBox(restored, false);
      expect(restoredBounds.ymin).toBeCloseTo(0, 6);
      expect((restoredBounds.xmin + restoredBounds.xmax) / 2).toBeCloseTo(0, 6);
      expect((restoredBounds.zmin + restoredBounds.zmax) / 2).toBeCloseTo(0, 6);
    });
  });

  describe("a tapered box cutter (upstream #111)", () => {
    it("removes exactly the frustum's volume, from exactly where it sat", async () => {
      const { cad, cut } = await cutExactly([plate(), taperedHole()]);
      const measured = measure(cad, cut);

      const removed = taperedPocketVolumeBetween(TAPER_FLOOR, PLATE_HEIGHT);
      expect(removed).toBeCloseTo(1400, 6);
      const remaining = PLATE_VOLUME - removed;
      expect(measured.volume).toBeCloseTo(remaining, 4);
      // A square cutter of the same footprint would remove 2400 and put the
      // centre of mass at 4.6, so this number is what separates the two.
      expect(measured.centerY).toBeCloseTo(4.7465753424657535, 6);
      expect(measured.centerX).toBeCloseTo(0, 6);
      expect(measured.centerZ).toBeCloseTo(0, 6);
    });

    it("narrows the hole's cross-section with depth", async () => {
      const { cad, cut } = await cutExactly([plate(), taperedHole()]);

      const nearTheOpening = holeVolumeBetween(cad, cut, PLATE_HEIGHT - 1, PLATE_HEIGHT);
      const nearTheFloor = holeVolumeBetween(cad, cut, TAPER_FLOOR, TAPER_FLOOR + 1);

      expect(nearTheOpening).toBeCloseTo(taperedPocketVolumeBetween(PLATE_HEIGHT - 1, PLATE_HEIGHT), 4);
      expect(nearTheFloor).toBeCloseTo(taperedPocketVolumeBetween(TAPER_FLOOR, TAPER_FLOOR + 1), 4);
      // The whole point of #111: the hole is not the same size all the way down.
      expect(nearTheOpening).toBeGreaterThan(nearTheFloor * 3);
    });

    it("leaves the pocket floor at the depth it was asked for", async () => {
      const { cad, cut } = await cutExactly([plate(), taperedHole()]);

      expect(volumeBelow(cad, cut, TAPER_FLOOR)).toBeCloseTo(PLATE_SECTION * TAPER_FLOOR, 6);
    });
  });

  describe("the mesh path's cutter (the before numbers)", () => {
    it("removes too much, too deep, for a round pocket", async () => {
      const cad = await serverCadKernel();
      const cutter = paddedCutterShape(cylinderHole());
      const block = cad.makeBoxFromCorners(
        { x: -PLATE_WIDTH / 2, y: 0, z: -PLATE_DEPTH / 2 },
        { x: PLATE_WIDTH / 2, y: PLATE_HEIGHT, z: PLATE_DEPTH / 2 },
      );
      const result = cad.cut(block, tessellatedCylinder(cad, cutter));

      const exactRemoved = Math.PI * POCKET_RADIUS ** 2 * POCKET_DEPTH;
      const meshRemoved = PLATE_VOLUME - cad.getVolume(result);
      // The padding is the bulk of it: 6.05 mm of radius and 4.05 mm of depth
      // instead of 6 and 4, so a pocket asked for to a thou comes out 1.7% big.
      expect(meshRemoved).toBeCloseTo(inscribedPolygonArea(POCKET_RADIUS + 0.05, ROUND_CYLINDER_SIDES) * (POCKET_DEPTH + 0.05), 3);
      expect(meshRemoved / exactRemoved - 1).toBeGreaterThan(0.015);
      // And the floor sits a padding below where it was asked to stop, so the
      // "flush" pocket has eaten into the plate under it.
      expect(volumeBelow(cad, result, PLATE_HEIGHT - POCKET_DEPTH))
        .toBeLessThan(PLATE_SECTION * (PLATE_HEIGHT - POCKET_DEPTH) - 5);
      // Ninety-six flats where the exact cut leaves one cylinder.
      const surfaces = cad.getSubShapes(result, "face").map((face) => cad.surfaceType(face));
      expect(surfaces.filter((type) => type === "cylinder")).toHaveLength(0);
      expect(surfaces.filter((type) => type === "plane").length).toBeGreaterThan(90);
    });

    it("loses the taper entirely when the cutter is replaced by its bounding box", async () => {
      const cad = await serverCadKernel();
      const hole = taperedHole();
      // What the editor's bounding-box cut paths substitute for a cutter: the
      // shape's overall footprint, which for a taper is its widest section at
      // every height. This is the square hole of #111.
      const footprint = shapeOverallFootprintDimensions(hole);
      expect(footprint.width).toBeCloseTo(TAPER_TOP, 6);
      expect(footprint.depth).toBeCloseTo(TAPER_TOP, 6);

      const block = cad.makeBoxFromCorners(
        { x: -PLATE_WIDTH / 2, y: 0, z: -PLATE_DEPTH / 2 },
        { x: PLATE_WIDTH / 2, y: PLATE_HEIGHT, z: PLATE_DEPTH / 2 },
      );
      const boxCutter = cad.makeBoxFromCorners(
        { x: -footprint.width / 2, y: TAPER_FLOOR, z: -footprint.depth / 2 },
        { x: footprint.width / 2, y: PLATE_HEIGHT, z: footprint.depth / 2 },
      );
      const result = cad.cut(block, boxCutter);

      const nearTheOpening = holeVolumeBetween(cad, result, PLATE_HEIGHT - 1, PLATE_HEIGHT);
      const nearTheFloor = holeVolumeBetween(cad, result, TAPER_FLOOR, TAPER_FLOOR + 1);
      expect(nearTheOpening).toBeCloseTo(nearTheFloor, 4);
      expect(PLATE_VOLUME - cad.getVolume(result)).toBeCloseTo(TAPER_TOP * TAPER_TOP * TAPER_DEPTH, 4);
    });
  });

  describe("which selections go the exact way", () => {
    it("takes the kinds the kernel can build from parameters", () => {
      expect(shapeHasExactBooleanSolid(plate())).toBe(true);
      expect(shapeHasExactBooleanSolid(cylinderHole())).toBe(true);
      expect(shapeHasExactBooleanSolid(taperedHole())).toBe(true);
    });

    it("declines a mirrored operand, whose rotation order the exact builders cannot express", () => {
      expect(shapeHasExactBooleanSolid({ ...plate(), mirrorX: true })).toBe(false);
      expect(exactCutPartsForSelection([{ ...plate(), mirrorZ: true }, cylinderHole()])).toBeNull();
    });

    it("declines a kind with no exact geometry, rather than cutting with an approximation", () => {
      expect(shapeHasExactBooleanSolid(shape({ kind: "gear" }))).toBe(false);
      expect(shapeHasExactBooleanSolid(shape({ kind: "text" }))).toBe(false);
      expect(exactCutPartsForSelection([plate(), { ...cylinderHole(), kind: "gear" }])).toBeNull();
    });

    it("declines a selection with no solid or no hole", () => {
      expect(exactCutPartsForSelection([plate(), plate()])).toBeNull();
      expect(exactCutPartsForSelection([cylinderHole(), cylinderHole()])).toBeNull();
    });

    it("sends holes unpadded, and places each operand where it sits", () => {
      const request = exactCutPartsForSelection([plate(), cylinderHole()]);
      expect(request).not.toBeNull();
      const holePart = request!.parts.find((part) => part.hole);
      expect(holePart?.exact?.shape.width).toBeCloseTo(POCKET_RADIUS * 2, 10);
      expect(holePart?.exact?.shape.height).toBeCloseTo(POCKET_DEPTH, 10);
      expect(holePart?.exact?.transform).toEqual([
        1, 0, 0, POCKET_X,
        0, 1, 0, PLATE_HEIGHT - POCKET_DEPTH,
        0, 0, 1, POCKET_Z,
      ]);
    });

    it("reports a cut that removed nothing, so the caller does not group a miss as a cut", async () => {
      const missing = { ...cylinderHole(), x: 500 };
      const { fusedVolume, cutVolume } = await cutExactly([plate(), missing]);
      expect(cutVolume).toBeCloseTo(fusedVolume, 6);
    });
  });
});
