import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { buildDraftPrism } from "@/lib/engine/draftPrism";
import type { SketchPoint, SketchProfile, SketchSegment } from "@/types/sketchforge";

// The editor's local Draft prism builder must accept the same profiles the
// REST draft does: segment order and drawing direction do not matter (#349).
const loop = (points: SketchPoint[], prefix = "edge"): SketchSegment[] => points.map((point, index) => ({
  id: `${prefix}-${index}`, startId: point.id, endId: points[(index + 1) % points.length].id, kind: "line",
}));
const rotated = (segments: SketchSegment[]) => [...segments.slice(2), ...segments.slice(0, 2)];
const reversed = (segments: SketchSegment[]) => segments.map(({ startId, endId, ...rest }) => ({ ...rest, startId: endId, endId: startId })).reverse();

const square: SketchPoint[] = [
  { id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: -20 },
  { id: "c", x: 20, z: 20 }, { id: "d", x: -20, z: 20 },
];
const pentagon: SketchPoint[] = [
  { id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: -20 },
  { id: "c", x: 20, z: 6 }, { id: "d", x: 2, z: 20 }, { id: "e", x: -20, z: 14 },
];

function measure(profile: SketchProfile) {
  return withCadKernel((cad) => {
    const result = buildDraftPrism(cad, { profile, height: 10, angle: 5 });
    return cad.queryBatch([cad.fromBREP(result.brep)])[0]!;
  });
}

function build(profile: SketchProfile) {
  return withCadKernel((cad) => buildDraftPrism(cad, { profile, height: 10, angle: 5 }));
}

describe("editor draft prism profile order (#349)", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it.each([["square", square], ["asymmetric pentagon", pentagon]])(
    "drafts a %s identically whatever the segment order or direction",
    async (_name, points) => {
      const segments = loop(points);
      const ordered = await measure({ points, segments });
      expect(ordered.volume).toBeGreaterThan(0);
      for (const variant of [rotated(segments), reversed(segments), rotated(reversed(segments))]) {
        const actual = await measure({ points, segments: variant });
        expect(Math.abs(actual.volume - ordered.volume)).toBeLessThan(1e-6);
        expect(actual.centerOfMass.x).toBeCloseTo(ordered.centerOfMass.x, 6);
        expect(actual.centerOfMass.y).toBeCloseTo(ordered.centerOfMass.y, 6);
        expect(actual.centerOfMass.z).toBeCloseTo(ordered.centerOfMass.z, 6);
      }
    },
  );

  it("refuses a curved profile and says the curve is the reason", async () => {
    const points = square.map((point, index) => index === 1
      ? { ...point, handleOut: { x: 26, z: -10 } }
      : index === 2 ? { ...point, handleIn: { x: 26, z: 10 } } : point);
    const segments = loop(points).map((segment, index) => index === 1 ? { ...segment, kind: "bezier" as const } : segment);
    await expect(build({ points, segments })).rejects.toThrow(/straight segments.*curved/);
  });

  it("refuses an outline that crosses itself and says so", async () => {
    const points: SketchPoint[] = [{ id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: 20 }, { id: "c", x: 20, z: -20 }, { id: "d", x: -20, z: 40 }];
    await expect(build({ points, segments: loop(points) })).rejects.toThrow(/crosses itself/);
  });

  it("refuses a profile with a hole and says the hole is the reason", async () => {
    const hole: SketchPoint[] = [
      { id: "h1", x: -5, z: -5 }, { id: "h2", x: 5, z: -5 },
      { id: "h3", x: 5, z: 5 }, { id: "h4", x: -5, z: 5 },
    ];
    await expect(build({ points: [...square, ...hole], segments: [...loop(square), ...loop(hole, "hole")] }))
      .rejects.toThrow(/hole/);
  });

  it("refuses a profile with several separate regions and says so", async () => {
    const other: SketchPoint[] = [
      { id: "o1", x: 30, z: -5 }, { id: "o2", x: 40, z: -5 },
      { id: "o3", x: 40, z: 5 }, { id: "o4", x: 30, z: 5 },
    ];
    await expect(build({ points: [...square, ...other], segments: [...loop(square), ...loop(other, "other")] }))
      .rejects.toThrow(/2 separate closed regions/);
  });
});
