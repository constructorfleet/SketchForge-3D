import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import { resolveShapeAppearance } from "@/lib/shapeAppearance";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "appearance-box",
    name: "Box",
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 20,
    rotation: 0,
    ...overrides,
  };
}

describe("shape appearance", () => {
  it("keeps legacy shape colors and default shading when no appearance is saved", () => {
    expect(resolveShapeAppearance(shape())).toEqual({
      presetId: undefined,
      baseColor: "#d41721",
      roughness: 0.57,
      metalness: 0.02,
      sheen: 0,
    });
  });

  it("resolves recognizable surface presets and per-shape overrides", () => {
    expect(resolveShapeAppearance(shape({ appearance: { presetId: "wood" } }))).toEqual({
      presetId: "wood",
      baseColor: "#8a5a2b",
      roughness: 0.78,
      metalness: 0,
      sheen: 0.08,
    });
    expect(resolveShapeAppearance(shape({ appearance: {
      presetId: "fabric",
      baseColor: "#b98254",
      roughness: 0.42,
      metalness: 1.4,
      sheen: -0.2,
    } }))).toEqual({
      presetId: "fabric",
      baseColor: "#b98254",
      roughness: 0.42,
      metalness: 1,
      sheen: 0,
    });
  });

  it("falls back to shape.color for unknown future presets", () => {
    expect(resolveShapeAppearance(shape({ appearance: { presetId: "future-finish" } }))).toEqual({
      presetId: "future-finish",
      baseColor: "#d41721",
      roughness: 0.57,
      metalness: 0.02,
      sheen: 0,
    });
  });
});
