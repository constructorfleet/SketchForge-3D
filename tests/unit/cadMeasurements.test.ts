import { describe, expect, it } from "vitest";
import {
  angleBetweenDegrees,
  arcSweepRadians,
  circularEdgeRadius,
  faceRadius,
  planarFaceAngle,
  type MeasurementResult,
} from "@constructorfleet/sketchforge-engine/cadMeasurements";

/** Asserts the measurement was taken and hands back the numbers, so a refusal fails here rather than reading as `false`. */
function taken<T>(result: MeasurementResult<T>) {
  if (!result.available) {
    throw new Error(`expected a measurement, got code "${result.code}"`);
  }
  return result;
}

/**
 * Fixtures are built from a radius and a sweep by the closed form, so the
 * assertions check the derivation rather than restating it. 7.5 mm and 13 mm are
 * chosen because neither is 1, a half, or a multiple of the other — a radius of
 * 1 makes `length / sweep`, `length * sweep` and `1 / sweep` agree, and a
 * diameter of 2r is indistinguishable from r when r is 1.
 */
const arc = (radius: number, sweepRadians: number, first = 0.37) => ({
  curveKind: "circle",
  length: radius * sweepRadians,
  first,
  last: first + sweepRadians,
  closed: false,
});

describe("circular edge radius", () => {
  it("measures a full circle as length over a full turn", () => {
    // A closed circle of radius 7.5: circumference 2π·7.5 = 47.12388980384690.
    const measured = circularEdgeRadius({
      curveKind: "circle",
      length: 2 * Math.PI * 7.5,
      // A seam edge can come back re-based; a closed edge is a full turn regardless.
      first: 1.25,
      last: 1.25,
      closed: true,
    });
    expect(taken(measured).radius).toBeCloseTo(7.5, 12);
    expect(taken(measured).diameter).toBeCloseTo(15, 12);
    expect(taken(measured).sweepRadians).toBeCloseTo(2 * Math.PI, 12);
  });

  it("measures an arc as length over its swept angle", () => {
    // A 50° arc of radius 13, so neither the sweep nor the radius is a round number.
    const sweep = (50 * Math.PI) / 180;
    const measured = circularEdgeRadius(arc(13, sweep));
    expect(taken(measured).radius).toBeCloseTo(13, 12);
    expect(taken(measured).diameter).toBeCloseTo(26, 12);
    expect(taken(measured).sweepRadians).toBeCloseTo(sweep, 12);
  });

  it("reads the same radius from a long arc and a short one", () => {
    // The derivation must not smuggle in the sweep: both are radius 7.5.
    const quarter = circularEdgeRadius(arc(7.5, Math.PI / 2));
    const sliver = circularEdgeRadius(arc(7.5, 0.08));
    expect(taken(quarter).radius).toBeCloseTo(7.5, 12);
    expect(taken(sliver).radius).toBeCloseTo(7.5, 12);
  });

  it("does not read the parameter range as the sweep when the range is offset", () => {
    // Same arc, parameterised from 5.9 rather than 0.37. Using `last` alone
    // instead of the difference would read 6.77 rad here and 1.24 there.
    const sweep = 0.87;
    const shifted = circularEdgeRadius(arc(13, sweep, 5.9));
    expect(taken(shifted).radius).toBeCloseTo(13, 12);
  });

  it("refuses an ellipse rather than averaging its semi-axes", () => {
    // An ellipse with semi-axes 13 and 7.5 has a perimeter near 64.9; dividing
    // that by 2π would report 10.3, which is neither axis and looks plausible.
    const measured = circularEdgeRadius({ curveKind: "ellipse", length: 64.9, first: 0, last: 2 * Math.PI, closed: true });
    expect(measured).toEqual({ available: false, code: "ellipseHasNoSingleRadius" });
  });

  it("refuses a straight edge and a spline, which have no radius", () => {
    expect(circularEdgeRadius({ curveKind: "line", length: 42, first: 0, last: 42, closed: false }))
      .toEqual({ available: false, code: "notCircular" });
    expect(circularEdgeRadius({ curveKind: "bspline", length: 42, first: 0, last: 1, closed: false }))
      .toEqual({ available: false, code: "notCircular" });
  });

  it("refuses a circle whose sweep or length is degenerate", () => {
    // A zero-length seam, and a range running backwards: both would divide by
    // zero or produce a negative radius.
    expect(circularEdgeRadius({ curveKind: "circle", length: 0, first: 0.37, last: 1.37, closed: false }))
      .toEqual({ available: false, code: "degenerateCurve" });
    expect(circularEdgeRadius({ curveKind: "circle", length: 12.25, first: 1.37, last: 1.37, closed: false }))
      .toEqual({ available: false, code: "degenerateCurve" });
    expect(circularEdgeRadius({ curveKind: "circle", length: 12.25, first: 2.4, last: 1.37, closed: false }))
      .toEqual({ available: false, code: "degenerateCurve" });
  });
});

describe("arc sweep", () => {
  it("is the parameter span of an open arc", () => {
    expect(arcSweepRadians({ first: 0.37, last: 1.24, closed: false })).toBeCloseTo(0.87, 12);
  });

  it("is a full turn for a closed edge whatever its range says", () => {
    expect(arcSweepRadians({ first: 1.25, last: 1.25, closed: true })).toBeCloseTo(2 * Math.PI, 12);
  });
});

describe("face radius", () => {
  it("reports a cylinder's radius and twice it as the diameter", () => {
    const measured = faceRadius("cylinder", 7.5);
    expect(taken(measured).radius).toBe(7.5);
    expect(taken(measured).diameter).toBe(15);
  });

  it("refuses a plane, which has no radius at all", () => {
    expect(faceRadius("plane", null)).toEqual({ available: false, code: "notCurved" });
    // A plane that somehow carried a radius still has none.
    expect(faceRadius("plane", 7.5)).toEqual({ available: false, code: "notCurved" });
  });

  it("refuses the surfaces whose radius changes across the face", () => {
    // A cone is wide at one end and narrow at the other; a torus has two radii;
    // a spline has a different one everywhere. Reporting whichever point was
    // sampled would be a plausible number and the wrong one.
    for (const kind of ["cone", "torus", "bspline", "bezier", "revolution", "extrusion", "offset", "unknown"]) {
      expect(faceRadius(kind, 7.5), kind).toEqual({ available: false, code: "radiusVariesOverSurface" });
    }
  });

  it("refuses a sphere, saying the kernel will not report it", () => {
    // A sphere does have one radius -- the reason is not that the geometry is
    // ambiguous but that this kernel build has no accessor that gives it
    // reliably. The distinction matters to whoever reads the code.
    expect(faceRadius("sphere", null)).toEqual({ available: false, code: "radiusNotReportedByKernel" });
    expect(faceRadius("sphere", 13)).toEqual({ available: false, code: "radiusNotReportedByKernel" });
  });

  it("refuses a cylinder the kernel reported nothing usable for", () => {
    for (const reported of [null, 0, -7.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(faceRadius("cylinder", reported), String(reported))
        .toEqual({ available: false, code: "degenerateSurface" });
    }
  });
});

describe("angle between directions", () => {
  it("measures a known angle from unnormalized vectors", () => {
    // 3-4-5 style: (1,0,0) against (1,1,0) is 45°, and the lengths differ so a
    // missing normalization would show.
    const measured = angleBetweenDegrees({ x: 2.5, y: 0, z: 0 }, { x: 13, y: 13, z: 0 });
    expect(taken(measured).angleDegrees).toBeCloseTo(45, 10);
  });

  it("measures 90 and 180 and 0", () => {
    const up = { x: 0, y: 7.5, z: 0 };
    expect(taken(angleBetweenDegrees(up, { x: 13, y: 0, z: 0 })).angleDegrees).toBeCloseTo(90, 10);
    expect(taken(angleBetweenDegrees(up, { x: 0, y: -13, z: 0 })).angleDegrees).toBeCloseTo(180, 10);
    expect(taken(angleBetweenDegrees(up, { x: 0, y: 13, z: 0 })).angleDegrees).toBeCloseTo(0, 10);
  });

  it("does not return NaN for identical normals that round past 1", () => {
    // acos(1.0000000000000002) is NaN; the clamp is what stops this reading NaN.
    const direction = { x: 0.5773502691896258, y: 0.5773502691896258, z: 0.5773502691896258 };
    const measured = angleBetweenDegrees(direction, { ...direction });
    expect(taken(measured).angleDegrees).toBeCloseTo(0, 10);
    expect(Number.isNaN(taken(measured).angleDegrees)).toBe(false);
  });

  it("measures an oblique angle against its closed form", () => {
    // (1,1,1) against (0,0,1): cos θ = 1/√3, θ = 54.7356103172453°.
    const measured = angleBetweenDegrees({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 4.25 });
    expect(taken(measured).angleDegrees).toBeCloseTo((Math.acos(1 / Math.sqrt(3)) * 180) / Math.PI, 10);
  });

  it("refuses a zero-length direction", () => {
    expect(angleBetweenDegrees({ x: 0, y: 0, z: 0 }, { x: 13, y: 0, z: 0 }))
      .toEqual({ available: false, code: "degenerateNormal" });
  });
});

describe("planar face angle", () => {
  it("reads 90 at the square corner of a box", () => {
    const measured = planarFaceAngle(
      { surfaceKind: "plane", normal: { x: 1, y: 0, z: 0 } },
      { surfaceKind: "plane", normal: { x: 0, y: 0, z: 1 } },
    );
    expect(taken(measured).angleDegrees).toBeCloseTo(90, 10);
  });

  it("reads 180 between two opposite faces, which face away from each other", () => {
    const measured = planarFaceAngle(
      { surfaceKind: "plane", normal: { x: 1, y: 0, z: 0 } },
      { surfaceKind: "plane", normal: { x: -1, y: 0, z: 0 } },
    );
    expect(taken(measured).angleDegrees).toBeCloseTo(180, 10);
  });

  it("reads the angle of a chamfer face against the top it was cut from", () => {
    // A 30° chamfer: its normal is tilted 30° off the top face's normal.
    const tilt = (30 * Math.PI) / 180;
    const measured = planarFaceAngle(
      { surfaceKind: "plane", normal: { x: 0, y: 1, z: 0 } },
      { surfaceKind: "plane", normal: { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 } },
    );
    expect(taken(measured).angleDegrees).toBeCloseTo(30, 10);
  });

  it("refuses when either face is not a plane", () => {
    const plane = { surfaceKind: "plane", normal: { x: 0, y: 1, z: 0 } };
    const cylinder = { surfaceKind: "cylinder", normal: { x: 1, y: 0, z: 0 } };
    expect(planarFaceAngle(plane, cylinder)).toEqual({ available: false, code: "notPlanar" });
    expect(planarFaceAngle(cylinder, plane)).toEqual({ available: false, code: "notPlanar" });
    expect(planarFaceAngle(cylinder, cylinder)).toEqual({ available: false, code: "notPlanar" });
  });
});
