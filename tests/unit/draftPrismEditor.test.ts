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

  it("does not offer draft for shapes without a retained extrusion profile", () => {
    expect(draftPrismControlForShape(sketch({ sketchProfile: undefined }))).toMatchObject({ available: false });
    expect(draftPrismControlForShape(sketch({ sketchOperation: "revolve" }))).toMatchObject({ available: false });
  });

  it("does not offer draft for curved or multi-loop profiles", () => {
    const curved = sketch();
    curved.sketchProfile!.segments[0]!.kind = "bezier";
    expect(draftPrismControlForShape(curved)).toMatchObject({ available: false });
    expect(draftPrismControlForShape(sketch({ sketchProfile: { ...sketch().sketchProfile!, points: [...sketch().sketchProfile!.points, { id: "e", x: 30, z: 30 }] } }))).toMatchObject({ available: false });
  });

  it("submits the retained profile, extrusion height, and a valid draft angle", () => {
    expect(draftPrismRequestForShape(sketch(), 5)).toMatchObject({ height: 10, angle: 5 });
    expect(draftPrismRequestForShape(sketch(), 0)).toBeNull();
    expect(draftPrismRequestForShape(sketch(), 45)).toBeNull();
  });
});
