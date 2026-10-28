import { describe, expect, it } from "vitest";
import { addSketchConstraint, isSketchAnglePair, removeSketchConstraint, solveSketchConstraints, sketchConstraintDegreesOfFreedom, sketchConstraintsForProfile } from "@/lib/sketchConstraints";
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

  it("adds and removes a fixed point relation", () => {
    const source = profile();
    const constrained = addSketchConstraint(source, { id: "fixed-a", kind: "fixed", pointId: "a", xMm: 2, zMm: 3 });
    expect(constrained.constraints).toEqual([{ id: "fixed-a", kind: "fixed", pointId: "a", xMm: 2, zMm: 3 }]);
    expect(removeSketchConstraint(constrained, "fixed-a").constraints).toEqual([]);
  });

  it("globally translates a rigidly constrained sketch to a fixed workplane point", () => {
    const source = profile({
      points: [{ id: "a", x: 5, z: 7 }, { id: "b", x: 15, z: 7 }, { id: "c", x: 5, z: 17 }],
      segments: [{ id: "ab", startId: "a", endId: "b" }, { id: "ac", startId: "a", endId: "c" }, { id: "bc", startId: "b", endId: "c" }],
      constraints: [
        { id: "ab-distance", kind: "distance", pointIds: ["a", "b"], valueMm: 10 },
        { id: "ac-distance", kind: "distance", pointIds: ["a", "c"], valueMm: 10 },
        { id: "bc-distance", kind: "distance", pointIds: ["b", "c"], valueMm: Math.sqrt(200) },
        { id: "ab-horizontal", kind: "horizontal", segmentId: "ab" },
        { id: "origin", kind: "fixed", pointId: "a", xMm: 0, zMm: 0 },
      ],
    });
    expect(sketchConstraintDegreesOfFreedom({ ...source, constraints: source.constraints?.filter(({ kind }) => kind !== "fixed") })).toMatchObject({ degreesOfFreedom: 2 });
    const result = solveSketchConstraints(source);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(result.profile.points).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "a", x: expect.closeTo(0, 7), z: expect.closeTo(0, 7) }),
      expect.objectContaining({ id: "b", x: expect.closeTo(10, 7), z: expect.closeTo(0, 7) }),
      expect.objectContaining({ id: "c", x: expect.closeTo(0, 7), z: expect.closeTo(10, 7) }),
    ]));
    expect(sketchConstraintDegreesOfFreedom(result.profile)).toMatchObject({ degreesOfFreedom: 0, status: "estimated" });
  });

  it("reports incompatible fixed points and relative dimensions as unsatisfied", () => {
    const result = solveSketchConstraints(profile({ constraints: [
      { id: "fix-a", kind: "fixed", pointId: "a", xMm: 0, zMm: 0 },
      { id: "fix-b", kind: "fixed", pointId: "b", xMm: 10, zMm: 0 },
      { id: "distance", kind: "distance", pointIds: ["a", "b"], valueMm: 5 },
    ] }));
    expect(result.unsatisfiedConstraintIds).toEqual(["distance"]);
    expect(result.profile.points.map(({ x, z }) => [x, z])).toEqual([[0, 0], [10, 0]]);
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

  it("makes two selected segments parallel while anchoring the first segment", () => {
    const result = solveSketchConstraints(profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", x: 4, z: 3 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
      constraints: [{ id: "parallel", kind: "parallel", segmentIds: ["base", "other"] }],
    }), ["a", "b"]);

    const [c, d] = result.profile.points.slice(2);
    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect((d!.x - c!.x) * 0 - (d!.z - c!.z) * 10).toBeCloseTo(0, 6);
    expect(sketchConstraintsForProfile(result.profile)).toHaveLength(1);
  });

  it("keeps a line tangent to an attached Bezier while the shared endpoint is dragged", () => {
    const tangent = { id: "tangent", kind: "tangent" as const, segmentIds: ["line", "curve"] as [string, string] };
    const source = profile({
      points: [
        { id: "a", x: 0, z: 0 },
        { id: "b", x: 4, z: 4, handleOut: { x: 8, z: 4 } },
        { id: "c", x: 4, z: 8, handleIn: { x: 4, z: 6 } },
      ],
      segments: [
        { id: "line", startId: "a", endId: "b", kind: "line" },
        { id: "curve", startId: "b", endId: "c", kind: "bezier" },
      ],
      constraints: [tangent],
    });

    const result = solveSketchConstraints(source, ["a", "c"]);
    const shared = result.profile.points.find(({ id }) => id === "b")!;
    const line = result.profile.points.find(({ id }) => id === "a")!;
    const dx = shared.x - line.x;
    const dz = shared.z - line.z;
    const bezierDx = shared.handleOut!.x - shared.x;
    const bezierDz = shared.handleOut!.z - shared.z;

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(Math.abs(dx * bezierDz - dz * bezierDx)).toBeLessThan(1e-5);
    const unconstrained = sketchConstraintDegreesOfFreedom({ ...source, constraints: undefined });
    expect(unconstrained.degreesOfFreedom! - sketchConstraintDegreesOfFreedom(source).degreesOfFreedom!).toBe(1);
  });

  it("keeps two line segments equal in length while a dragged endpoint stays anchored", () => {
    const source = profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 8, z: 0 },
        { id: "c", x: 0, z: 5 }, { id: "d", x: 6, z: 5 },
      ],
      segments: [
        { id: "first", startId: "a", endId: "b" },
        { id: "second", startId: "c", endId: "d" },
      ],
    });
    const constraint = { id: "equal", kind: "equalLength" as const, segmentIds: ["first", "second"] as [string, string] };
    const before = sketchConstraintDegreesOfFreedom(source);
    const constrained = { ...source, constraints: [constraint] };
    const result = solveSketchConstraints(constrained, ["d"]);
    const points = new Map(result.profile.points.map((point) => [point.id, point]));
    const segmentLength = (segmentId: string) => {
      const segment = result.profile.segments.find(({ id }) => id === segmentId)!;
      const start = points.get(segment.startId)!;
      const end = points.get(segment.endId)!;
      return Math.hypot(end.x - start.x, end.z - start.z);
    };

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(points.get("d")).toMatchObject({ x: 6, z: 5 });
    expect(segmentLength("first")).toBeCloseTo(segmentLength("second"), 5);
    expect(before.degreesOfFreedom! - sketchConstraintDegreesOfFreedom(constrained).degreesOfFreedom!).toBe(1);
  });

  it("sets the angle between two selected segments while anchoring the first", () => {
    const source = profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", x: 5, z: 5 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
    });
    const constraint = { id: "angle", kind: "angle" as const, segmentIds: ["base", "other"] as [string, string], valueDeg: 30 };
    const before = sketchConstraintDegreesOfFreedom(source);
    const constrained = { ...source, constraints: [constraint] };
    const result = solveSketchConstraints(constrained, ["a", "b"]);
    const points = new Map(result.profile.points.map((point) => [point.id, point]));
    const [a, b, c, d] = [points.get("a")!, points.get("b")!, points.get("c")!, points.get("d")!];
    const cosine = ((b.x - a.x) * (d.x - c.x) + (b.z - a.z) * (d.z - c.z))
      / (Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(d.x - c.x, d.z - c.z));
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(angle).toBeCloseTo(30, 4);
    expect(before.degreesOfFreedom! - sketchConstraintDegreesOfFreedom(constrained).degreesOfFreedom!).toBe(1);
    expect(sketchConstraintsForProfile(result.profile)).toHaveLength(1);
  });

  it("measures an angle between 90 and 180 degrees as the larger angle", () => {
    const source = profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", x: 5, z: 5 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
      constraints: [{ id: "angle", kind: "angle", segmentIds: ["base", "other"], valueDeg: 150 }],
    });
    const result = solveSketchConstraints(source, ["a", "b"]);
    const points = new Map(result.profile.points.map((point) => [point.id, point]));
    const [a, b, c, d] = [points.get("a")!, points.get("b")!, points.get("c")!, points.get("d")!];
    const cosine = ((b.x - a.x) * (d.x - c.x) + (b.z - a.z) * (d.z - c.z))
      / (Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(d.x - c.x, d.z - c.z));
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;

    expect(result.unsatisfiedConstraintIds).toEqual([]);
    expect(angle).toBeCloseTo(150, 4);
  });

  it("solves a zero-degree angle as parallel and a 180-degree angle as opposite", () => {
    const source = (start: { x: number; z: number }, target: number) => profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", ...start },
      ],
      segments: [{ id: "base", startId: "a", endId: "b" }, { id: "other", startId: "c", endId: "d" }],
      constraints: [{ id: "angle", kind: "angle", segmentIds: ["base", "other"], valueDeg: target }],
    });
    const measure = (result: ReturnType<typeof solveSketchConstraints>) => {
      const points = new Map(result.profile.points.map((point) => [point.id, point]));
      const [a, b, c, d] = [points.get("a")!, points.get("b")!, points.get("c")!, points.get("d")!];
      const cosine = ((b.x - a.x) * (d.x - c.x) + (b.z - a.z) * (d.z - c.z))
        / (Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(d.x - c.x, d.z - c.z));
      return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
    };

    const parallel = solveSketchConstraints(source({ x: 8, z: 3 }, 0), ["a", "b"]);
    expect(parallel.unsatisfiedConstraintIds).toEqual([]);
    expect(measure(parallel)).toBeCloseTo(0, 3);
    const opposite = solveSketchConstraints(source({ x: -8, z: 3 }, 180), ["a", "b"]);
    expect(opposite.unsatisfiedConstraintIds).toEqual([]);
    expect(measure(opposite)).toBeCloseTo(180, 3);
  });

  it("does not offer an angle for a degenerate segment", () => {
    const source = profile({
      points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 0, z: 0 }, { id: "c", x: 0, z: 0 }, { id: "d", x: 5, z: 5 }],
      segments: [{ id: "base", startId: "a", endId: "b" }, { id: "other", startId: "c", endId: "d" }],
    });
    expect(isSketchAnglePair(["base", "other"], source)).toBe(false);
  });

  it("counts an angle relation as one independent equation in the local freedom estimate", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", x: 4, z: 3 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
      constraints: [{ id: "angle", kind: "angle", segmentIds: ["base", "other"], valueDeg: 45 }],
    }));

    expect(report).toMatchObject({ status: "estimated", equationCount: 1, rank: 1, degreesOfFreedom: 7 });
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

  it("counts a parallel relation as one independent equation in the local freedom estimate", () => {
    const report = sketchConstraintDegreesOfFreedom(profile({
      points: [
        { id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 },
        { id: "c", x: 0, z: 0 }, { id: "d", x: 4, z: 3 },
      ],
      segments: [
        { id: "base", startId: "a", endId: "b" },
        { id: "other", startId: "c", endId: "d" },
      ],
      constraints: [{ id: "parallel", kind: "parallel", segmentIds: ["base", "other"] }],
    }));

    expect(report).toMatchObject({ status: "estimated", equationCount: 1, rank: 1, degreesOfFreedom: 7 });
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
