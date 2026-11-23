import { describe, expect, it } from "vitest";
import { edgeTreatmentPathLocked, holdsLockedShape, removableEdgeTreatments } from "@/lib/edgeTreatmentHistory";
import { sketchEditRefusal } from "@/lib/sketchEditTarget";
import type { EdgeTreatmentHistoryEntry, WorkplaneShape } from "@/types/sketchforge";

function box(id: string, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id, name: id, kind: "box", color: "#d41721", x: 0, z: 0, elevation: 0,
    size: 20, width: 20, depth: 20, height: 20, rotation: 0, locked: false, hidden: false,
    ...overrides,
  };
}

function treated(id: string, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  const entry: EdgeTreatmentHistoryEntry = { id: `${id}-fillet`, createdAt: 1, feature: { kind: "fillet", amount: 1, edgeCount: 1 }, before: box(id) };
  return box(id, { edgeTreatmentHistory: [entry], ...overrides });
}

const sketched = (overrides: Partial<WorkplaneShape> = {}) => box("sketch", {
  sketchProfile: { points: [], segments: [] },
  sketchOperation: "extrude",
  ...overrides,
});

describe("sketch edit refusal", () => {
  it("allows one unlocked sketch shape", () => {
    expect(sketchEditRefusal([sketched()])).toBeNull();
  });

  it("refuses a locked sketch shape", () => {
    expect(sketchEditRefusal([sketched({ locked: true })])).toBe("locked");
  });

  it("asks for one sketch shape otherwise", () => {
    expect(sketchEditRefusal([])).toBe("selectToEdit");
    expect(sketchEditRefusal([box("plain")])).toBe("selectToEdit");
    expect(sketchEditRefusal([sketched(), sketched({ id: "other" })])).toBe("selectToEdit");
  });
});

describe("edge treatment removal under a lock", () => {
  it("lists the treatments of unlocked children by path", () => {
    const group = box("group", { kind: "mesh", groupedShapes: [treated("a"), treated("b")] });

    expect(removableEdgeTreatments(group).map(({ path, entry }) => ({ path, entryId: entry.id }))).toEqual([
      { path: [0], entryId: "a-fillet" },
      { path: [1], entryId: "b-fillet" },
    ]);
  });

  it("leaves out a locked child's treatments, and those of every shape a locked child group holds", () => {
    const inner = box("inner", { kind: "mesh", locked: true, groupedShapes: [treated("deep")] });
    const group = box("group", { kind: "mesh", groupedShapes: [treated("locked", { locked: true }), treated("free"), inner] });

    expect(removableEdgeTreatments(group).map(({ entry }) => entry.id)).toEqual(["free-fillet"]);
  });

  it("names each treatment's shape chain and the newer entries it also removes", () => {
    const first: EdgeTreatmentHistoryEntry = { id: "one", createdAt: 1, feature: { kind: "fillet", amount: 1, edgeCount: 1 }, before: box("solo") };
    const second: EdgeTreatmentHistoryEntry = { ...first, id: "two", createdAt: 2 };
    const solo = box("solo", { edgeTreatmentHistory: [first, second] });

    expect(removableEdgeTreatments(solo).map(({ chain, entry, removesNewerCount }) => ({ chain: chain.map((shape) => shape.id), entryId: entry.id, removesNewerCount })))
      .toEqual([{ chain: ["solo"], entryId: "one", removesNewerCount: 1 }, { chain: ["solo"], entryId: "two", removesNewerCount: 0 }]);
  });

  it("reports a path as locked when the shape at it, or any group holding it, is locked", () => {
    const inner = box("inner", { kind: "mesh", locked: true, groupedShapes: [treated("deep")] });
    const group = box("group", { kind: "mesh", groupedShapes: [treated("locked", { locked: true }), treated("free"), inner] });

    expect(edgeTreatmentPathLocked(group, [1])).toBe(false);
    expect(edgeTreatmentPathLocked(group, [0])).toBe(true);
    expect(edgeTreatmentPathLocked(group, [2, 0])).toBe(true);
    expect(edgeTreatmentPathLocked({ ...group, locked: true }, [1])).toBe(true);
  });

  it("finds a lock anywhere in a shape, so a new fillet cannot rewrite a locked part", () => {
    const inner = box("inner", { kind: "mesh", groupedShapes: [treated("deep", { locked: true })] });

    expect(holdsLockedShape(box("group", { kind: "mesh", groupedShapes: [treated("a"), treated("b")] }))).toBe(false);
    expect(holdsLockedShape(box("group", { kind: "mesh", groupedShapes: [treated("a"), inner] }))).toBe(true);
    expect(holdsLockedShape(box("solo", { locked: true }))).toBe(true);
  });
});
