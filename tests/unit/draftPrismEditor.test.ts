import { describe, expect, it } from "vitest";
import { draftPrismControlForShape, draftPrismRequestForShape } from "@/lib/draftPrismEditor";
import type { WorkplaneShape } from "@/types/sketchforge";

function sketch(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  const points = [
    { id: "a", x: -10, z: -10 },
    { id: "b", x: 10, z: -10 },
    { id: "c", x: 10, z: 10 },
    { id: "d", x: -10, z: 10 },
  ];
  return {
    id: "shape", name: "Sketch extrusion", kind: "mesh", color: "#d41721",
    x: 0, z: 0, size: 20, width: 20, depth: 20, height: 10, rotation: 0,
    sketchOperation: "extrude",
    sketchProfile: {
      points,
      segments: points.map((point, index) => ({ id: `edge-${index}`, startId: point.id, endId: points[(index + 1) % points.length]!.id, kind: "line" })),
    },
    ...overrides,
  };
}

describe("draft prism editor control", () => {
  it("offers draft for a retained straight closed sketch extrusion", () => {
    expect(draftPrismControlForShape(sketch())).toEqual({ available: true, disabledReason: null });
  });

  it("offers draft whatever order or direction the profile's segments are stored in (#349)", () => {
    const { points, segments } = sketch().sketchProfile!;
    const rotated = [...segments.slice(2), ...segments.slice(0, 2)];
    const reversed = segments.map(({ startId, endId, ...rest }) => ({ ...rest, startId: endId, endId: startId })).reverse();
    for (const variant of [rotated, reversed]) {
      const shape = sketch({ sketchProfile: { points, segments: variant } });
      expect(draftPrismControlForShape(shape)).toEqual({ available: true, disabledReason: null });
      expect(draftPrismRequestForShape(shape, 5)).toMatchObject({ height: 10, angle: 5 });
    }
  });

  it("does not offer draft for a profile with a hole", () => {
    const outer = sketch().sketchProfile!;
    const hole = [{ id: "h1", x: -2, z: -2 }, { id: "h2", x: 2, z: -2 }, { id: "h3", x: 2, z: 2 }, { id: "h4", x: -2, z: 2 }];
    const shape = sketch({ sketchProfile: {
      points: [...outer.points, ...hole],
      segments: [...outer.segments, ...hole.map((point, index) => ({ id: `hole-${index}`, startId: point.id, endId: hole[(index + 1) % hole.length]!.id, kind: "line" as const }))],
    } });
    expect(draftPrismControlForShape(shape)).toMatchObject({ available: false, disabledReason: "unsupported-profile" });
  });

  it("does not offer draft for a profile with a stray point outside its outline", () => {
    const { points, segments } = sketch().sketchProfile!;
    const shape = sketch({ sketchProfile: { points: [...points, { id: "stray", x: 40, z: 40 }], segments } });
    expect(draftPrismControlForShape(shape)).toEqual({ available: false, disabledReason: "unsupported-profile" });
    expect(draftPrismRequestForShape(shape, 5)).toBeNull();
  });

  it("does not offer draft for shapes without a retained extrusion profile", () => {
    expect(draftPrismControlForShape(sketch({ sketchProfile: undefined }))).toMatchObject({ available: false });
    expect(draftPrismControlForShape(sketch({ sketchOperation: "revolve" }))).toMatchObject({ available: false });
  });

  it("does not offer draft for curved or multi-loop profiles", () => {
    const curved = sketch();
    curved.sketchProfile!.segments[0]!.kind = "bezier";
    // A cubic needs both handles; without them the segment is drawn straight.
    curved.sketchProfile!.points[0]!.handleOut = { x: -4, z: -16 };
    curved.sketchProfile!.points[1]!.handleIn = { x: 4, z: -16 };
    expect(draftPrismControlForShape(curved)).toMatchObject({ available: false });
    expect(draftPrismControlForShape(sketch({ sketchProfile: { ...sketch().sketchProfile!, points: [...sketch().sketchProfile!.points, { id: "e", x: 30, z: 30 }] } }))).toMatchObject({ available: false });
  });

  it("submits the retained profile, extrusion height, and a valid draft angle", () => {
    expect(draftPrismRequestForShape(sketch(), 5)).toMatchObject({ height: 10, angle: 5 });
    expect(draftPrismRequestForShape(sketch(), 0)).toBeNull();
    expect(draftPrismRequestForShape(sketch(), 45)).toBeNull();
  });
});
