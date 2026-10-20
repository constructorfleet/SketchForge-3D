import { describe, expect, it } from "vitest";
import {
  circularPatternPlacements,
  linearPatternPlacements,
  MAX_PATTERN_COUNT,
  MIN_PATTERN_COUNT,
  suggestedLinearStep,
} from "@/lib/patternShapes";

describe("linear patterns", () => {
  it("makes one fewer copy than the count, since the original is the first", () => {
    const placements = linearPatternPlacements({ count: 4, stepX: 20 });

    expect(placements.map((placement) => placement.dx)).toEqual([20, 40, 60]);
    expect(placements.every((placement) => placement.dz === 0)).toBe(true);
  });

  it("steps along both axes at once, for a diagonal row", () => {
    const placements = linearPatternPlacements({ count: 3, stepX: 10, stepZ: -5 });

    expect(placements).toEqual([
      { index: 1, dx: 10, dz: -5, rotation: 0 },
      { index: 2, dx: 20, dz: -10, rotation: 0 },
    ]);
  });

  it("does nothing when the step is zero, rather than stacking copies", () => {
    // Every copy would land on the original, which reads as a broken tool.
    expect(linearPatternPlacements({ count: 5, stepX: 0, stepZ: 0 })).toEqual([]);
    expect(linearPatternPlacements({ count: 5 })).toEqual([]);
  });

  it("keeps the count sane", () => {
    expect(linearPatternPlacements({ count: 1, stepX: 5 })).toHaveLength(MIN_PATTERN_COUNT - 1);
    expect(linearPatternPlacements({ count: 10_000, stepX: 5 })).toHaveLength(MAX_PATTERN_COUNT - 1);
    expect(linearPatternPlacements({ count: Number.NaN, stepX: 5 })).toHaveLength(MIN_PATTERN_COUNT - 1);
  });
});

describe("circular patterns", () => {
  const origin = { x: 20, z: 0 };

  it("spreads a full turn so the last copy does not sit on the first", () => {
    // Four around a full turn is every 90 degrees, not every 120.
    const placements = circularPatternPlacements({ count: 4, centerX: 0, centerZ: 0 }, origin);

    expect(placements).toHaveLength(3);
    // `+ 0` collapses the negative zero that rounding a turn produces.
    const round = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
    const positions = placements.map((placement) => ({
      x: round(origin.x + placement.dx),
      z: round(origin.z + placement.dz),
    }));
    expect(positions).toEqual([{ x: 0, z: 20 }, { x: -20, z: 0 }, { x: 0, z: -20 }]);
  });

  it("puts one at each end of a partial sweep", () => {
    // Three across a quarter turn means 0, 45 and 90 degrees -- an arc with
    // ends, not three quarters of a ring.
    const placements = circularPatternPlacements({ count: 3, centerX: 0, centerZ: 0, sweepAngle: 90 }, origin);

    const angles = placements.map((placement) => Math.round(
      (Math.atan2(origin.z + placement.dz, origin.x + placement.dx) * 180) / Math.PI,
    ));
    expect(angles).toEqual([45, 90]);
  });

  it("keeps every copy the same distance from the centre", () => {
    const placements = circularPatternPlacements({ count: 7, centerX: 5, centerZ: -3 }, origin);

    const radius = Math.hypot(origin.x - 5, origin.z + 3);
    for (const placement of placements) {
      expect(Math.hypot(origin.x + placement.dx - 5, origin.z + placement.dz + 3)).toBeCloseTo(radius, 9);
    }
  });

  it("turns each copy to follow the ring, unless told not to", () => {
    const turning = circularPatternPlacements({ count: 4, centerX: 0, centerZ: 0 }, origin);
    const fixed = circularPatternPlacements({ count: 4, centerX: 0, centerZ: 0, rotateCopies: false }, origin);

    // A spoke or a tooth has to turn with the ring; a bolt hole need not.
    expect(turning.map((placement) => placement.rotation)).toEqual([-90, -180, -270]);
    expect(fixed.every((placement) => placement.rotation === 0)).toBe(true);
    // Declining the rotation does not move anything.
    expect(fixed.map((placement) => placement.dx)).toEqual(turning.map((placement) => placement.dx));
  });

  it("does nothing for a sweep of zero", () => {
    expect(circularPatternPlacements({ count: 5, centerX: 0, centerZ: 0, sweepAngle: 0 }, origin)).toEqual([]);
  });

  it("still rings a selection sitting on the centre", () => {
    // Radius zero: the copies land on the centre too, which is degenerate but
    // must not produce NaN.
    const placements = circularPatternPlacements({ count: 3, centerX: 0, centerZ: 0 }, { x: 0, z: 0 });

    expect(placements).toHaveLength(2);
    expect(placements.every((placement) => Number.isFinite(placement.dx) && Number.isFinite(placement.dz))).toBe(true);
  });
});

describe("suggested step", () => {
  it("clears the selection rather than stacking on it", () => {
    expect(suggestedLinearStep(20)).toBeGreaterThan(20);
    expect(suggestedLinearStep(0)).toBeGreaterThanOrEqual(1);
  });
});
