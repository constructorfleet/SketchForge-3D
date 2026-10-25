import { describe, expect, it, vi } from "vitest";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { componentColorsByFace } from "@constructorfleet/sketchforge-engine/stepImportCommon";

describe("STEP import metadata association", () => {
  it("leaves face colors unset when one solid has conflicting component metadata", () => {
    const solid = {} as ShapeHandle;
    const face = {} as ShapeHandle;
    const cad = {
      getBoundingBox: vi.fn(() => ({ xmin: 0, ymin: 0, zmin: 0, xmax: 1, ymax: 1, zmax: 1 })),
      getVolume: vi.fn(() => 1),
      getSubShapes: vi.fn(() => [face]),
      hashCode: vi.fn(() => 7),
    } as unknown as OcctKernel;
    const ambiguous = new Map([["1.00000:0.00000:0.00000:0.00000:1.00000:1.00000:1.00000", [
      { color: "#ff0000" },
      { color: "#0000ff" },
    ]]]);

    expect(componentColorsByFace(cad, ambiguous, [solid], [face])).toEqual(new Map());
  });
});
