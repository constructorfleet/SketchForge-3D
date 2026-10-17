import { describe, expect, it } from "vitest";
import { gridAlignedDelta, snapDimension, snapToGrid } from "@/lib/gridSnap";

describe("snapToGrid", () => {
  it("rounds to the nearest multiple of the step", () => {
    expect(snapToGrid(6, 5)).toBe(5);
    expect(snapToGrid(7.6, 5)).toBe(10);
    expect(snapToGrid(-6, 5)).toBe(-5);
    expect(snapToGrid(12.4, 0.5)).toBe(12.5);
  });

  it("leaves the value alone when the grid is off", () => {
    expect(snapToGrid(6.3, 0)).toBe(6.3);
    expect(snapToGrid(6.3, -1)).toBe(6.3);
  });
});

describe("snapDimension", () => {
  // Upstream issue #117: a 1mm box resized with the grid at 5mm jumped to 6mm,
  // because the *change* was snapped and added to the starting height. The size
  // itself has to land on the grid, the way width and depth already did.
  it("lands a resized dimension on the grid, not a step away from where it started", () => {
    expect(snapDimension(1 + 5, 5, 0.01, 180)).toBe(5);
    expect(snapDimension(1 + 2.4, 5, 0.01, 180)).toBe(5);
    expect(snapDimension(1 + 9, 5, 0.01, 180)).toBe(10);
  });

  it("stays on the grid from any starting size", () => {
    for (const start of [0.5, 1, 1.7, 3, 4.9, 7.2, 13]) {
      for (const drag of [-3, -0.4, 0.4, 2, 6.1, 11]) {
        const result = snapDimension(start + drag, 5, 0.01, 180);
        expect(result % 5, `start=${start} drag=${drag}`).toBeCloseTo(0, 9);
      }
    }
  });

  it("never snaps below one whole step, so the result is never off-grid", () => {
    expect(snapDimension(0.2, 5, 0.01, 180)).toBe(5);
    expect(snapDimension(-4, 5, 0.01, 180)).toBe(5);
  });

  it("respects the maximum", () => {
    expect(snapDimension(1000, 5, 0.01, 180)).toBe(180);
  });

  it("falls back to the raw minimum when the grid is off", () => {
    expect(snapDimension(3.37, 0, 0.01, 180)).toBeCloseTo(3.37, 9);
    expect(snapDimension(0, 0, 0.01, 180)).toBe(0.01);
  });
});

describe("gridAlignedDelta", () => {
  // The lift handle moved a selection by a whole number of steps from wherever
  // it happened to sit, so an object at 1mm stayed off-grid forever.
  it("moves to the grid rather than by the grid", () => {
    expect(1 + gridAlignedDelta(1, 5, 5)).toBe(5);
    expect(1 + gridAlignedDelta(1, 2.4, 5)).toBe(5);
    expect(1 + gridAlignedDelta(1, 9, 5)).toBe(10);
  });

  it("lands on the grid from any starting height", () => {
    for (const start of [0, 0.3, 1, 2.5, 4.9, 11.2]) {
      for (const drag of [-7, -1.2, 0, 0.9, 3, 8.6]) {
        const landed = start + gridAlignedDelta(start, drag, 5);
        expect(landed % 5, `start=${start} drag=${drag}`).toBeCloseTo(0, 9);
      }
    }
  });

  it("keeps a selection that is already aligned on its line for a small nudge", () => {
    expect(10 + gridAlignedDelta(10, 0.4, 5)).toBe(10);
  });

  it("passes the movement straight through when the grid is off", () => {
    expect(gridAlignedDelta(1, 3.7, 0)).toBeCloseTo(3.7, 9);
  });

  it("moves every member of a selection by the same amount, preserving spacing", () => {
    // The viewport applies one delta to every item, so relative offsets survive.
    const delta = gridAlignedDelta(1, 5, 5);
    const before = [1, 4, 9];
    const after = before.map((value) => value + delta);
    expect(after).toEqual([5, 8, 13]);
  });
});
