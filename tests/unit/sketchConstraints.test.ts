import { describe, expect, it } from "vitest";
import { addSketchConstraint, removeSketchConstraint, solveSketchConstraints, sketchConstraintDegreesOfFreedom, sketchConstraintsForProfile } from "@/lib/sketchConstraints";
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
    expect(result.profile.points[0]?.x).toBe(5);
    expect(result.profile.points[0]?.z).toBe(6);
    expect(result.profile.points[1]?.x).toBeCloseTo(5, 8);
    expect(result.profile.points[1]?.z).toBeCloseTo(6, 8);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("keeps a segment horizontal while anchoring its dragged endpoint", () => {
    const result = solveSketchConstraints(profile({ points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 4 }], constraints: [{ id: "h", kind: "horizontal", segmentId: "line" }] }), ["b"]);
    expect(result.profile.points[0]?.z).toBeCloseTo(4, 8);
    expect(result.profile.points[1]?.z).toBe(4);
    expect(result.profile.points[1]?.x).toBe(10);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("keeps a segment vertical while anchoring its dragged endpoint", () => {
    const result = solveSketchConstraints(profile({ points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 4 }], constraints: [{ id: "v", kind: "vertical", segmentId: "line" }] }), ["b"]);
    expect(result.profile.points.map((point) => point.x)).toEqual([expect.closeTo(10, 8), 10]);
    expect(result.profile.points[1]?.z).toBe(4);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("makes two selected segments perpendicular while anchoring the first segment", () => {
    const result = solveSketchConstraints(profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", x: 4, z: 3 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
      constraints: [{ id: "right-angle", kind: "perpendicular", segmentIds: ["base", "other"] }],
    }), ["a", "b"]);

    const [c, d] = result.profile.points.slice(2);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect((d!.x - c!.x) * (10) + (d!.z - c!.z) * 0).toBeCloseTo(0, 6);
    expect(sketchConstraintsForProfile(result.profile)).toHaveLength(1);
  });

  it("counts a perpendicular relation as one independent equation in the local freedom estimate", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", x: 4, z: 3 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
      constraints: [{ id: "right-angle", kind: "perpendicular", segmentIds: ["base", "other"] }],
    }));

    expect(report.status).toBe("estimated");
    expect(report.equationCount).toBe(1);
    expect(report.rank).toBe(1);
    expect(report.degreesOfFreedom).toBe(7);
  });

  it("marks the freedom estimate indeterminate when a perpendicular segment has zero length", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 2, z: 2 }, { id: "d", x: 2, z: 2 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
      constraints: [{ id: "right-angle", kind: "perpendicular", segmentIds: ["base", "other"] }],
    }));

    expect(report).toMatchObject({ status: "indeterminate", degreesOfFreedom: null, rank: null, reason: "degenerate-segment" });
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

  it("solves a fixed distance from degenerate coincident starting geometry", () => {
    const result = solveSketchConstraints(profile({
      points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 0, z: 0 }],
      constraints: [{ id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 5 }],
    }), ["a"]);

    expect(result.profile.points[0]).toMatchObject({ x: 0, z: 0 });
    expect(Math.hypot(result.profile.points[1]!.x, result.profile.points[1]!.z)).toBeCloseTo(5, 5);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
  });

  it("satisfies redundant dependent constraints and identifies incompatible dependent distances", () => {
    const redundant = solveSketchConstraints(profile({
      constraints: [
        { id: "join-1", kind: "coincident", pointIds: ["a", "b"] },
        { id: "join-2", kind: "coincident", pointIds: ["a", "b"] },
      ],
    }), ["a"]);
    expect(redundant.unsatisfiedConstraintIds).toEqual([]);
    expect(redundant.profile.points[1]?.x).toBeCloseTo(0, 8);
    expect(redundant.profile.points[1]?.z).toBeCloseTo(0, 8);

    const incompatible = solveSketchConstraints(profile({
      constraints: [
        { id: "short", kind: "distance", pointIds: ["a", "b"], valueMm: 4 },
        { id: "long", kind: "distance", pointIds: ["a", "b"], valueMm: 6 },
      ],
    }), ["a", "b"]);
    expect(incompatible.unsatisfiedConstraintIds).toEqual(["short", "long"]);
    expect(incompatible.profile.points.map(({ x, z }) => [x, z])).toEqual([[0, 0], [10, 0]]);
  });

  it("solves a coupled nearly-collinear triangle while keeping the dragged vertex fixed", () => {
    const result = solveSketchConstraints(profile({
      points: [
        { id: "a", x: 0, z: 0 },
        { id: "b", x: 3, z: 0 },
        { id: "c", x: 4, z: 0 },
      ],
      segments: [],
      constraints: [
        { id: "ab", kind: "distance", pointIds: ["a", "b"], valueMm: 3 },
        { id: "bc", kind: "distance", pointIds: ["b", "c"], valueMm: 4 },
        { id: "ca", kind: "distance", pointIds: ["c", "a"], valueMm: 6.99 },
      ],
    }), ["a"]);

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(result.profile.points[0]).toMatchObject({ x: 0, z: 0 });
    expect(Math.hypot(result.profile.points[1]!.x - result.profile.points[0]!.x, result.profile.points[1]!.z - result.profile.points[0]!.z)).toBeCloseTo(3, 5);
    expect(Math.hypot(result.profile.points[2]!.x - result.profile.points[1]!.x, result.profile.points[2]!.z - result.profile.points[1]!.z)).toBeCloseTo(4, 5);
    expect(Math.hypot(result.profile.points[2]!.x - result.profile.points[0]!.x, result.profile.points[2]!.z - result.profile.points[0]!.z)).toBeCloseTo(6.99, 5);
  });

  it("handles collinear singularity in a constraint component without moving unrelated geometry", () => {
    const result = solveSketchConstraints(profile({
      points: [
        { id: "a", x: 0, z: 0 },
        { id: "b", x: 3, z: 0 },
        { id: "c", x: 4, z: 0 },
        { id: "unrelated", x: 2, z: 20 },
      ],
      segments: [],
      constraints: [
        { id: "ab", kind: "distance", pointIds: ["a", "b"], valueMm: 3 },
        { id: "bc", kind: "distance", pointIds: ["b", "c"], valueMm: 4 },
        { id: "ca", kind: "distance", pointIds: ["c", "a"], valueMm: 6.99 },
      ],
    }), ["a"]);

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(result.profile.points[3]).toMatchObject({ x: 2, z: 20 });
  });

  it("moves Bezier handles with their solved point and preserves its 3D sweep depth", () => {
    const result = solveSketchConstraints(profile({
      points: [
        { id: "a", x: 5, z: 6 },
        { id: "b", x: 10, z: 0, sweepRole: "spine", sweepDepth: -3, handleIn: { x: 8, z: -2 }, handleOut: { x: 12, z: 2 } },
      ],
      constraints: [{ id: "c", kind: "coincident", pointIds: ["a", "b"] }],
    }), ["a"]);

    expect(result.profile.points[1]?.x).toBeCloseTo(5, 8);
    expect(result.profile.points[1]?.z).toBeCloseTo(6, 8);
    expect(result.profile.points[1]?.sweepDepth).toBe(-3);
    expect(result.profile.points[1]?.handleIn?.x).toBeCloseTo(3, 8);
    expect(result.profile.points[1]?.handleIn?.z).toBeCloseTo(4, 8);
    expect(result.profile.points[1]?.handleOut?.x).toBeCloseTo(7, 8);
    expect(result.profile.points[1]?.handleOut?.z).toBeCloseTo(8, 8);
  });

  it("solves the same coupled system deterministically", () => {
    const source = profile({
      points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 3, z: 0 }, { id: "c", x: 4, z: 0 }],
      segments: [],
      constraints: [
        { id: "ab", kind: "distance", pointIds: ["a", "b"], valueMm: 3 },
        { id: "bc", kind: "distance", pointIds: ["b", "c"], valueMm: 4 },
        { id: "ca", kind: "distance", pointIds: ["c", "a"], valueMm: 6.99 },
      ],
    });
    expect(solveSketchConstraints(source, ["a"])).toEqual(solveSketchConstraints(source, ["a"]));
  });

  it("solves a mixed cyclic rectangle system with coincidence, axis, and distance relations", () => {
    const result = solveSketchConstraints(profile({
      points: [
        { id: "a", x: 0, z: 0 },
        { id: "b", x: 4, z: 1 },
        { id: "c", x: 4, z: 3 },
        { id: "d", x: 1, z: 3 },
        { id: "e", x: 8, z: 6 },
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b" },
        { id: "bc", startId: "b", endId: "c" },
        { id: "cd", startId: "c", endId: "d" },
        { id: "da", startId: "d", endId: "a" },
      ],
      constraints: [
        { id: "join-eb", kind: "coincident", pointIds: ["e", "b"] },
        { id: "horizontal-ab", kind: "horizontal", segmentId: "ab" },
        { id: "vertical-bc", kind: "vertical", segmentId: "bc" },
        { id: "horizontal-cd", kind: "horizontal", segmentId: "cd" },
        { id: "vertical-da", kind: "vertical", segmentId: "da" },
        { id: "width-ab", kind: "distance", pointIds: ["a", "b"], valueMm: 4 },
        { id: "height-bc", kind: "distance", pointIds: ["b", "c"], valueMm: 3 },
        { id: "width-cd", kind: "distance", pointIds: ["c", "d"], valueMm: 4 },
        { id: "height-da", kind: "distance", pointIds: ["d", "a"], valueMm: 3 },
      ],
    }), ["a"]);

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(result.profile.points[0]).toMatchObject({ x: 0, z: 0 });
    for (const point of result.profile.points.slice(1)) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.z)).toBe(true);
    }
    expect(result.profile.points[1]?.z).toBeCloseTo(0, 5);
    expect(result.profile.points[2]?.x).toBeCloseTo(4, 5);
    expect(result.profile.points[3]?.z).toBeCloseTo(3, 5);
    expect(result.profile.points[3]?.x).toBeCloseTo(0, 5);
    expect(result.profile.points[4]?.x).toBeCloseTo(4, 5);
    expect(result.profile.points[4]?.z).toBeCloseTo(0, 5);
  });

  it("solves a larger connected distance system within bounded iteration limits", () => {
    const points = Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, x: index * 2, z: 0 }));
    const constraints = points.slice(1).map((point, index) => ({
      id: `d${index}`,
      kind: "distance" as const,
      pointIds: [`p${index}`, point.id] as [string, string],
      valueMm: 1,
    }));
    const result = solveSketchConstraints(profile({ points, segments: [], constraints }), ["p0"]);

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(result.profile.points[0]).toMatchObject({ x: 0, z: 0 });
    for (let index = 1; index < result.profile.points.length; index += 1) {
      const previous = result.profile.points[index - 1]!;
      const current = result.profile.points[index]!;
      expect(Math.hypot(current.x - previous.x, current.z - previous.z)).toBeCloseTo(1, 5);
    }
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
