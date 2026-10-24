import { describe, expect, it } from "vitest";
import { faceAtTriangle } from "@/lib/faceColorPreview";

describe("finding the face a picked triangle belongs to", () => {
  // Three faces: face 2 covers triangles 0-1, face 0 covers 2-4, face 1 covers 5.
  const groups = [0, 2, 2, 2, 3, 0, 5, 1, 1];

  it("maps each triangle to the face whose group covers it", () => {
    expect([0, 1, 2, 3, 4, 5].map((triangle) => faceAtTriangle(groups, 6, triangle))).toEqual([2, 2, 0, 0, 0, 1]);
  });

  it("reads ranges stored in index-buffer entries by earlier versions", () => {
    const legacy = groups.map((value, index) => (index % 3 === 2 ? value : value * 3));
    expect([0, 1, 2, 3, 4, 5].map((triangle) => faceAtTriangle(legacy, 6, triangle))).toEqual([2, 2, 0, 0, 0, 1]);
  });

  it("finds no face for a triangle outside every group", () => {
    expect(faceAtTriangle(groups, 6, 6)).toBeNull();
    expect(faceAtTriangle(groups, 6, -1)).toBeNull();
    expect(faceAtTriangle([], 6, 0)).toBeNull();
    expect(faceAtTriangle([0, 2, 0], 6, 3)).toBeNull();
  });
});
