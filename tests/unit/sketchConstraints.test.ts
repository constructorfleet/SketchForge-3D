import { describe, expect, it } from "vitest";
import { addSketchConstraint, removeSketchConstraint, solveSketchConstraints } from "@/lib/sketchConstraints";
import type { SketchProfile } from "@/types/sketchforge";

function profile(overrides: Partial<SketchProfile> = {}): SketchProfile {
  return {
    points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }],
    segments: [{ id: "line", startId: "a", endId: "b" }],
    ...overrides,
  };
}

describe("solveSketchConstraints", () => {
  it("adds and removes constraint declarations without changing geometry", () => {
    const source = profile();
    const constrained = addSketchConstraint(source, { id: "h", kind: "horizontal", segmentId: "line" });
    expect(constrained.constraints).toEqual([{ id: "h", kind: "horizontal", segmentId: "line" }]);
    expect(removeSketchConstraint(constrained, "h").constraints).toEqual([]);
    expect(source.points).toEqual(profile().points);
  });

  it("keeps coincident points together when one point is dragged", () => {
    const result = solveSketchConstraints(profile({ points: [{ id: "a", x: 5, z: 6 }, { id: "b", x: 10, z: 0 }], constraints: [{ id: "c", kind: "coincident", pointIds: ["a", "b"] }] }), ["a"]);
    expect(result.profile.points.map(({ x, z }) => [x, z])).toEqual([[5, 6], [5, 6]]);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("keeps a segment horizontal while anchoring its dragged endpoint", () => {
    const result = solveSketchConstraints(profile({ points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 4 }], constraints: [{ id: "h", kind: "horizontal", segmentId: "line" }] }), ["b"]);
    expect(result.profile.points.map((point) => point.z)).toEqual([4, 4]);
    expect(result.profile.points[1]?.x).toBe(10);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("keeps a segment vertical while anchoring its dragged endpoint", () => {
    const result = solveSketchConstraints(profile({ points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 4 }], constraints: [{ id: "v", kind: "vertical", segmentId: "line" }] }), ["b"]);
    expect(result.profile.points.map((point) => point.x)).toEqual([10, 10]);
    expect(result.profile.points[1]?.z).toBe(4);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("preserves a fixed distance when one endpoint is dragged", () => {
    const result = solveSketchConstraints(profile({ points: [{ id: "a", x: 3, z: 0 }, { id: "b", x: 10, z: 0 }], constraints: [{ id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10 }] }), ["a"]);
    expect(Math.hypot(result.profile.points[1]!.x - result.profile.points[0]!.x, result.profile.points[1]!.z - result.profile.points[0]!.z)).toBeCloseTo(10);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("reports an unsatisfied distance when both endpoints are anchored apart from the requested length", () => {
    const result = solveSketchConstraints(profile({ constraints: [{ id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 5 }] }), ["a", "b"]);
    expect(result.unsatisfiedConstraintIds).toEqual(["d"]);
    expect(result.profile.points.map((point) => point.x)).toEqual([0, 10]);
  });
});
