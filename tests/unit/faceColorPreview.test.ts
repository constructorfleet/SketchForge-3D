import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createFaceColorPreviewGeometry, createFaceHighlightGeometry } from "@/lib/faceColorPreview";

describe("face color viewport preview", () => {
  it("uses persisted face IDs to color face groups while retaining numeric-key compatibility", () => {
    const geometry = createFaceColorPreviewGeometry({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 1, 1, 0, 0, 1, 0,
      ]),
      faceGroups: [0, 1, 0, 1, 1, 1],
      faceIds: ["face_a", "face_b"],
    }, { face_b: "#ff0000" }, "#0098c7");

    const colors = geometry.getAttribute("color") as THREE.BufferAttribute;
    expect([colors.getX(0), colors.getY(0), colors.getZ(0)]).not.toEqual([1, 0, 0]);
    expect([colors.getX(3), colors.getY(3), colors.getZ(3)]).toEqual([1, 0, 0]);

    const legacyGeometry = createFaceColorPreviewGeometry({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      faceGroups: [0, 1, 0],
    }, { 0: "#00ff00" }, "#0098c7");
    const legacyColors = legacyGeometry.getAttribute("color") as THREE.BufferAttribute;
    expect([legacyColors.getX(0), legacyColors.getY(0), legacyColors.getZ(0)]).toEqual([0, 1, 0]);
  });

  it("colors only triangles assigned to CAD face indexes", () => {
    const geometry = createFaceColorPreviewGeometry({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 1, 1, 0, 0, 1, 0,
      ]),
      normals: new Float32Array(18),
      faceGroups: [0, 1, 0, 1, 1, 1],
    }, { 1: "#ff0000" }, "#0098c7");

    expect(geometry.getAttribute("color").count).toBe(6);
    const colors = geometry.getAttribute("color") as THREE.BufferAttribute;
    const base = new THREE.Color("#0098c7");
    expect(colors.getX(0)).toBeCloseTo(base.r);
    expect(colors.getY(0)).toBeCloseTo(base.g);
    expect(colors.getZ(0)).toBeCloseTo(base.b);
    expect([colors.getX(3), colors.getY(3), colors.getZ(3)]).toEqual([1, 0, 0]);
    expect(geometry.getIndex()).toBeNull();
  });

  it("reads face groups that an older server stored in index-buffer units", () => {
    // Two triangles, one per face, stored as [start, count] in index entries (3 per triangle).
    const geometry = createFaceColorPreviewGeometry({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 1, 1, 0, 0, 1, 0,
      ]),
      faceGroups: [0, 3, 0, 3, 3, 1],
    }, { 1: "#ff0000" }, "#0098c7");

    const colors = geometry.getAttribute("color") as THREE.BufferAttribute;
    expect([colors.getX(0), colors.getY(0), colors.getZ(0)]).not.toEqual([1, 0, 0]);
    expect([colors.getX(3), colors.getY(3), colors.getZ(3)]).toEqual([1, 0, 0]);
  });
});

describe("face highlight geometry", () => {
  it("outlines only the outer boundary of the selected triangulated face", () => {
    const mesh = {
      positions: [
        0, 0, 0, 1, 0, 0, 1, 1, 0,
        0, 0, 0, 1, 1, 0, 0, 1, 0,
      ],
      faceGroups: [0, 2, 0],
    };
    const geometry = createFaceHighlightGeometry(mesh, 0);
    const positions = geometry.getAttribute("position");
    expect(positions.count).toBe(8);
    for (let vertex = 0; vertex < positions.count; vertex += 1) expect(positions.getZ(vertex)).toBeCloseTo(0.1);
    expect(createFaceHighlightGeometry(mesh, 1).getAttribute("position").count).toBe(0);
    geometry.dispose();
  });
});
