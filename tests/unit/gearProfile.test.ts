import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEAR_HELIX_ANGLE,
  DEFAULT_GEAR_HELIX_QUALITY,
  DEFAULT_GEAR_TEETH,
  DEFAULT_GEAR_TOOTH_SIZE,
  DEFAULT_GEAR_TYPE,
  gearCenterHoleLimits,
  gearSettings,
  gearToothPitch,
  normalizeGearCenterHoleSize,
  normalizeGearHelixAngle,
  normalizeGearHelixQuality,
  normalizeGearTeeth,
  normalizeGearToothSize,
  normalizeGearToothWidth,
  normalizeGearType,
} from "@sketchforge/engine/gearProfile";
import type { GearType } from "@/types/sketchforge";

// Direct coverage of the gear's pure half, now that `gearProfile` can be imported without the
// mesh builder. The numbers below are deliberately asymmetric -- width != depth, and a stored
// value that differs from both the default and the clamp bound -- so a normalizer that reads the
// wrong dimension, returns its default, or clamps to the wrong end is visible.
const WIDTH = 30;
const DEPTH = 24;

describe("gear normalizers", () => {
  it("clamps tooth count to a buildable range and rounds a fractional one", () => {
    expect(normalizeGearTeeth(17)).toBe(17);
    expect(normalizeGearTeeth(16.6)).toBe(17);
    expect(normalizeGearTeeth(5)).toBe(6);
    expect(normalizeGearTeeth(65)).toBe(64);
    expect(normalizeGearTeeth(undefined)).toBe(DEFAULT_GEAR_TEETH);
    expect(normalizeGearTeeth(Number.NaN)).toBe(DEFAULT_GEAR_TEETH);
  });

  it("accepts only the three gear types and defaults the rest", () => {
    expect(normalizeGearType("helical")).toBe("helical");
    expect(normalizeGearType("bevel")).toBe("bevel");
    expect(normalizeGearType("spur")).toBe(DEFAULT_GEAR_TYPE);
    expect(normalizeGearType("Helical")).toBe(DEFAULT_GEAR_TYPE);
    expect(normalizeGearType(undefined)).toBe(DEFAULT_GEAR_TYPE);
    expect(DEFAULT_GEAR_TYPE).toBe("spur");
  });

  it("caps tooth size against the smaller of width and depth, not the larger", () => {
    // 22% of the *smaller* dimension: 24 * 0.22 = 5.28, where the wider 30 would give 6.6.
    expect(normalizeGearToothSize(4, WIDTH, DEPTH)).toBe(4);
    expect(normalizeGearToothSize(20, WIDTH, DEPTH)).toBeCloseTo(5.28, 12);
    expect(normalizeGearToothSize(20, DEPTH, WIDTH)).toBeCloseTo(5.28, 12);
    expect(normalizeGearToothSize(0, WIDTH, DEPTH)).toBe(0.2);
    expect(normalizeGearToothSize(undefined, WIDTH, DEPTH)).toBe(DEFAULT_GEAR_TOOTH_SIZE);
    // A gear so small that 22% of it is under the floor still gets the floor, not a negative cap.
    expect(normalizeGearToothSize(1, 0.1, 0.1)).toBe(0.2);
  });

  it("derives tooth pitch from the pitch circle of the smaller dimension", () => {
    expect(gearToothPitch(WIDTH, DEPTH, 12)).toBeCloseTo((Math.PI * 24) / 12, 12);
    expect(gearToothPitch(DEPTH, WIDTH, 12)).toBeCloseTo((Math.PI * 24) / 12, 12);
    // More teeth on the same blank means a finer pitch, in exact proportion.
    expect(gearToothPitch(WIDTH, DEPTH, 24)).toBeCloseTo(gearToothPitch(WIDTH, DEPTH, 12) / 2, 12);
    // The tooth count is itself normalized first, so an out-of-range one does not divide by it.
    expect(gearToothPitch(WIDTH, DEPTH, 200)).toBeCloseTo(gearToothPitch(WIDTH, DEPTH, 64), 12);
    expect(gearToothPitch(WIDTH, DEPTH, undefined)).toBeCloseTo(gearToothPitch(WIDTH, DEPTH, DEFAULT_GEAR_TEETH), 12);
  });

  it("keeps tooth width a fraction of the pitch, so neighbouring teeth cannot merge", () => {
    const pitch = gearToothPitch(WIDTH, DEPTH, 17);
    expect(normalizeGearToothWidth(undefined, WIDTH, DEPTH, 17)).toBeCloseTo(pitch * 0.54, 12);
    expect(normalizeGearToothWidth(pitch * 0.4, WIDTH, DEPTH, 17)).toBeCloseTo(pitch * 0.4, 12);
    expect(normalizeGearToothWidth(pitch * 5, WIDTH, DEPTH, 17)).toBeCloseTo(pitch * 0.82, 12);
    expect(normalizeGearToothWidth(0, WIDTH, DEPTH, 17)).toBeCloseTo(pitch * 0.12, 12);
    // Never the whole pitch: a tooth as wide as its pitch leaves no gap for the mating gear.
    expect(normalizeGearToothWidth(pitch * 5, WIDTH, DEPTH, 17)).toBeLessThan(pitch);
  });

  it("limits the bore to the root circle it is cut out of", () => {
    const outerRadius = DEPTH / 2;
    const rootRadius = Math.max(outerRadius * 0.34, outerRadius - 4);
    expect(gearCenterHoleLimits(WIDTH, DEPTH, 4)).toEqual({ min: 0, max: rootRadius * 1.5 });
    // A bigger tooth eats into the root circle, so the bore limit shrinks with it.
    expect(gearCenterHoleLimits(WIDTH, DEPTH, 5).max).toBeLessThan(gearCenterHoleLimits(WIDTH, DEPTH, 2).max);

    // The tooth size is normalized before the root radius is taken, and that cap (22% of the
    // smaller dimension, i.e. 44% of the radius) always leaves at least 56% of the radius -- so
    // at any ordinary size an unbounded tooth size does NOT reach the 34% root floor. Asking for
    // a 1000mm tooth on a 30x24 gear lands on the cap, not on the floor.
    const cappedTooth = normalizeGearToothSize(1000, WIDTH, DEPTH);
    expect(gearCenterHoleLimits(WIDTH, DEPTH, 1000).max).toBeCloseTo((outerRadius - cappedTooth) * 1.5, 12);
    expect(gearCenterHoleLimits(WIDTH, DEPTH, 1000).max).toBeGreaterThan(outerRadius * 0.34 * 1.5);

    // The floor is reachable only below the 0.2mm tooth-size floor's break-even diameter (~0.91mm),
    // where the smallest tooth is more than 66% of the radius. It keeps the limit positive there.
    expect(gearCenterHoleLimits(0.5, 0.5, 1000).max).toBeCloseTo(0.25 * 0.34 * 1.5, 12);
    expect(gearCenterHoleLimits(0, 0, 4).max).toBeGreaterThan(0);
  });

  it("clamps the bore to those limits and allows a solid centre", () => {
    const { max } = gearCenterHoleLimits(WIDTH, DEPTH, 4);
    expect(normalizeGearCenterHoleSize(7, WIDTH, DEPTH, 4)).toBe(7);
    expect(normalizeGearCenterHoleSize(max + 10, WIDTH, DEPTH, 4)).toBeCloseTo(max, 12);
    expect(normalizeGearCenterHoleSize(-5, WIDTH, DEPTH, 4)).toBe(0);
    // Zero is a real value, not a missing one: it means "no bore", and must survive.
    expect(normalizeGearCenterHoleSize(0, WIDTH, DEPTH, 4)).toBe(0);
    // The default bore is inside the limits and strictly positive, for every tooth size.
    for (const toothSize of [0.2, 1, 2.5, 4, 5.28]) {
      const fallback = normalizeGearCenterHoleSize(undefined, WIDTH, DEPTH, toothSize);
      expect(fallback).toBeGreaterThan(0);
      expect(fallback).toBeLessThanOrEqual(gearCenterHoleLimits(WIDTH, DEPTH, toothSize).max);
    }
    // At any ordinary size the default is 40% of the outer radius, because the root-circle term
    // it is also capped by never bites -- the same reason the 34% floor above does not. It is the
    // smaller of the two only on a sub-millimetre gear, where the 0.2mm tooth-size floor leaves
    // almost no web between the root circle and the bore.
    expect(normalizeGearCenterHoleSize(undefined, WIDTH, DEPTH, 2.5)).toBeCloseTo((DEPTH / 2) * 0.4, 12);
    expect(normalizeGearCenterHoleSize(undefined, 0.5, 0.5, 2.5)).toBeCloseTo(0.25 * 0.34 * 1.1, 12);
    expect(normalizeGearCenterHoleSize(undefined, 0.5, 0.5, 2.5)).toBeLessThan(0.25 * 0.4);
  });

  it("clamps the helix angle symmetrically about zero and keeps its sign", () => {
    expect(normalizeGearHelixAngle(37)).toBe(37);
    expect(normalizeGearHelixAngle(-37)).toBe(-37);
    expect(normalizeGearHelixAngle(90)).toBe(45);
    expect(normalizeGearHelixAngle(-90)).toBe(-45);
    expect(normalizeGearHelixAngle(undefined)).toBe(DEFAULT_GEAR_HELIX_ANGLE);
    expect(normalizeGearHelixAngle(Number.NaN)).toBe(DEFAULT_GEAR_HELIX_ANGLE);
  });

  it("clamps and rounds helix quality to a ring count the mesher can sweep", () => {
    expect(normalizeGearHelixQuality(17)).toBe(17);
    expect(normalizeGearHelixQuality(16.6)).toBe(17);
    expect(normalizeGearHelixQuality(3)).toBe(4);
    expect(normalizeGearHelixQuality(33)).toBe(32);
    expect(normalizeGearHelixQuality(undefined)).toBe(DEFAULT_GEAR_HELIX_QUALITY);
    expect(normalizeGearHelixQuality(Number.NaN)).toBe(DEFAULT_GEAR_HELIX_QUALITY);
    // At least two rings, or a helical gear has no height to twist over.
    expect(normalizeGearHelixQuality(-100)).toBeGreaterThan(1);
  });

  it("routes every gear field through its own normalizer, with no two fields crossed", () => {
    // Each stored value is out of range in its own direction, and every expected output is
    // distinct, so swapping any two fields or clamping to the wrong bound changes the result.
    expect(gearSettings({
      width: WIDTH,
      depth: DEPTH,
      teeth: 65,
      toothSize: 20,
      toothWidth: 0,
      centerHoleSize: 1000,
      gearType: "helical" as GearType,
      helixAngle: -90,
      helixQuality: 33,
    })).toEqual({
      teeth: 64,
      toothSize: normalizeGearToothSize(20, WIDTH, DEPTH),
      toothWidth: normalizeGearToothWidth(0, WIDTH, DEPTH, 65),
      centerHoleSize: normalizeGearCenterHoleSize(1000, WIDTH, DEPTH, 20),
      gearType: "helical",
      helixAngle: -45,
      helixQuality: 32,
    });
  });

  it("derives the dependent fields from the same values whether or not they were normalized first", () => {
    // `gearSettings` forwards the raw `shape.teeth` and `shape.toothSize` to the normalizers that
    // depend on them, rather than the values it just normalized. That is safe only because those
    // normalizers re-normalize their inputs -- `gearToothPitch` calls `normalizeGearTeeth`, and
    // `normalizeGearCenterHoleSize` calls `normalizeGearToothSize`, both idempotent. Pin the
    // idempotency, so the shortcut stays a shortcut rather than becoming a discrepancy.
    const settings = gearSettings({ width: WIDTH, depth: DEPTH, teeth: 65, toothSize: 20, toothWidth: 0, centerHoleSize: 1000 });
    expect(settings.toothWidth).toBeCloseTo(normalizeGearToothWidth(0, WIDTH, DEPTH, settings.teeth), 12);
    expect(settings.centerHoleSize).toBeCloseTo(normalizeGearCenterHoleSize(1000, WIDTH, DEPTH, settings.toothSize), 12);
    expect(settings.toothWidth).toBeCloseTo(gearToothPitch(WIDTH, DEPTH, 65) * 0.12, 12);
    expect(settings.centerHoleSize).toBeCloseTo(gearCenterHoleLimits(WIDTH, DEPTH, 20).max, 12);
  });

  it("answers the same for a gear and for the same gear turned a quarter turn", () => {
    // Worth stating rather than leaving implicit: every normalizer here reads width and depth
    // only through `Math.min`, so the whole profile half is symmetric in the two and crossing
    // them changes nothing. The mesh builder is not -- `outerX` is width and `outerZ` is depth --
    // so a crossed pair is a mesh bug, and a test of this half cannot be the one that finds it.
    const shape = { width: WIDTH, depth: DEPTH, teeth: 17, toothSize: 4, centerHoleSize: 7 };
    expect(gearSettings(shape)).toEqual(gearSettings({ ...shape, width: DEPTH, depth: WIDTH }));
  });

  it("gives every default when the stored shape carries only its dimensions", () => {
    expect(gearSettings({ width: WIDTH, depth: DEPTH })).toEqual({
      teeth: DEFAULT_GEAR_TEETH,
      toothSize: DEFAULT_GEAR_TOOTH_SIZE,
      toothWidth: normalizeGearToothWidth(undefined, WIDTH, DEPTH, undefined),
      centerHoleSize: normalizeGearCenterHoleSize(undefined, WIDTH, DEPTH, undefined),
      gearType: DEFAULT_GEAR_TYPE,
      helixAngle: DEFAULT_GEAR_HELIX_ANGLE,
      helixQuality: DEFAULT_GEAR_HELIX_QUALITY,
    });
  });
});
