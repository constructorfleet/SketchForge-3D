import { describe, expect, it } from "vitest";
import { placementWorkplaneFromSurface } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { deriveSketchSweepFrames, sketchSweepSpinePointInSection } from "@constructorfleet/sketchforge-engine/sketchSweepFrames";

describe("sweep workplane frames", () => {
  it.each([
    ["horizontal", { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }],
    ["vertical", { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
    ["tilted", { x: 1, y: 2, z: 3 }, { x: -2, y: 1, z: 0 }],
  ] as const)("derives a perpendicular spine plane for a %s section", (_label, normal, tangent) => {
    const section = placementWorkplaneFromSurface({ x: 4, y: -3, z: 8 }, normal, tangent);
    const frames = deriveSketchSweepFrames(section);
    const { spine } = frames;
    const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
      a.x * b.x + a.y * b.y + a.z * b.z;

    expect(spine.origin).toEqual(section.origin);
    expect(spine.xAxis).toEqual(section.normal);
    expect(spine.zAxis).toEqual(section.xAxis);
    expect(dot(spine.normal, section.normal)).toBeCloseTo(0, 8);
    expect(dot(spine.normal, section.xAxis)).toBeCloseTo(0, 8);
    expect(dot(spine.xAxis, spine.zAxis)).toBeCloseTo(0, 8);
    const right = sketchSweepSpinePointInSection(frames, { x: 10, z: 0 });
    const up = sketchSweepSpinePointInSection(frames, { x: 0, z: 10 });
    expect(right.x).toBeCloseTo(0, 8);
    expect(right.y).toBeCloseTo(10, 8);
    expect(right.z).toBeCloseTo(0, 8);
    expect(up.x).toBeCloseTo(10, 8);
    expect(up.y).toBeCloseTo(0, 8);
    expect(up.z).toBeCloseTo(0, 8);
  });
});
