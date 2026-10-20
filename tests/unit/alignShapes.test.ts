import { describe, expect, it } from "vitest";
import {
  alignCoordinate,
  alignShifts,
  effectiveAlignAnchorId,
  type AlignEntry,
} from "@/lib/engine/alignShapes";

/**
 * Three objects of three different widths, none of them centred on the origin
 * and no two of them the same size.
 *
 * Deliberately so. A symmetric row -- equal widths, or a span centred on zero
 * -- makes `min`, `center` and `max` agree up to a sign, and makes a shift
 * computed from the wrong edge land in the right place anyway. Here every one
 * of the nine (axis, target) answers is a different number.
 */
const WIDE: AlignEntry = { id: "wide", min: 10, max: 30 };
const NARROW: AlignEntry = { id: "narrow", min: 47, max: 52 };
const TALL: AlignEntry = { id: "tall", min: 80, max: 110 };
const ROW = [WIDE, NARROW, TALL];

function shiftMap(entries: readonly AlignEntry[], target: Parameters<typeof alignShifts>[1], anchorId?: string | null) {
  return Object.fromEntries(alignShifts(entries, target, anchorId).map((shift) => [shift.id, shift.delta]));
}

describe("aligning to the selection's own box", () => {
  it("brings every low edge onto the lowest one", () => {
    // The selection spans 10..110, so `min` is 10 -- which is where `wide`
    // already is, so it is absent rather than listed with a zero delta.
    expect(shiftMap(ROW, "min")).toEqual({ narrow: -37, tall: -70 });
  });

  it("brings every high edge onto the highest one", () => {
    expect(shiftMap(ROW, "max")).toEqual({ wide: 80, narrow: 58 });
  });

  it("brings every centre onto the centre of the whole span", () => {
    // (10 + 110) / 2 = 60, and each object's own centre is its own midpoint:
    // 20, 49.5 and 95. A centre read as a min would give 50, 13 and -20.
    expect(shiftMap(ROW, "center")).toEqual({ wide: 40, narrow: 10.5, tall: -35 });
  });

  it("reports the edge or centre each target names", () => {
    expect(alignCoordinate(NARROW, "min")).toBe(47);
    expect(alignCoordinate(NARROW, "center")).toBe(49.5);
    expect(alignCoordinate(NARROW, "max")).toBe(52);
  });
});

describe("aligning to an anchor", () => {
  it("lines the others up on the anchor and leaves the anchor alone", () => {
    // `narrow` is the middle object, so anchoring on it moves both neighbours
    // and in opposite directions -- which anchoring on an outer one would not.
    expect(shiftMap(ROW, "center", "narrow")).toEqual({ wide: 29.5, tall: -45.5 });
  });

  it("ignores an anchor that is not in the selection", () => {
    expect(shiftMap(ROW, "min", "elsewhere")).toEqual(shiftMap(ROW, "min"));
    expect(effectiveAlignAnchorId(ROW, "elsewhere")).toBeNull();
  });

  it("makes a locked object the anchor over the one the caller asked for", () => {
    // A locked object cannot move, so a selection holding one can only be
    // aligned *to* it. Anything else would either move it or refuse the
    // request outright.
    const locked = [WIDE, NARROW, { ...TALL, locked: true }];

    expect(effectiveAlignAnchorId(locked, "narrow")).toBe("tall");
    expect(shiftMap(locked, "min", effectiveAlignAnchorId(locked, "narrow"))).toEqual({ wide: 70, narrow: 33 });
  });

  it("never moves a locked object, even when something else is the anchor", () => {
    const locked = [WIDE, { ...NARROW, locked: true }, TALL];

    expect(shiftMap(locked, "max", "tall")).toEqual({ wide: 80 });
  });
});

describe("alignments that are not worth recording", () => {
  it("has nothing to align one object to", () => {
    expect(alignShifts([WIDE], "center")).toEqual([]);
    expect(alignShifts([], "center")).toEqual([]);
  });

  it("leaves out an object already within a ten-thousandth of place", () => {
    // Coordinates are stored to four decimals, so a shift smaller than this
    // cannot be written down -- and an unchanged selection should record no
    // undo step rather than one that changes nothing.
    const nearlyFlush = [WIDE, { id: "nearly", min: 10.0004, max: 25 }];

    expect(alignShifts(nearlyFlush, "min")).toEqual([]);
  });

  it("still reports a shift just above that tolerance", () => {
    // The other side of the same boundary: the epsilon is a rounding
    // allowance, not a licence to ignore a real tenth of a millimetre.
    const offBy = [WIDE, { id: "off", min: 10.1, max: 25 }];
    const shifts = alignShifts(offBy, "min");

    expect(shifts.map((shift) => shift.id)).toEqual(["off"]);
    expect(shifts[0].delta).toBeCloseTo(-0.1, 9);
  });
});
