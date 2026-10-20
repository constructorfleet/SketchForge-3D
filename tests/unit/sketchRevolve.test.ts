import { beforeAll, describe, expect, it } from "vitest";
import manifoldModule, { type ManifoldToplevel } from "manifold-3d";
import {
  buildSketchRevolveMesh,
  helicalRevolveSteps,
  isHelicalRevolve,
  MAX_REVOLVE_PITCH,
  MAX_REVOLVE_RINGS,
  MAX_REVOLVE_TURNS,
  normalizeSketchRevolveSettings,
  sketchProfileToRevolvePolygons,
} from "@/lib/sketchRevolve";
import type { SketchProfile } from "@/types/sketchforge";

function rectangleProfile(innerRadius = 5, outerRadius = 10, height = 20): SketchProfile {
  return {
    points: [
      { id: "a", x: -innerRadius, z: 0 },
      { id: "b", x: -outerRadius, z: 0 },
      { id: "c", x: -outerRadius, z: height },
      { id: "d", x: -innerRadius, z: height },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b", kind: "line" },
      { id: "bc", startId: "b", endId: "c", kind: "line" },
      { id: "cd", startId: "c", endId: "d", kind: "line" },
      { id: "da", startId: "d", endId: "a", kind: "line" },
    ],
  };
}

/** Signed volume of a triangle soup, by the divergence theorem. */
function meshVolume(positions: number[]) {
  let total = 0;
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(index, index + 9);
    total += (
      ax * (by * cz - bz * cy)
      - ay * (bx * cz - bz * cx)
      + az * (bx * cy - by * cx)
    ) / 6;
  }
  return Math.abs(total);
}

describe("sketch revolve", () => {
  let runtime: ManifoldToplevel;

  beforeAll(async () => {
    runtime = await manifoldModule();
    runtime.setup();
  });

  it("revolves a closed left-side profile around the center axis", () => {
    const mesh = buildSketchRevolveMesh(runtime, rectangleProfile(), { sides: 32 });
    expect(mesh.triangleCount).toBeGreaterThan(100);
    expect(mesh.width).toBeCloseTo(20, 4);
    expect(mesh.depth).toBeCloseTo(20, 4);
    expect(mesh.height).toBeCloseTo(20, 4);
    expect(Math.min(...mesh.positions.filter((_value, index) => index % 3 === 1))).toBeCloseTo(0, 6);
  });

  it("requires a closed profile", () => {
    const profile: SketchProfile = {
      points: [{ id: "a", x: -8, z: 0 }, { id: "b", x: -8, z: 20 }],
      segments: [{ id: "ab", startId: "a", endId: "b", kind: "line" }],
    };
    expect(sketchProfileToRevolvePolygons(profile)).toEqual([]);
    expect(() => buildSketchRevolveMesh(runtime, profile, { sides: 24 })).toThrow("Draw at least one closed profile");
  });

  it("clips a closed profile at the revolve axis", () => {
    const profile: SketchProfile = {
      points: [
        { id: "top-right", x: 10, z: 0 },
        { id: "top-left", x: -10, z: 0 },
        { id: "bottom-left", x: -10, z: 20 },
        { id: "bottom-right", x: 10, z: 20 },
      ],
      segments: [
        { id: "top", startId: "top-right", endId: "top-left", kind: "line" },
        { id: "left", startId: "top-left", endId: "bottom-left", kind: "line" },
        { id: "bottom", startId: "bottom-left", endId: "bottom-right", kind: "line" },
        { id: "right", startId: "bottom-right", endId: "top-right", kind: "line" },
      ],
    };
    const polygons = sketchProfileToRevolvePolygons(profile);
    expect(polygons).toHaveLength(1);
    expect(Math.min(...polygons[0].map((point) => point[0]))).toBeCloseTo(0, 6);
    expect(Math.max(...polygons[0].map((point) => point[0]))).toBeCloseTo(10, 6);

    const mesh = buildSketchRevolveMesh(runtime, profile, { sides: 24 });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.height).toBeCloseTo(20, 4);
  });

  it("supports partial and reverse sweeps", () => {
    const quarter = buildSketchRevolveMesh(runtime, rectangleProfile(), { startAngle: 30, sweepAngle: 90, sides: 48 });
    const reverse = buildSketchRevolveMesh(runtime, rectangleProfile(), { startAngle: 120, sweepAngle: -90, sides: 48 });
    expect(quarter.triangleCount).toBeGreaterThan(0);
    expect(reverse.triangleCount).toBeGreaterThan(0);
    expect(quarter.width).toBeLessThanOrEqual(20.001);
    expect(quarter.depth).toBeLessThanOrEqual(20.001);
  });

  it("normalizes unsafe revolve settings", () => {
    expect(normalizeSketchRevolveSettings({ startAngle: -30, sweepAngle: 0, sides: 900, quality: 0 })).toEqual({
      startAngle: 330,
      sweepAngle: 1,
      sides: 512,
      quality: 1,
      pitch: 0,
      turns: 1,
      coreRadius: 0,
    });
  });

  it("normalizes pitch and turns", () => {
    const settings = normalizeSketchRevolveSettings({ pitch: 9999, turns: 500 });
    expect(settings.pitch).toBe(MAX_REVOLVE_PITCH);
    expect(settings.turns).toBe(MAX_REVOLVE_TURNS);

    // A pitch too small to see is treated as none, which keeps the exact and
    // cheaper plain revolve.
    expect(normalizeSketchRevolveSettings({ pitch: 1e-9 }).pitch).toBe(0);
    expect(isHelicalRevolve(normalizeSketchRevolveSettings({ pitch: 1e-9 }))).toBe(false);
    expect(isHelicalRevolve(normalizeSketchRevolveSettings({ pitch: -2 }))).toBe(true);
    expect(normalizeSketchRevolveSettings({ turns: 0 }).turns).toBe(0.1);
  });

  it("caps how many rings a helical sweep is built from", () => {
    // 512 sides over 20 turns would be 10,240 rings; the step opens up instead
    // of the editor trying to build millions of triangles.
    const heavy = normalizeSketchRevolveSettings({ pitch: 2, turns: 20, sides: 512 });
    expect(helicalRevolveSteps(heavy)).toBe(MAX_REVOLVE_RINGS);

    const light = normalizeSketchRevolveSettings({ pitch: 2, turns: 2, sides: 64 });
    expect(helicalRevolveSteps(light)).toBe(128);
  });

  describe("helical sweeps", () => {
    /** A 2mm square section between radius 8 and 10. */
    function threadProfile(): SketchProfile {
      return rectangleProfile(8, 10, 2);
    }

    it("sweeps the profile along a helix, rising by the pitch each turn", () => {
      const mesh = buildSketchRevolveMesh(runtime, threadProfile(), { pitch: 4, turns: 3, sides: 64 });

      // Three turns at 4mm rise, plus the 2mm the section is tall.
      expect(mesh.height).toBeCloseTo(14, 1);
      expect(mesh.width).toBeCloseTo(20, 1);
      expect(mesh.depth).toBeCloseTo(20, 1);
      expect(mesh.triangleCount).toBeGreaterThan(500);
    });

    it("produces a solid of the volume the helix sweeps", () => {
      const mesh = buildSketchRevolveMesh(runtime, threadProfile(), { pitch: 4, turns: 3, sides: 128 });

      // Pappus along the helical path: the section's area times the distance
      // its centroid travels.
      const area = 2 * 2;
      const centroidRadius = 9;
      const pathLength = 3 * Math.hypot(2 * Math.PI * centroidRadius, 4);
      expect(meshVolume(mesh.positions) / (area * pathLength)).toBeCloseTo(1, 1);
    });

    it("turns the other way for a negative pitch, with the same volume", () => {
      const right = buildSketchRevolveMesh(runtime, threadProfile(), { pitch: 4, turns: 2, sides: 64 });
      const left = buildSketchRevolveMesh(runtime, threadProfile(), { pitch: -4, turns: 2, sides: 64 });

      expect(left.height).toBeCloseTo(right.height, 4);
      // Within faceting: the rings land at different angles going down than up.
      expect(meshVolume(left.positions) / meshVolume(right.positions)).toBeCloseTo(1, 2);
      // A left-hand thread is not the same solid as a right-hand one.
      expect(left.positions).not.toEqual(right.positions);
    });

    it("keeps a plain revolve when the pitch is zero", () => {
      const plain = buildSketchRevolveMesh(runtime, threadProfile(), { pitch: 0, turns: 3, sides: 64 });

      // No rise, and turns is ignored: one revolution of the section.
      expect(plain.height).toBeCloseTo(2, 4);
    });

    it("sweeps a section with a hole in it", () => {
      // Manifold's triangulator caps the ends, so a hole in the section does
      // not need a triangulator written here.
      const outer = rectangleProfile(6, 12, 6);
      const inner = rectangleProfile(8, 10, 4);
      const hole: SketchProfile = {
        points: [...outer.points, ...inner.points.map((point) => ({ ...point, id: `in-${point.id}`, z: point.z + 1 }))],
        segments: [...outer.segments, ...inner.segments.map((segment) => ({
          ...segment,
          id: `in-${segment.id}`,
          startId: `in-${segment.startId}`,
          endId: `in-${segment.endId}`,
        }))],
      };

      const mesh = buildSketchRevolveMesh(runtime, hole, { pitch: 3, turns: 2, sides: 48 });

      expect(mesh.triangleCount).toBeGreaterThan(500);
      expect(mesh.height).toBeCloseTo(12, 1);
    });
  });
});
