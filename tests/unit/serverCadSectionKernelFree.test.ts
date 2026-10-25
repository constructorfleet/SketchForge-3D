import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { importedShapeFromTriangleSoup } from "@constructorfleet/sketchforge-engine/stlImport";
import type { WorkplaneShape } from "@/types/sketchforge";

// The section module imports the kernel through this path; any use of it fails the test.
vi.mock("@constructorfleet/sketchforge-engine/serverCadKernel", () => ({
  withCadKernel: () => {
    throw new Error("the CAD kernel was started for a mesh-only section");
  },
}));

const { sectionShapesToSvg } = await import("@constructorfleet/sketchforge-engine/serverCadSection");

describe("mesh-only section drawings", () => {
  it("are sliced without starting the CAD kernel", async () => {
    const box = new THREE.BoxGeometry(4, 2, 6).toNonIndexed();
    const mesh = importedShapeFromTriangleSoup("box.stl", Array.from(box.getAttribute("position").array), undefined) as WorkplaneShape;
    box.dispose();
    const svg = await sectionShapesToSvg([mesh], { plane: "xy", offset: 1 });
    expect(svg).toMatch(/<path /);
  });
});
