import { describe, expect, it } from "vitest";
import { faceIdsFromEvolution } from "@constructorfleet/sketchforge-engine/faceLineage";

describe("face identity from OCCT topology history", () => {
  it("retains IDs for unchanged faces even when geometric signatures are repeated", () => {
    expect(faceIdsFromEvolution(
      "plate",
      ["face_top_a", "face_top_b"],
      [101, 102],
      [101, 102],
      { modified: [], generated: [] },
    )).toEqual(["face_top_a", "face_top_b"]);
  });

  it("retains a color identity only for a one-to-one modified face", () => {
    expect(faceIdsFromEvolution(
      "plate",
      ["face_side"],
      [101],
      [201],
      { modified: [101, 1, 201], generated: [] },
    )).toEqual(["face_side"]);
  });

  it("does not assign an old face identity to either side of a split", () => {
    const ids = faceIdsFromEvolution(
      "plate",
      ["face_side"],
      [101],
      [201, 202],
      { modified: [101, 1, 201, 101, 1, 202], generated: [] },
    );

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("face_side");
  });

  it("does not assign one merged result identity to multiple source faces", () => {
    const ids = faceIdsFromEvolution(
      "plate",
      ["face_left", "face_right"],
      [101, 102],
      [201],
      { modified: [101, 1, 201, 102, 1, 201], generated: [] },
    );

    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe("face_left");
    expect(ids[0]).not.toBe("face_right");
  });

  it("gives explicitly generated faces a fresh identity", () => {
    const ids = faceIdsFromEvolution(
      "plate",
      ["face_side"],
      [101],
      [201],
      { modified: [101, 1, 201], generated: [201] },
    );

    expect(ids[0]).not.toBe("face_side");
    expect(ids[0]).toMatch(/^face_/);
  });
});
