import { describe, expect, it } from "vitest";
import { CUTTER_PADDING, paddedCutterShape } from "@sketchforge/engine/cutterPadding";
import { shapeDepth, shapeTaperDimensions, shapeWidth } from "@sketchforge/engine/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "hole", name: "hole", kind: "box", color: "#000",
    x: 0, z: 0, elevation: 0, size: 20, width: 20, depth: 20, height: 20, rotation: 0,
    ...overrides,
  };
}

const grown = (before: number) => before + CUTTER_PADDING * 2;

describe("padded cutter shape", () => {
  it("grows the generic size on every axis and drops the base to match", () => {
    const padded = paddedCutterShape(shape({ elevation: 5 }));
    expect(shapeWidth(padded)).toBeCloseTo(grown(20), 10);
    expect(shapeDepth(padded)).toBeCloseTo(grown(20), 10);
    expect(padded.height).toBeCloseTo(grown(20), 10);
    expect(padded.elevation).toBeCloseTo(5 - CUTTER_PADDING, 10);
  });

  it("grows a loft's independent top end with the rest", () => {
    // The top end's size is absolute, not a fraction of width/depth. Padding
    // only the generic size would narrow the cutter toward its top, so the hole
    // comes out the wrong shape and its top stays coplanar with the solid.
    const padded = paddedCutterShape(shape({ kind: "loft", loftTopWidth: 12, loftTopDepth: 8 }));
    expect(padded.loftTopWidth).toBeCloseTo(grown(12), 10);
    expect(padded.loftTopDepth).toBeCloseTo(grown(8), 10);
  });

  it("leaves a loft end alone when it has none of its own", () => {
    const padded = paddedCutterShape(shape({ kind: "loft" }));
    expect(padded.loftTopWidth).toBeUndefined();
    expect(padded.loftTopDepth).toBeUndefined();
  });

  it("grows the absolute taper dimensions with the rest", () => {
    const padded = paddedCutterShape(shape({
      taperTopWidth: 10, taperTopDepth: 10, taperBottomWidth: 20, taperBottomDepth: 20,
    }));
    const taper = shapeTaperDimensions(padded);
    expect(taper.topWidth).toBeCloseTo(grown(10), 10);
    expect(taper.topDepth).toBeCloseTo(grown(10), 10);
    expect(taper.bottomWidth).toBeCloseTo(grown(20), 10);
    expect(taper.bottomDepth).toBeCloseTo(grown(20), 10);
  });

  it("offsets a tapered cutter outward instead of reshaping it", () => {
    // Every horizontal section must grow by the same amount, top and bottom
    // alike: that is what makes the result an offset rather than a new taper.
    const original = shape({ taperTopWidth: 10, taperBottomWidth: 20 });
    const padded = paddedCutterShape(original);
    const before = shapeTaperDimensions(original);
    const after = shapeTaperDimensions(padded);
    expect(after.topWidth - before.topWidth).toBeCloseTo(after.bottomWidth - before.bottomWidth, 10);
  });

  it("keeps the relative taper scales untouched, since they follow the padded size", () => {
    const padded = paddedCutterShape(shape({ taperTopScale: 0.5 }));
    expect(padded.taperTopScale).toBe(0.5);
    // 0.5 of a padded width is still half the cutter, which is what we want.
    expect(shapeTaperDimensions(padded).topWidth).toBeCloseTo(grown(20) * 0.5, 10);
  });

  it("still pads a cone's base radius", () => {
    const padded = paddedCutterShape(shape({ kind: "cone", baseRadius: 10 }));
    expect(padded.baseRadius).toBeCloseTo(10 + CUTTER_PADDING, 10);
  });
});
