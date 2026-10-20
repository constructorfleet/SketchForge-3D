import { describe, expect, it } from "vitest";
import { distributeShifts, widestDistributeAxis, type DistributeEntry } from "@constructorfleet/sketchforge-engine/distributeShapes";

/** An object of `width`, centred at `at`. */
function at(id: string, position: number, width = 10, locked = false): DistributeEntry {
  return { id, min: position - width / 2, max: position + width / 2, locked };
}

function placed(entries: DistributeEntry[], spacing: "gaps" | "centers") {
  const shifts = new Map(distributeShifts(entries, spacing).map((shift) => [shift.id, shift.delta]));
  return entries.map((entry) => ({
    id: entry.id,
    center: (entry.min + entry.max) / 2 + (shifts.get(entry.id) ?? 0),
  }));
}

describe("distributing a selection", () => {
  it("spaces centres evenly between the outer two", () => {
    const result = placed([at("a", 0), at("b", 10), at("c", 90)], "centers");

    expect(result.map((entry) => entry.center)).toEqual([0, 45, 90]);
  });

  it("leaves the outer two exactly where they were", () => {
    const shifts = distributeShifts([at("a", 0), at("b", 10), at("c", 90)], "centers");

    expect(shifts.map((shift) => shift.id)).toEqual(["b"]);
  });

  it("leaves equal clear space between objects of different sizes", () => {
    // 10 wide at 0, 30 wide somewhere, 10 wide at 100: span 110 edge to edge,
    // 50 of it occupied, so two gaps of 30.
    const result = placed([at("a", 0, 10), at("b", 20, 30), at("c", 100, 10)], "gaps");

    const b = result.find((entry) => entry.id === "b")!;
    // a ends at 5, gap 30, so b runs 35..65 -- centred at 50.
    expect(b.center).toBeCloseTo(50, 6);
  });

  it("gives the same answer either way when every object is the same size", () => {
    const entries = [at("a", 0), at("b", 13), at("c", 70), at("d", 100)];

    const gaps = placed(entries, "gaps").map((entry) => entry.center);
    const centers = placed(entries, "centers").map((entry) => entry.center);

    // Equal sizes make equal gaps and equal centres the same spacing, down to
    // the order the arithmetic happens in.
    gaps.forEach((value, index) => expect(value).toBeCloseTo(centers[index], 9));
  });

  it("works from the order objects sit in, not the order they were selected", () => {
    const result = placed([at("c", 90), at("a", 0), at("b", 10)], "centers");

    expect(result.find((entry) => entry.id === "b")!.center).toBe(45);
  });

  it("reports nothing to do when the selection is already even", () => {
    expect(distributeShifts([at("a", 0), at("b", 50), at("c", 100)], "centers")).toEqual([]);
    expect(distributeShifts([at("a", 0), at("b", 50), at("c", 100)], "gaps")).toEqual([]);
  });

  it("needs three objects before there is a middle to space", () => {
    expect(distributeShifts([at("a", 0), at("b", 90)], "centers")).toEqual([]);
    expect(distributeShifts([at("a", 0)], "centers")).toEqual([]);
    expect(distributeShifts([], "centers")).toEqual([]);
  });

  it("declines rather than moving a locked object out of the way", () => {
    // A locked object in the middle is one that must not move, and spacing the
    // rest around it is not what was asked for.
    expect(distributeShifts([at("a", 0), at("b", 10, 10, true), at("c", 90)], "centers")).toEqual([]);
  });

  it("still spaces a selection whose outer objects are locked", () => {
    // The outer two never move anyway, so locking them changes nothing.
    const shifts = distributeShifts([at("a", 0, 10, true), at("b", 10), at("c", 90, 10, true)], "centers");

    expect(shifts).toEqual([{ id: "b", delta: 35 }]);
  });

  it("declines equal gaps when the objects are already too crowded to fit", () => {
    // Three 50-wide objects inside a 60-wide span cannot have a clear gap, and
    // spacing them anyway would shuffle them into each other.
    expect(distributeShifts([at("a", 0, 50), at("b", 25, 50), at("c", 60, 50)], "gaps")).toEqual([]);
  });

  it("still spaces centres when the objects overlap", () => {
    // Centres do not care about overlap, so this stays available.
    expect(distributeShifts([at("a", 0, 50), at("b", 25, 50), at("c", 60, 50)], "centers")).not.toEqual([]);
  });
});

describe("choosing an axis to distribute along", () => {
  function pair(x: number, z: number) {
    return { x: at("", x), z: at("", z) };
  }

  it("picks the axis the selection is already spread along", () => {
    expect(widestDistributeAxis([pair(0, 0), pair(50, 2), pair(100, 1)])).toBe("x");
    expect(widestDistributeAxis([pair(0, 0), pair(2, 50), pair(1, 100)])).toBe("z");
  });

  it("has no answer for a selection stacked in one place", () => {
    expect(widestDistributeAxis([pair(0, 0), pair(0, 0), pair(0, 0)])).toBeNull();
    expect(widestDistributeAxis([pair(0, 0), pair(10, 0)])).toBeNull();
  });
});
