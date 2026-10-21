import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createFaceColorPreviewGeometry } from "@/lib/faceColorPreview";

describe("face color viewport preview", () => {
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
});
