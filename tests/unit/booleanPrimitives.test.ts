import { describe, expect, it } from "vitest";
import { canUsePrimitiveSolid, isAxisAlignedBoxCutter } from "@constructorfleet/sketchforge-engine/booleanPrimitives";
import { transformMesh, type MeshData } from "@constructorfleet/sketchforge-engine/meshTransform";
import type { ShapeKind, WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "s", name: "s", kind: "box", color: "#f00",
    x: 0, z: 0, elevation: 0, size: 20, width: 20, depth: 20, height: 20, rotation: 0,
    ...overrides,
  };
}

const TAPERS: Array<[string, Partial<WorkplaneShape>]> = [
  ["absolute top", { taperTopWidth: 10, taperTopDepth: 10 }],
  ["absolute bottom", { taperBottomWidth: 10, taperBottomDepth: 10 }],
  ["both ends", { taperTopWidth: 20, taperTopDepth: 20, taperBottomWidth: 10, taperBottomDepth: 10 }],
  ["top scale", { taperTopScale: 0.5 }],
  ["bottom scale", { taperBottomScale: 0.5 }],
];

describe("boolean primitive substitution", () => {
  it("accepts a plain axis-aligned box", () => {
    expect(isAxisAlignedBoxCutter(shape())).toBe(true);
    expect(canUsePrimitiveSolid(shape())).toBe(true);
  });

  it("refuses a tapered box, however the taper was expressed", () => {
    // Both fast paths swap the shape for a cuboid built from width/depth/height,
    // which has no taper: substituting one drops it from the boolean result.
    for (const [label, taper] of TAPERS) {
      expect(isAxisAlignedBoxCutter(shape(taper)), label).toBe(false);
      expect(canUsePrimitiveSolid(shape(taper)), label).toBe(false);
    }
  });

  it("refuses a tapered cylinder, sphere and cone too", () => {
    // primitiveManifoldForShape builds these from one size per axis as well.
    for (const kind of ["cylinder", "sphere", "cone"] as ShapeKind[]) {
      expect(canUsePrimitiveSolid(shape({ kind, taperTopScale: 0.5 })), kind).toBe(false);
      expect(canUsePrimitiveSolid(shape({ kind })), kind).toBe(true);
    }
  });

  it("still refuses a rotated box", () => {
    expect(isAxisAlignedBoxCutter(shape({ rotation: 45 }))).toBe(false);
    expect(isAxisAlignedBoxCutter(shape({ rotationX: 30 }))).toBe(false);
    expect(isAxisAlignedBoxCutter(shape({ rotation: 180 }))).toBe(true);
  });

  it("gear is never tapered, so it keeps the primitive path", () => {
    expect(canUsePrimitiveSolid(shape({ kind: "gear", taperTopWidth: 10, taperTopDepth: 10 }))).toBe(true);
  });

  it("the mesh fallback the guards divert to does carry the taper", () => {
    // What makes refusing the primitive correct: the long way round is tapered.
    const box: MeshData = {
      name: "box",
      vertices: [
        [-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10],
        [-10, 20, -10], [10, 20, -10], [10, 20, 10], [-10, 20, 10],
      ],
      faces: [],
    };
    const tapered = transformMesh(box, shape({ taperBottomWidth: 10, taperBottomDepth: 10, taperTopWidth: 20, taperTopDepth: 20 }));
    const widthAt = (y: number) => {
      const xs = tapered.vertices.filter((v) => Math.abs(v[1] - y) < 1e-6).map((v) => v[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(widthAt(0)).toBeCloseTo(10, 6);
    expect(widthAt(20)).toBeCloseTo(20, 6);
  });
});
