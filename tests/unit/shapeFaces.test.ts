import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import { FACE_HIGHLIGHT_COLOR, faceColorsWith, faceEditingCanBeEnabled, shapeFaceCount, shapeFaceKey, shapeHasExactFaces, withFaceHighlight } from "@/lib/shapeFaces";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "box-1", name: "Box", kind: "box", color: "#d41721", x: 0, z: 0, elevation: 0,
    size: 20, width: 20, depth: 20, height: 20, rotation: 0, locked: false, hidden: false,
    ...overrides,
  };
}

const mesh = (faceGroups?: number[]) => ({
  positions: new Array(18).fill(0), baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 2,
  sourceFormat: "json" as const, ...(faceGroups ? { faceGroups } : {}),
});

describe("shape faces", () => {
  it("knows which shapes have exact faces to edit", () => {
    expect(shapeHasExactFaces(shape())).toBe(false);
    expect(shapeHasExactFaces(shape({ kind: "mesh", cadBrep: "brep" }))).toBe(true);
    expect(shapeHasExactFaces(shape({ kind: "mesh", importedMesh: { ...mesh(), brepStep: "step" } }))).toBe(true);
  });

  it("counts faces from stable IDs, else from the mesh's face groups", () => {
    expect(shapeFaceCount(shape({ faceIds: ["a", "b", "c"] }))).toBe(3);
    expect(shapeFaceCount(shape({ kind: "mesh", importedMesh: mesh([0, 1, 4, 1, 1, 2]) }))).toBe(5);
    expect(shapeFaceCount(shape())).toBe(0);
  });

  it("keys a face colour by stable ID when the shape has one", () => {
    expect(shapeFaceKey(shape({ faceIds: ["a", "b"] }), 1)).toBe("b");
    expect(shapeFaceKey(shape(), 1)).toBe("1");
  });

  it("paints the highlighted face for display without touching the stored colours", () => {
    const stored = { "1": "#00ff00" };
    const source = shape({ kind: "mesh", cadBrep: "brep", importedMesh: mesh([0, 1, 0, 1, 1, 1]), faceColors: stored });
    const shown = withFaceHighlight(source, 0);
    expect(shown.faceColors).toEqual({ "0": FACE_HIGHLIGHT_COLOR, "1": "#00ff00" });
    expect(source.faceColors).toBe(stored);
    expect(withFaceHighlight(shape({ faceIds: ["a", "b"], kind: "mesh", importedMesh: mesh([0, 1, 0]) }), 1).faceColors).toEqual({ b: FACE_HIGHLIGHT_COLOR });
    // A face that already has a colour shows that colour, not the highlight.
    expect(withFaceHighlight(source, 1)).toBe(source);
    // Without face groups there is nothing to paint, so the shape is returned as is.
    const plain = shape();
    expect(withFaceHighlight(plain, 0)).toBe(plain);
  });

  it("offers to enable face editing on solid primitives that do not have exact faces yet", () => {
    expect(faceEditingCanBeEnabled(shape())).toBe(true);
    expect(faceEditingCanBeEnabled(shape({ kind: "cylinder" }))).toBe(true);
    expect(faceEditingCanBeEnabled(shape({ hole: true }))).toBe(false);
    expect(faceEditingCanBeEnabled(shape({ kind: "mesh", cadBrep: "brep", importedMesh: mesh() }))).toBe(false);
    expect(faceEditingCanBeEnabled(shape({ kind: "mesh", importedMesh: mesh() }))).toBe(false);
    expect(faceEditingCanBeEnabled(shape({ kind: "text", text: "Hi" }))).toBe(false);
    // An imported picture is a box carrying the image; rebuilding it would drop the picture.
    expect(faceEditingCanBeEnabled(shape({ imagePlate: { dataUrl: "data:image/png;base64,", mimeType: "image/png" } } as Partial<WorkplaneShape>))).toBe(false);
    expect(faceEditingCanBeEnabled(shape({ mirrorX: true }))).toBe(false);
    // Turning about the vertical axis is fine; a tilt would move the rebuilt solid (#420).
    expect(faceEditingCanBeEnabled(shape({ rotation: 30 }))).toBe(true);
    expect(faceEditingCanBeEnabled(shape({ rotationX: 20 }))).toBe(false);
    expect(faceEditingCanBeEnabled(shape({ rotationZ: 15 }))).toBe(false);
  });

  it("sets and clears a face colour under its stable ID, replacing one stored by face number", () => {
    const withIds = shape({ faceIds: ["a", "b"], faceColors: { "1": "#ff0000", a: "#00ff00" } });
    expect(faceColorsWith(withIds, 1, "#0000ff")).toEqual({ a: "#00ff00", b: "#0000ff" });
    expect(faceColorsWith(withIds, 1, null)).toEqual({ a: "#00ff00" });
    expect(faceColorsWith(shape({ faceColors: { "0": "#ff0000" } }), 0, null)).toEqual({});
  });
});
