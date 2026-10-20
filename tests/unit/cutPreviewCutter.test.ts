/**
 * The cut preview's cutter, against the cutter the cut will actually use.
 *
 * The preview is a mesh `HOLLOW_INTERSECTION` highlight of the solid's surface
 * inside the hole, and it has to stay one: measured on a 40x40x10 plate with a
 * 12 mm blind pocket whose top cap is coplanar with the plate's top face,
 * `three-bvh-csg` returns 179 triangles in 11.6 ms with the 0.01 mm separation
 * and had not returned after four minutes with none. So the preview grows its
 * cutter, the committed exact cut does not, and what is checked here is that
 * the gap between them is the separation and nothing else.
 *
 * Measured as volume and centre of mass of the two cutter solids rather than
 * their extents. A scale taken about the hole's base instead of its middle
 * leaves both cutters' extents overlapping and moves the centre of mass, which
 * is the only number that sees it.
 */

import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import {
  CUTTER_PADDING,
  CUT_PREVIEW_SEPARATION,
  cutPreviewCutterGrowth,
  cutPreviewCutterScale,
  cutPreviewCutterShape,
  cutterShapeForBoolean,
} from "@/lib/engine/cutterPadding";
import { exactSolidForShape } from "@/lib/engine/cadSolids";
import { serverCadKernel } from "@/lib/engine/serverCadKernel";
import { sceneShape } from "@/lib/engine/shapeCatalog";
import { shapeDepth, shapeTaperDimensions, shapeWidth } from "@/lib/engine/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> & Pick<WorkplaneShape, "kind">): WorkplaneShape {
  return sceneShape({ name: overrides.kind, color: "#d41721", hole: true, ...overrides });
}

const roundPocket = () => shape({
  kind: "cylinder",
  width: 12,
  depth: 12,
  size: 12,
  height: 4,
  x: 8,
  z: -5,
  elevation: 6,
});

const taperedPocket = () => shape({
  kind: "box",
  width: 20,
  depth: 20,
  size: 20,
  height: 6,
  elevation: 4,
  taperBottomWidth: 10,
  taperBottomDepth: 10,
});

/** A cutter tapering almost to nothing, where a scale's proportional growth bites hardest. */
const spikePocket = () => shape({
  kind: "box",
  width: 20,
  depth: 20,
  size: 20,
  height: 6,
  taperBottomWidth: 2,
  taperBottomDepth: 2,
});

/**
 * Any cutter shape as a solid where it sits.
 *
 * Built from the shape rather than by transforming another solid, which is both
 * what the real builders do and the only way these numbers can be trusted:
 * OCCT's mass properties on a non-uniformly `generalTransform`ed analytic solid
 * disagree with its own bounding box -- a symmetric cylinder scaled by
 * 1.0017/1.005/1.0017 reports a centre of mass 0.043 mm off centre and a volume
 * 0.8% high, while the box is exact. The preview does not do that either: it
 * scales a tessellated brush in three.js, where a scale is exact, and
 * `cutPreviewCutterShape` is that scale expressed as dimensions.
 */
function cutterSolid(cad: OcctKernel, cutter: WorkplaneShape) {
  return cad.translate(exactSolidForShape(cad, cutter), cutter.x, cutter.elevation ?? 0, cutter.z);
}

const committedCutterSolid = (cad: OcctKernel, hole: WorkplaneShape, kernel: "exact" | "mesh") =>
  cutterSolid(cad, cutterShapeForBoolean(hole, kernel));

const previewCutterSolid = (cad: OcctKernel, hole: WorkplaneShape) =>
  cutterSolid(cad, cutPreviewCutterShape(cutterShapeForBoolean(hole, "preview")));

/**
 * The width and depth of the solid's lowest or highest horizontal face.
 *
 * This is how a tapered cutter's two ends get measured, and it is where the
 * extents are the quantity under test rather than a proxy for it: the question
 * is how far each end grew, per axis. Both axes separately, because a single
 * area would hide an end that grew in X and not in Z -- which is exactly what
 * dropping one taper row produces. And read off the solid rather than off the
 * scale factor, because a growth that forgot to carry a taper row produces the
 * right factor and the wrong solid.
 */
function flatEndFace(cad: OcctKernel, solid: ShapeHandle, end: "bottom" | "top") {
  const bounds = cad.getBoundingBox(solid, false);
  const target = end === "bottom" ? bounds.ymin : bounds.ymax;
  const faces = cad.getSubShapes(solid, "face");
  const found = faces.find((face) => {
    const faceBounds = cad.getBoundingBox(face, false);
    return Math.abs(faceBounds.ymax - faceBounds.ymin) < 1e-7 && Math.abs(faceBounds.ymin - target) < 1e-7;
  });
  if (!found) throw new Error(`Expected a flat ${end} face to measure`);
  const faceBounds = cad.getBoundingBox(found, false);
  return { width: faceBounds.xmax - faceBounds.xmin, depth: faceBounds.zmax - faceBounds.zmin };
}

/** How far, per axis, the preview's end face stands outside the committed cutter's. */
function endClearance(cad: OcctKernel, committed: ShapeHandle, preview: ShapeHandle, end: "bottom" | "top") {
  const before = flatEndFace(cad, committed, end);
  const after = flatEndFace(cad, preview, end);
  return { x: (after.width - before.width) / 2, z: (after.depth - before.depth) / 2 };
}

function measure(cad: OcctKernel, solid: ShapeHandle) {
  const centre = cad.getCenterOfMass(solid);
  return {
    volume: cad.getVolume(solid),
    area: cad.getSurfaceArea(solid),
    centreX: centre.x,
    centreY: centre.y,
    centreZ: centre.z,
  };
}

describe("the cut preview's cutter", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("encloses the committed exact cutter, by the separation and no more", async () => {
    const cad = await serverCadKernel();
    const hole = roundPocket();
    const committed = measure(cad, committedCutterSolid(cad, hole, "exact"));
    const preview = measure(cad, previewCutterSolid(cad, hole));

    // The preview is the larger of the two: a highlight that fell inside the
    // cut would leave the evaluator the coplanar faces it cannot resolve.
    expect(preview.volume).toBeGreaterThan(committed.volume);
    // To first order a shell of thickness t over a solid adds area * t. Anything
    // bigger than that means the growth is not the separation it claims to be.
    const shell = committed.area * CUT_PREVIEW_SEPARATION;
    expect(preview.volume - committed.volume).toBeGreaterThan(shell * 0.95);
    expect(preview.volume - committed.volume).toBeLessThan(shell * 1.05);
    // 3.8 mm^3 of highlight over a 452 mm^3 pocket: under a percent.
    expect((preview.volume - committed.volume) / committed.volume).toBeLessThan(0.01);
  });

  it("grows evenly about the hole's middle, so the highlight does not drift", async () => {
    const cad = await serverCadKernel();
    const hole = roundPocket();
    const committed = measure(cad, committedCutterSolid(cad, hole, "exact"));
    const preview = measure(cad, previewCutterSolid(cad, hole));

    expect(preview.centreX).toBeCloseTo(committed.centreX, 9);
    expect(preview.centreY).toBeCloseTo(committed.centreY, 9);
    expect(preview.centreZ).toBeCloseTo(committed.centreZ, 9);
    // And where that middle is, rather than merely that the two agree on it.
    expect(committed.centreX).toBeCloseTo(8, 9);
    expect(committed.centreY).toBeCloseTo(8, 9);
    expect(committed.centreZ).toBeCloseTo(-5, 9);
  });

  it("keeps a tapered cutter tapered, and still clears the separation at its narrow end", async () => {
    const cad = await serverCadKernel();
    const hole = taperedPocket();
    const committed = measure(cad, committedCutterSolid(cad, hole, "exact"));
    const preview = measure(cad, previewCutterSolid(cad, hole));

    expect(preview.volume).toBeGreaterThan(committed.volume);
    // The frustum is still a frustum: a highlight that had become a prism would
    // have the volume of the widest section all the way down.
    expect(committed.volume).toBeCloseTo(1400, 6);
    expect(preview.volume).toBeLessThan(20 * 20 * 6);

    // A frustum's centroid is not at its mid-height, so growing it by a scale
    // moves the centre of mass a little -- but only a little. A growth anchored
    // on the hole's base instead of its middle moves it four times as far.
    const growth = cutPreviewCutterGrowth(hole);
    expect(Math.abs(preview.centreY - committed.centreY)).toBeLessThan(growth * 0.5);
    // Which end the growth went on, stated outright: half above, half below.
    const committedBox = cad.getBoundingBox(committedCutterSolid(cad, hole, "exact"), false);
    const previewBox = cad.getBoundingBox(previewCutterSolid(cad, hole), false);
    expect(previewBox.ymin).toBeCloseTo(committedBox.ymin - growth, 9);
    expect(previewBox.ymax).toBeCloseTo(committedBox.ymax + growth, 9);

    // The narrow end clears the separation too, measured off the solids and on
    // both axes. A plain scale clears half of it at this end, and a twentieth on
    // a steeper taper, which is the case that stops the evaluator coming back.
    const committedSolid = committedCutterSolid(cad, hole, "exact");
    const previewSolid = previewCutterSolid(cad, hole);
    expect(flatEndFace(cad, committedSolid, "bottom").width).toBeCloseTo(shapeTaperDimensions(hole).bottomWidth, 6);
    const floor = endClearance(cad, committedSolid, previewSolid, "bottom");
    expect(floor.x).toBeGreaterThanOrEqual(CUT_PREVIEW_SEPARATION * 0.999);
    expect(floor.z).toBeGreaterThanOrEqual(CUT_PREVIEW_SEPARATION * 0.999);
    // And the wide end is over-grown by the taper's ratio, which is the cost.
    expect(cutPreviewCutterGrowth(hole)).toBeCloseTo(CUT_PREVIEW_SEPARATION * 2, 12);
  });

  it("carries an absolute top taper too, so a flared cutter clears at both ends", async () => {
    const cad = await serverCadKernel();
    // Taper set the other way round and by absolute rows rather than a scale:
    // narrow at the floor, wide at the mouth, both ends named outright.
    const flared = shape({
      kind: "box",
      width: 12,
      depth: 12,
      size: 12,
      height: 6,
      elevation: 4,
      taperTopWidth: 24,
      taperTopDepth: 24,
      taperBottomWidth: 12,
      taperBottomDepth: 12,
    });
    const committed = committedCutterSolid(cad, flared, "exact");
    const preview = previewCutterSolid(cad, flared);

    expect(flatEndFace(cad, committed, "top")).toEqual({ width: expect.closeTo(24, 6), depth: expect.closeTo(24, 6) });
    expect(flatEndFace(cad, committed, "bottom")).toEqual({ width: expect.closeTo(12, 6), depth: expect.closeTo(12, 6) });

    // Both ends, both axes. Dropping a single taper row leaves three of these
    // four right, which is why they are not collapsed into one area.
    const mouth = endClearance(cad, committed, preview, "top");
    const floor = endClearance(cad, committed, preview, "bottom");
    [mouth.x, mouth.z, floor.x, floor.z].forEach((clearance) => {
      expect(clearance).toBeGreaterThanOrEqual(CUT_PREVIEW_SEPARATION * 0.999);
    });
  });

  it("caps the growth a near-zero taper would otherwise demand", () => {
    const spike = spikePocket();
    // 20 down to 2 is a ratio of ten, so the uncapped growth would be 0.1 mm.
    expect(cutPreviewCutterGrowth(spike)).toBeCloseTo(CUTTER_PADDING, 12);
    expect(cutPreviewCutterGrowth(spike)).toBeLessThanOrEqual(CUTTER_PADDING);
    // The cap costs the narrow end its full separation, which is the trade: a
    // highlight 0.05 mm proud at the mouth rather than one grown without bound.
    const scale = cutPreviewCutterScale(spike);
    expect((2 * scale.x - 2) / 2).toBeGreaterThan(CUT_PREVIEW_SEPARATION * 0.4);
  });

  it("grows a straight-sided hole by exactly the separation, which is almost every hole", () => {
    const hole = roundPocket();
    expect(cutPreviewCutterGrowth(hole)).toBe(CUT_PREVIEW_SEPARATION);
    const scale = cutPreviewCutterScale(hole);
    expect((shapeWidth(hole) * scale.x - shapeWidth(hole)) / 2).toBeCloseTo(CUT_PREVIEW_SEPARATION, 12);
    expect((shapeDepth(hole) * scale.z - shapeDepth(hole)) / 2).toBeCloseTo(CUT_PREVIEW_SEPARATION, 12);
    expect((hole.height * scale.y - hole.height) / 2).toBeCloseTo(CUT_PREVIEW_SEPARATION, 12);
  });

  it("measures a taper against its widest section, not its nominal size", () => {
    // A cutter flaring to 1.5x its nominal width: scaling by a factor worked out
    // from `width` would grow the mouth by half again the intended amount.
    const flared = shape({ kind: "box", width: 20, depth: 20, size: 20, height: 6, taperTopScale: 1.5 });
    const scale = cutPreviewCutterScale(flared);
    const widest = shapeTaperDimensions(flared).topWidth;
    expect(widest).toBeCloseTo(30, 9);
    expect((widest * scale.x - widest) / 2).toBeCloseTo(cutPreviewCutterGrowth(flared), 12);
  });

  it("asks for the hole as drawn, for the preview and for the exact cut alike", () => {
    const hole = roundPocket();
    expect(cutterShapeForBoolean(hole, "preview")).toBe(hole);
    expect(cutterShapeForBoolean(hole, "exact")).toBe(hole);
    // The mesh fallback still pads, and is still the only thing that does.
    const padded = cutterShapeForBoolean(hole, "mesh");
    expect(shapeWidth(padded)).toBeCloseTo(shapeWidth(hole) + CUTTER_PADDING * 2, 10);
    expect(padded.elevation).toBeCloseTo((hole.elevation ?? 0) - CUTTER_PADDING, 10);
  });

  it("stays within the separation of the exact cut, where it used to be four times that off", async () => {
    const cad = await serverCadKernel();
    const hole = roundPocket();
    const exact = measure(cad, committedCutterSolid(cad, hole, "exact"));
    const mesh = measure(cad, committedCutterSolid(cad, hole, "mesh"));
    const preview = measure(cad, previewCutterSolid(cad, hole));

    // What the highlight is off by now, against what the mesh cut would remove
    // if the fallback ran: the preview is nearer the exact cut by a factor of
    // several, which is the whole claim.
    const previewToExact = Math.abs(preview.volume - exact.volume);
    const meshToExact = Math.abs(mesh.volume - exact.volume);
    expect(previewToExact).toBeLessThan(meshToExact / 4);
  });
});
