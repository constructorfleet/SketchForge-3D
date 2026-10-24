/**
 * Face groups say which mesh triangles belong to which B-rep face, so a face
 * colour can be painted in the viewport. The kernel reports each group's range
 * in index-buffer entries (three per triangle) and names the face by hash; the
 * stored mesh and `createFaceColorPreviewGeometry` count triangles and name
 * the face by its position in the solid's face listing.
 */
import { describe, expect, it } from "vitest";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { meshShapeWithFaceGroups } from "@constructorfleet/sketchforge-engine/cadFaceMesh";
import { meshedCadResult } from "@constructorfleet/sketchforge-engine/serverCadOperations";

type Groups = ArrayLike<number>;

function groupedTriangles(groups: Groups) {
  let total = 0;
  for (let group = 0; group + 2 < groups.length; group += 3) total += groups[group + 1]!;
  return total;
}

/** Each planar box face's triangles must all face the way that face does. */
function trianglesLieOnTheirFaces(cad: OcctKernel, solid: ShapeHandle, positions: ArrayLike<number>, groups: Groups) {
  const faces = cad.getSubShapes(solid, "face");
  const mismatches: string[] = [];
  for (let group = 0; group + 2 < groups.length; group += 3) {
    const [start, count, faceIndex] = [groups[group]!, groups[group + 1]!, groups[group + 2]!];
    const bounds = cad.uvBounds(faces[faceIndex]!);
    const expected = cad.surfaceNormal(faces[faceIndex]!, (bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2);
    for (let triangle = start; triangle < start + count; triangle += 1) {
      const p = (corner: number) => {
        const offset = (triangle * 3 + corner) * 3;
        return [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
      };
      const [a, b, c] = [p(0), p(1), p(2)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const length = Math.hypot(n[0]!, n[1]!, n[2]!);
      const alignment = Math.abs((n[0]! * expected.x + n[1]! * expected.y + n[2]! * expected.z) / length);
      if (alignment < 0.999) mismatches.push(`triangle ${triangle} in face ${faceIndex}`);
    }
  }
  return mismatches;
}

function flatten(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }) {
  const positions: number[] = [];
  for (let corner = 0; corner < mesh.indices.length; corner += 1) {
    const vertex = mesh.indices[corner]! * 3;
    positions.push(mesh.positions[vertex]!, mesh.positions[vertex + 1]!, mesh.positions[vertex + 2]!);
  }
  return positions;
}

describe("face-grouped CAD meshes", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("groups every triangle of a box under the face it lies on, counted in triangles", async () => {
    await withCadKernel((cad) => {
      try {
        const box = cad.makeBox(20, 10, 30);
        const mesh = meshShapeWithFaceGroups(cad, box);
        expect(mesh.triangleCount).toBe(12);
        expect(mesh.faceGroups.length / 3).toBe(6);
        expect(groupedTriangles(mesh.faceGroups)).toBe(mesh.triangleCount);
        expect(mesh.faceGroups.filter((_, index) => index % 3 === 2).sort()).toEqual([0, 1, 2, 3, 4, 5]);
        expect(trianglesLieOnTheirFaces(cad, box, flatten(mesh), mesh.faceGroups)).toEqual([]);
      } finally {
        cad.releaseAll();
      }
    });
  });

  it("keeps face numbering through a B-rep round trip, which is how the editor stores a treated solid", async () => {
    await withCadKernel((cad) => {
      try {
        const box = cad.makeBox(20, 20, 20);
        const filleted = cad.fillet(box, cad.getSubShapes(box, "edge"), 2);
        const restored = cad.fromBREP(cad.toBREP(filleted));
        const before = meshShapeWithFaceGroups(cad, filleted);
        const after = meshShapeWithFaceGroups(cad, restored);
        expect(after.faceGroups.length / 3).toBe(cad.getSubShapes(restored, "face").length);
        expect(groupedTriangles(after.faceGroups)).toBe(after.triangleCount);
        expect(after.faceGroups).toEqual(before.faceGroups);
      } finally {
        cad.releaseAll();
      }
    });
  });

  it("stores server CAD results with face groups counted in triangles", async () => {
    await withCadKernel((cad) => {
      try {
        const box = cad.makeBox(20, 10, 30);
        const result = meshedCadResult(cad, box);
        const groups = result.faceGroups ?? [];
        const triangleCount = result.positions.length / 9;
        expect(groups.length / 3).toBe(6);
        expect(groupedTriangles(groups)).toBe(triangleCount);
        expect(trianglesLieOnTheirFaces(cad, box, result.positions, groups)).toEqual([]);
      } finally {
        cad.releaseAll();
      }
    });
  });
});
