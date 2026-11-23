import { describe, expect, it } from "vitest";
import { edgeTreatmentPathLocked, holdsLockedShape, removableEdgeTreatments, separatePartsBlockedByLock } from "@/lib/edgeTreatmentHistory";
import { sketchEditRefusal, sketchEditTargetLocked } from "@/lib/sketchEditTarget";
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

describe("separating parts under a lock", () => {
  it("lets a plain group with a locked part split, as Ungroup does, since its parts keep their locks", () => {
    const group = box("group", { kind: "mesh", groupedShapes: [treated("locked", { locked: true }), treated("free")] });

    expect(separatePartsBlockedByLock(group)).toBe(false);
    expect(separatePartsBlockedByLock({ ...group, locked: true })).toBe(true);
  });

  it("refuses a baked result holding a locked part, whose mesh split would replace that part", () => {
    const baked = box("baked", {
      kind: "mesh",
      importedMesh: { positions: [], indices: [] } as never,
      groupedShapes: [treated("locked", { locked: true })],
    });

    expect(separatePartsBlockedByLock(baked)).toBe(true);
    expect(separatePartsBlockedByLock(box("solo"))).toBe(false);
  });
});

describe("finishing a sketch edit", () => {
  it("refuses when the edited shape is locked in the shapes it would commit into", () => {
    const shapes = [box("other"), sketched()];

    expect(sketchEditTargetLocked(shapes, "sketch")).toBe(false);
    expect(sketchEditTargetLocked([box("other"), sketched({ locked: true })], "sketch")).toBe(true);
    expect(sketchEditTargetLocked(shapes, null)).toBe(false);
    expect(sketchEditTargetLocked(shapes, "gone")).toBe(false);
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

  it("leaves out a group's own treatments while it holds a locked part, since restoring one changes that part", () => {
    const inner = box("inner", { kind: "mesh", edgeTreatmentHistory: treated("inner").edgeTreatmentHistory, groupedShapes: [treated("deep", { locked: true })] });
    const group = box("group", { kind: "mesh", edgeTreatmentHistory: treated("group").edgeTreatmentHistory, groupedShapes: [treated("free"), inner] });

    expect(removableEdgeTreatments(group).map(({ entry }) => entry.id)).toEqual(["free-fillet"]);
    expect(edgeTreatmentPathLocked(group, [])).toBe(true);
    expect(edgeTreatmentPathLocked(group, [1])).toBe(true);
    expect(edgeTreatmentPathLocked(group, [0])).toBe(false);
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
