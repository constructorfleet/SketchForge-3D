import { describe, expect, it } from "vitest";
import { faceTrianglePositions } from "@/lib/faceColorPreview";
import { isFacePickClick } from "@/lib/facePicking";

describe("deciding whether a press and release on a face picks it", () => {
  const press = { pointerId: 1, clientX: 100, clientY: 200 };
  const release = { type: "pointerup", pointerId: 1, clientX: 102, clientY: 201 };

  it("picks on a release close to the press that moved nothing", () => {
    expect(isFacePickClick(press, release, false)).toBe(true);
  });

  it("does not pick when the press moved a shape, however small the pointer travel", () => {
    expect(isFacePickClick(press, release, true)).toBe(false);
  });

  it("does not pick on a drag, a cancel, another pointer, or no press on a face", () => {
    expect(isFacePickClick(press, { ...release, clientX: 105 }, false)).toBe(false);
    expect(isFacePickClick(press, { ...release, type: "pointercancel" }, false)).toBe(false);
    expect(isFacePickClick(press, { ...release, pointerId: 2 }, false)).toBe(false);
    expect(isFacePickClick(null, release, false)).toBe(false);
  });
});

describe("the triangles the hover highlight paints for one face", () => {
  // Three triangles, each vertex's x set to its triangle number so they can be told apart.
  const positions = new Float32Array(Array.from({ length: 27 }, (_, index) => (index % 3 === 0 ? Math.floor(index / 9) : 0)));
  const groups = [0, 1, 0, 1, 2, 1];

  it("copies exactly the triangles of that face, in order", () => {
    const face = faceTrianglePositions(positions, groups, 1);
    expect(face.length).toBe(18);
    expect([face[0], face[9]]).toEqual([1, 2]);
    expect(Array.from(faceTrianglePositions(positions, groups, 0))).toEqual(Array.from(positions.slice(0, 9)));
  });

  it("reads ranges stored in index-buffer entries by earlier versions", () => {
    const face = faceTrianglePositions(positions, [0, 3, 0, 3, 6, 1], 1);
    expect([face.length, face[0], face[9]]).toEqual([18, 1, 2]);
  });

  it("paints nothing for a face no group names", () => {
    expect(faceTrianglePositions(positions, groups, 4).length).toBe(0);
  });
});
