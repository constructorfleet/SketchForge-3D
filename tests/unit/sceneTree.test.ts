import { describe, expect, it } from "vitest";
import { sceneRows, sceneSummary, selectionAfterRowClick } from "@/lib/sceneTree";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(id: string, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id, name: id, kind: "box", color: "#f00",
    x: 0, z: 0, elevation: 0, size: 10, width: 10, depth: 10, height: 10, rotation: 0,
    ...overrides,
  };
}

describe("sceneRows", () => {
  it("lists the newest shape first, the opposite of draw order", () => {
    const rows = sceneRows([shape("first"), shape("second"), shape("third")]);
    expect(rows.map((row) => row.id)).toEqual(["third", "second", "first"]);
  });

  it("keeps a group collapsed until it is expanded", () => {
    const group = shape("group", { groupedShapes: [shape("a"), shape("b")] });
    expect(sceneRows([group]).map((row) => row.id)).toEqual(["group"]);
    expect(sceneRows([group], { expandedIds: new Set(["group"]) }).map((row) => row.id))
      .toEqual(["group", "a", "b"]);
  });

  it("indents a group's members and keeps their own order", () => {
    const group = shape("group", { groupedShapes: [shape("a"), shape("b")] });
    const rows = sceneRows([group], { expandedIds: new Set(["group"]) });
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1]);
    // Members keep combine order; reversing them would match nothing on screen.
    expect(rows.slice(1).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("nests groups within groups", () => {
    const inner = shape("inner", { groupedShapes: [shape("leaf")] });
    const outer = shape("outer", { groupedShapes: [inner] });
    const rows = sceneRows([outer], { expandedIds: new Set(["outer", "inner"]) });
    expect(rows.map((row) => [row.id, row.depth])).toEqual([["outer", 0], ["inner", 1], ["leaf", 2]]);
  });

  it("only offers actions on shapes the editor can actually act on", () => {
    const group = shape("group", { groupedShapes: [shape("a")] });
    const rows = sceneRows([group], { expandedIds: new Set(["group"]) });
    expect(rows.find((row) => row.id === "group")?.actionable).toBe(true);
    // A member cannot be selected or deleted without ungrouping first, so its
    // row must not offer controls that would do nothing.
    expect(rows.find((row) => row.id === "a")?.actionable).toBe(false);
  });

  it("carries the flags the list renders", () => {
    const rows = sceneRows([shape("s", { hidden: true, locked: true, hole: true })]);
    expect(rows[0]).toMatchObject({ hidden: true, locked: true, hole: true, childCount: 0 });
  });

  it("reports how many shapes a group holds", () => {
    const group = shape("group", { groupedShapes: [shape("a"), shape("b"), shape("c")] });
    expect(sceneRows([group])[0].childCount).toBe(3);
  });

  describe("filtering", () => {
    const scene = [shape("Bracket"), shape("Cylinder", { kind: "cylinder" }), shape("Plate")];

    it("matches on name, case-insensitively", () => {
      expect(sceneRows(scene, { filter: "brac" }).map((row) => row.id)).toEqual(["Bracket"]);
      expect(sceneRows(scene, { filter: "PLATE" }).map((row) => row.id)).toEqual(["Plate"]);
    });

    it("matches on kind, so 'cylinder' finds one whatever it was renamed to", () => {
      expect(sceneRows([shape("Hub", { kind: "cylinder" })], { filter: "cylinder" })).toHaveLength(1);
    });

    it("keeps a group whose member matches, so the match is never hidden inside it", () => {
      const group = shape("Assembly", { groupedShapes: [shape("Screw")] });
      const rows = sceneRows([group], { filter: "screw", expandedIds: new Set(["Assembly"]) });
      expect(rows.map((row) => row.id)).toEqual(["Assembly", "Screw"]);
    });

    it("ignores surrounding whitespace and an empty filter", () => {
      expect(sceneRows(scene, { filter: "   " })).toHaveLength(3);
      expect(sceneRows(scene, { filter: "  plate  " }).map((row) => row.id)).toEqual(["Plate"]);
    });
  });
});

describe("sceneSummary", () => {
  it("counts the scene, not what is inside groups", () => {
    const summary = sceneSummary([
      shape("a", { hidden: true }),
      shape("b", { locked: true }),
      shape("c", { hole: true }),
      shape("d", { groupedShapes: [shape("x", { hidden: true }), shape("y")] }),
    ]);
    expect(summary).toEqual({ total: 4, hidden: 1, locked: 1, holes: 1, groups: 1 });
  });

  it("is all zeroes for an empty scene", () => {
    expect(sceneSummary([])).toEqual({ total: 0, hidden: 0, locked: 0, holes: 0, groups: 0 });
  });
});

describe("selectionAfterRowClick", () => {
  it("replaces the selection on a plain click", () => {
    expect(selectionAfterRowClick(["a", "b"], "c", false)).toEqual(["c"]);
  });

  it("adds and removes with a modifier, matching the canvas", () => {
    expect(selectionAfterRowClick(["a"], "b", true)).toEqual(["a", "b"]);
    expect(selectionAfterRowClick(["a", "b"], "a", true)).toEqual(["b"]);
  });

  it("clears when the only selected shape is clicked again", () => {
    // So the list can deselect without reaching back to the canvas.
    expect(selectionAfterRowClick(["a"], "a", false)).toEqual([]);
  });

  it("selects normally when clicking one of several", () => {
    expect(selectionAfterRowClick(["a", "b"], "a", false)).toEqual(["a"]);
  });
});
