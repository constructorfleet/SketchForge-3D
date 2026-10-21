import { describe, expect, it } from "vitest";
import { addSketchConstraint, removeSketchConstraint, solveSketchConstraints, sketchConstraintDegreesOfFreedom } from "@/lib/sketchConstraints";
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

describe("sketchConstraintDegreesOfFreedom", () => {
  it("reports remaining coordinate freedom for an underconstrained profile", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({ constraints: [{ id: "c", kind: "coincident", pointIds: ["a", "b"] }] }));
    expect(report).toMatchObject({ parameterCount: 4, equationCount: 2, rank: 2, degreesOfFreedom: 2, status: "estimated" });
  });

  it("reports rigid translation freedom even when relative geometry is fully constrained", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({
      points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 0, z: 10 }],
      segments: [
        { id: "line", startId: "a", endId: "b" },
        { id: "ac", startId: "a", endId: "c" },
        { id: "bc", startId: "b", endId: "c" },
      ],
      constraints: [
        { id: "ab", kind: "distance", pointIds: ["a", "b"], valueMm: 10 },
        { id: "ac-distance", kind: "distance", pointIds: ["a", "c"], valueMm: 10 },
        { id: "bc-distance", kind: "distance", pointIds: ["b", "c"], valueMm: Math.sqrt(200) },
        { id: "h", kind: "horizontal", segmentId: "line" },
      ],
    }));
    expect(report).toMatchObject({ parameterCount: 6, equationCount: 4, rank: 4, degreesOfFreedom: 2, status: "estimated" });
  });

  it("uses Jacobian rank so duplicate and dependent constraints do not overstate constrained freedom", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({ constraints: [
      { id: "h1", kind: "horizontal", segmentId: "line" },
      { id: "h2", kind: "horizontal", segmentId: "line" },
    ] }));
    expect(report).toMatchObject({ parameterCount: 4, equationCount: 2, rank: 1, degreesOfFreedom: 3, status: "estimated" });
  });

  it("treats a coincident point paired with itself as a dependent equation", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({ constraints: [{ id: "self", kind: "coincident", pointIds: ["a", "a"] }] }));
    expect(report).toMatchObject({ parameterCount: 4, equationCount: 2, rank: 0, degreesOfFreedom: 4, status: "estimated" });
  });

  it("declines to estimate rank for a distance constraint at coincident points", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({
      points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 0, z: 0 }],
      constraints: [{ id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 5 }],
    }));
    expect(report).toMatchObject({ status: "indeterminate", degreesOfFreedom: null, rank: null, reason: "degenerate-distance" });
  });

  it("counts unconstrained Bezier handles and sweep depth as free parameters", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({
      points: [
        { id: "a", x: 0, z: 0, handleIn: { x: -1, z: 0 }, sweepDepth: 2 },
        { id: "b", x: 10, z: 0, handleOut: { x: 11, z: 0 } },
      ],
      constraints: [{ id: "h", kind: "horizontal", segmentId: "line" }],
    }));
    expect(report).toMatchObject({ parameterCount: 9, equationCount: 1, rank: 1, degreesOfFreedom: 8, status: "estimated" });
  });
});
