import { describe, expect, it } from "vitest";
import manifoldModule from "manifold-3d";
import { projectedMeshContours } from "@sketchforge/engine/svgMeshProjection";

describe("projectedMeshContours", () => {
  it("projects an open triangle mesh without requiring manifold closure", () => {
    const contours = projectedMeshContours(
      [[0, 0, 0], [4, 0, 0], [0, 0, 3]],
      [[0, 1, 2]],
    );
    expect(contours).toEqual([[[0, 0], [0, -3], [4, 0]]]);
  });

  it("unions open mesh projections into a drawable outline", async () => {
    const runtime = await manifoldModule();
    runtime.setup();
    const contours = projectedMeshContours(
      [[0, 0, 0], [4, 0, 0], [0, 0, 3], [4, 0, 0], [4, 0, 3], [0, 0, 3]],
      [[0, 1, 2], [3, 4, 5]],
    );
    const section = new runtime.CrossSection(contours, "Positive");
    try {
      expect(section.toPolygons()).toHaveLength(1);
    } finally {
      section.delete();
    }
  });

  it("drops triangles that collapse in the top view and normalizes winding", () => {
    const contours = projectedMeshContours(
      [[0, 0, 0], [0, 4, 0], [0, 0, 4], [2, 0, 0], [3, 0, 0], [2, 0, 1]],
      [[0, 1, 2], [3, 4, 5]],
    );
    expect(contours).toHaveLength(1);
    expect(contours[0]).toEqual([[2, 0], [2, -1], [3, 0]]);
  });
});
