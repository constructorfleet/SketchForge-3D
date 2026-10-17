import { describe, expect, it } from "vitest";
import {
  ROUND_CYLINDER_SIDES,
  exportYawDegrees,
  isFacetedCylinder,
  planTaper,
  polygonRing,
  rectangleRing,
} from "@/lib/stepProfiles";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "s", name: "s", kind: "box", color: "#000",
    x: 0, z: 0, elevation: 0, size: 20, width: 20, depth: 20, height: 10, rotation: 0,
    ...overrides,
  };
}

describe("faceted cylinders", () => {
  it("treats a deliberately low facet count as a prism", () => {
    for (const sides of [3, 6, 8, 12, ROUND_CYLINDER_SIDES - 1]) {
      expect(isFacetedCylinder(shape({ kind: "cylinder", sides })), String(sides)).toBe(true);
    }
  });

  it("treats the editor's default and above as round", () => {
    for (const sides of [ROUND_CYLINDER_SIDES, 128, 512]) {
      expect(isFacetedCylinder(shape({ kind: "cylinder", sides })), String(sides)).toBe(false);
    }
    expect(isFacetedCylinder(shape({ kind: "cylinder" }))).toBe(false);
  });

  it("only applies to cylinders", () => {
    expect(isFacetedCylinder(shape({ kind: "box", sides: 6 }))).toBe(false);
    expect(isFacetedCylinder(shape({ kind: "cone", sides: 6 }))).toBe(false);
  });

  it("ignores a nonsense facet count", () => {
    expect(isFacetedCylinder(shape({ kind: "cylinder", sides: 2 }))).toBe(false);
    expect(isFacetedCylinder(shape({ kind: "cylinder", sides: Number.NaN }))).toBe(false);
  });
});

describe("export yaw", () => {
  it("drops yaw for a round circular cylinder, which looks the same at any angle", () => {
    expect(exportYawDegrees(shape({ kind: "cylinder", rotation: 30 }))).toBe(0);
    expect(exportYawDegrees(shape({ kind: "cone", rotation: 30 }))).toBe(0);
  });

  it("keeps yaw for a faceted cylinder, whose flats have an orientation", () => {
    // Upstream #94: dropping it silently turned a hex bar.
    expect(exportYawDegrees(shape({ kind: "cylinder", sides: 6, rotation: 30 }))).toBe(30);
  });

  it("keeps yaw for an elliptical cylinder and for every other kind", () => {
    expect(exportYawDegrees(shape({ kind: "cylinder", width: 20, depth: 10, rotation: 30 }))).toBe(30);
    expect(exportYawDegrees(shape({ kind: "box", rotation: 30 }))).toBe(30);
  });
});

describe("profile rings", () => {
  it("places the first polygon vertex towards +Z, matching the viewport's facets", () => {
    const ring = polygonRing(5, 5, 4, 0);
    expect(ring[0][0]).toBeCloseTo(0, 9);
    expect(ring[0][2]).toBeCloseTo(5, 9);
  });

  it("produces one point per side at the requested height", () => {
    const ring = polygonRing(5, 3, 7, -2);
    expect(ring).toHaveLength(7);
    for (const [x, y, z] of ring) {
      expect(y).toBe(-2);
      expect((x / 5) ** 2 + (z / 3) ** 2).toBeCloseTo(1, 9);
    }
  });

  it("gives a rectangle its four corners", () => {
    const ring = rectangleRing(10, 6, 3);
    expect(ring).toHaveLength(4);
    expect(new Set(ring.map(([x]) => Math.abs(x)))).toEqual(new Set([5]));
    expect(new Set(ring.map(([, , z]) => Math.abs(z)))).toEqual(new Set([3]));
    expect(ring.every(([, y]) => y === 3)).toBe(true);
  });
});

describe("taper planning", () => {
  const tapered = (extra: Partial<WorkplaneShape>) =>
    shape({ taperTopWidth: 10, taperTopDepth: 10, taperBottomWidth: 20, taperBottomDepth: 20, ...extra });

  it("says nothing to do for an untapered shape", () => {
    expect(planTaper(shape()).kind).toBe("none");
    expect(planTaper(shape({ kind: "cylinder" })).kind).toBe("none");
  });

  it("uses a cone for a round tapered cylinder, which is exactly what that is", () => {
    const plan = planTaper(tapered({ kind: "cylinder" }));
    expect(plan).toMatchObject({ kind: "cone", bottomRadius: 10, topRadius: 5 });
  });

  it("lofts a tapered box between its two end rectangles", () => {
    const plan = planTaper(tapered({ kind: "box" }));
    if (plan.kind !== "loft") throw new Error(`expected a loft, got ${plan.kind}`);
    expect(plan.bottom).toHaveLength(4);
    expect(plan.top).toHaveLength(4);
    // Bottom 20 wide at -h/2, top 10 wide at +h/2.
    expect(Math.max(...plan.bottom.map(([x]) => x))).toBeCloseTo(10, 9);
    expect(Math.max(...plan.top.map(([x]) => x))).toBeCloseTo(5, 9);
    expect(plan.bottom.every(([, y]) => y === -5)).toBe(true);
    expect(plan.top.every(([, y]) => y === 5)).toBe(true);
  });

  it("lofts a faceted tapered cylinder between two polygons of its own facet count", () => {
    const plan = planTaper(tapered({ kind: "cylinder", sides: 6 }));
    if (plan.kind !== "loft") throw new Error(`expected a loft, got ${plan.kind}`);
    expect(plan.bottom).toHaveLength(6);
    expect(plan.top).toHaveLength(6);
  });

  it("lofts an elliptical tapered cylinder rather than calling it a cone", () => {
    const plan = planTaper(tapered({ kind: "cylinder", width: 20, depth: 10, taperBottomWidth: 20, taperBottomDepth: 10, taperTopWidth: 10, taperTopDepth: 5 }));
    expect(plan.kind).toBe("loft");
  });

  it("reports a taper it cannot build instead of exporting the shape straight", () => {
    // Silently writing an untapered body is a file that does not match the
    // screen, and the difference is only found downstream.
    const plan = planTaper(tapered({ kind: "sphere" }));
    expect(plan.kind).toBe("skip");
    if (plan.kind === "skip") expect(plan.reason).toContain("sphere");
  });
});
