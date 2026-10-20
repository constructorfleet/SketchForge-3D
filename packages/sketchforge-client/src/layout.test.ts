import { describe, expect, it } from "vitest";
import { centeredOffsets, grid, mm, ring, row } from "./layout.js";

describe("row", () => {
  it("centres an odd count on the centreline", () => {
    expect(row(5, 20).map((point) => point.x)).toEqual([-40, -20, 0, 20, 40]);
  });

  it("straddles the centreline for an even count", () => {
    expect(row(2, 10).map((point) => point.x)).toEqual([-5, 5]);
  });

  it("offsets the whole row by the centre", () => {
    expect(row(3, 10, { x: 100, z: 7 })).toEqual([
      { x: 90, z: 7 },
      { x: 100, z: 7 },
      { x: 110, z: 7 },
    ]);
  });

  it("refuses a fractional or empty count", () => {
    expect(() => row(2.5, 10)).toThrow(/whole count/);
    expect(() => row(0, 10)).toThrow(/whole count/);
  });

  it("puts a single position exactly on the centre", () => {
    expect(centeredOffsets(1, 25)).toEqual([0]);
  });
});

describe("grid", () => {
  it("walks columns within rows and spans both pitches", () => {
    expect(grid(3, 2, { x: 10, z: 4 })).toEqual([
      { x: -10, z: -2 },
      { x: 0, z: -2 },
      { x: 10, z: -2 },
      { x: -10, z: 2 },
      { x: 0, z: 2 },
      { x: 10, z: 2 },
    ]);
  });
});

describe("ring", () => {
  it("starts at three o'clock and goes round once", () => {
    const points = ring(4, 10).map((point) => ({ x: mm(point.x), z: mm(point.z) }));
    expect(points).toEqual([
      { x: 10, z: 0 },
      { x: 0, z: 10 },
      { x: -10, z: 0 },
      { x: -0, z: -10 },
    ]);
  });

  it("honours a start angle in degrees", () => {
    const [first] = ring(4, 10, { startAngle: 90 });
    expect(mm(first!.x)).toBe(0);
    expect(mm(first!.z)).toBe(10);
  });

  it("offsets the circle by its centre", () => {
    const [first] = ring(1, 5, { center: { x: 2, z: 3 } });
    expect({ x: mm(first!.x), z: mm(first!.z) }).toEqual({ x: 7, z: 3 });
  });

  it("spaces positions evenly whatever the count", () => {
    const points = ring(7, 25);
    const radii = points.map((point) => mm(Math.hypot(point.x, point.z)));
    expect(new Set(radii)).toEqual(new Set([25]));
  });
});
