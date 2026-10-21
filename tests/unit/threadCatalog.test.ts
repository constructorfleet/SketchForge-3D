import { describe, expect, it } from "vitest";
import { resolveThreadRequest } from "@constructorfleet/sketchforge-engine";
import {
  DEFAULT_HOLE_CLEARANCE,
  DEFAULT_THREAD_SIZE,
  THREAD_SIZES,
  threadGeometry,
  threadSize,
  threadSizesInSeries,
  threadTurnsForLength,
} from "@constructorfleet/sketchforge-engine/threadCatalog";

describe("thread catalog", () => {
  it("knows the coarse pitch for each metric size", () => {
    // ISO 261 coarse: getting these wrong makes a part that looks right and
    // does not fit, which is the whole reason the catalog exists.
    const expected: Record<string, number> = {
      M2: 0.4, "M2.5": 0.45, M3: 0.5, M4: 0.7, M5: 0.8,
      M6: 1, M8: 1.25, M10: 1.5, M12: 1.75, M16: 2, M20: 2.5,
    };
    for (const [designation, pitch] of Object.entries(expected)) {
      expect(threadSize(designation)?.pitch, designation).toBe(pitch);
    }
  });

  it("converts unified sizes from inches and threads per inch", () => {
    // 1/4-20: a quarter inch is 6.35mm, and 20 TPI is 25.4/20 = 1.27mm pitch.
    expect(threadSize("1/4-20")).toMatchObject({ diameter: 6.35, pitch: 1.27 });
    expect(threadSize("#6-32")?.pitch).toBeCloseTo(25.4 / 32, 3);
  });

  it("looks up common metric fine and UNF sizes without changing coarse entries", () => {
    expect(threadSize("M8x1")).toMatchObject({ designation: "M8x1", series: "metric-fine", diameter: 8, pitch: 1 });
    expect(threadSize("M10 x 1.25")?.pitch).toBe(1.25);
    expect(threadSize("1/4-28 UNF")).toMatchObject({ series: "unified-fine", diameter: 6.35 });
    expect(threadSize("1/4-28 UNF")?.pitch).toBeCloseTo(25.4 / 28, 8);
    expect(threadSize("5/16-24 UNF")?.diameter).toBe(7.9375);
    expect(threadSize("#6-40 UNF")?.pitch).toBe(0.635);
    expect(resolveThreadRequest({ size: "1/4-28 UNF" })).toMatchObject({ pitch: 25.4 / 28, designation: "1/4-28 UNF" });
    expect(resolveThreadRequest({ size: "M8x1" })).toMatchObject({ pitch: 1, designation: "M8x1" });
    expect(threadSize("M8")?.pitch).toBe(1.25);
    expect(threadSize("1/4-20")?.pitch).toBe(1.27);
    expect(threadSizesInSeries("metric-fine").length).toBeGreaterThan(0);
    expect(threadSizesInSeries("unified-fine").length).toBeGreaterThan(0);
  });

  it("keeps every added fine-series pitch in the catalog", () => {
    const metricFine: Record<string, number> = {
      "M6x0.75": 0.75, "M8x1": 1, "M10x1.25": 1.25, "M10x1": 1,
      "M12x1.5": 1.5, "M12x1.25": 1.25, "M14x1.5": 1.5,
      "M16x1.5": 1.5, "M18x1.5": 1.5, "M20x1.5": 1.5,
    };
    const unifiedFine: Record<string, number> = {
      "#4-48 UNF": 0.5292, "#6-40 UNF": 0.635, "#8-36 UNF": 0.7056,
      "#10-32 UNF": 0.7938, "#12-28 UNF": 0.9071, "1/4-28 UNF": 0.9071,
      "5/16-24 UNF": 1.0583, "3/8-24 UNF": 1.0583, "7/16-20 UNF": 1.27,
      "1/2-20 UNF": 1.27,
    };
    for (const [designation, pitch] of Object.entries(metricFine)) {
      expect(threadSize(designation)?.pitch, designation).toBe(pitch);
    }
    for (const [designation, pitch] of Object.entries(unifiedFine)) {
      expect(threadSize(designation)?.pitch, designation).toBeCloseTo(pitch, 4);
    }
  });

  it("finds a size however it is written", () => {
    expect(threadSize("m8")?.designation).toBe("M8");
    expect(threadSize("M 8")?.designation).toBe("M8");
    expect(threadSize("M7")).toBeNull();
    expect(threadSize("")).toBeNull();
  });

  it("has a default that is in the catalog", () => {
    expect(threadSize(DEFAULT_THREAD_SIZE)).not.toBeNull();
  });

  it("splits every series", () => {
    expect(threadSizesInSeries("metric").every((size) => size.designation.startsWith("M"))).toBe(true);
    expect(
      (["metric", "metric-fine", "unified", "unified-fine"] as const)
        .flatMap((series) => threadSizesInSeries(series)).length,
    ).toBe(THREAD_SIZES.length);
  });

  it("cuts a tapped hole wider than the bolt, by the clearance on each side", () => {
    const size = threadSize("M8")!;

    const solid = threadGeometry(size);
    const hole = threadGeometry(size, { hole: true });

    expect(solid.diameter).toBe(8);
    expect(solid.clearance).toBe(0);
    expect(hole.diameter).toBeCloseTo(8 + DEFAULT_HOLE_CLEARANCE * 2, 6);
    // The pitch is the thread's identity: a hole for an M8 is still 1.25mm.
    expect(hole.pitch).toBe(solid.pitch);
    expect(hole.hole).toBe(true);
  });

  it("takes a clearance for the machine in hand, and refuses a negative one", () => {
    const size = threadSize("M4")!;

    expect(threadGeometry(size, { hole: true, clearance: 0.4 }).diameter).toBeCloseTo(4.8, 6);
    expect(threadGeometry(size, { hole: true, clearance: 0 }).diameter).toBe(4);
    expect(threadGeometry(size, { hole: true, clearance: -1 }).diameter).toBe(4);
    // Clearance is for holes: a bolt cut undersize would not hold.
    expect(threadGeometry(size, { clearance: 0.4 }).diameter).toBe(4);
  });

  it("works out the turns that cover a length of thread", () => {
    expect(threadTurnsForLength(1.25, 10)).toBe(8);
    expect(threadTurnsForLength(0.5, 3)).toBe(6);
    // Always at least one turn, whatever nonsense it is given.
    expect(threadTurnsForLength(1.25, 0)).toBe(1);
    expect(threadTurnsForLength(0, 10)).toBe(1);
  });
});
