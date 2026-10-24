/**
 * "Enable face editing" rebuilds a parametric shape as the exact solid the
 * CAD worker builds from `{ exact: { shape, transform: exactBooleanPlacement(shape) } }`,
 * and the editor then places the new shape from that solid's bounds. If the
 * solid sat anywhere else, or turned the wrong way, the shape would jump when
 * face editing was enabled. Each case compares the exact solid's bounds with
 * the shape's own bounding box placed by `transformMesh`, the transform the
 * viewport and exports apply. That box is exact for a box turned about the
 * vertical axis and for any shape that is not turned. Tilted shapes are not
 * offered face editing yet (#420), and the last case pins why.
 */
import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "../unit/support/cadTestTimeout";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { exactPartSolid } from "@constructorfleet/sketchforge-engine/exactBooleanSolids";
import { exactBooleanPlacement } from "@constructorfleet/sketchforge-engine/exactBooleanParts";
import { transformMesh, type Vec3 } from "@constructorfleet/sketchforge-engine/meshTransform";
import { shapeDepth, shapeWidth } from "@constructorfleet/sketchforge-engine/workplaneShapes";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { faceEditingCanBeEnabled } from "@/lib/shapeFaces";
import type { WorkplaneShape } from "@/types/sketchforge";

function placed(overrides: Partial<WorkplaneShape> & Pick<WorkplaneShape, "kind">): WorkplaneShape {
  return { ...sceneShape({ name: overrides.kind, color: "#d41721", ...overrides }), ...overrides };
}

const CASES: WorkplaneShape[] = [
  placed({ kind: "box", x: 12, z: -7, elevation: 3, width: 30, depth: 10, height: 6, size: 30, rotation: 30 }),
  placed({ kind: "wedge", x: -15, z: 4, elevation: 1, width: 20, depth: 12, height: 9, size: 20, rotation: 0 }),
  placed({ kind: "cone", x: 5, z: 5, elevation: 2, width: 16, depth: 16, height: 18, size: 16, rotation: 0 }),
  placed({ kind: "roof", x: 0, z: -20, elevation: 0, width: 24, depth: 14, height: 8, size: 24, rotation: 0 }),
];

/** The shape's local bounding box, centred in X and Z and standing on Y = 0, placed in the world. */
function placedBoundingBox(shape: WorkplaneShape) {
  const [w, d, h] = [shapeWidth(shape) / 2, shapeDepth(shape) / 2, shape.height];
  const vertices: Vec3[] = [];
  for (const x of [-w, w]) for (const y of [0, h]) for (const z of [-d, d]) vertices.push([x, y, z]);
  return transformMesh({ name: shape.name, vertices, faces: [] }, shape);
}

describe("exact rebuild for face editing", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it.each(CASES.map((shape) => [`${shape.kind} at (${shape.x}, ${shape.elevation}, ${shape.z}) turned ${shape.rotation}°/${shape.rotationX ?? 0}°`, shape] as const))(
    "puts the %s where the viewport draws it",
    async (_, shape) => {
      expect(faceEditingCanBeEnabled(shape)).toBe(true);
      const mesh = placedBoundingBox(shape);
      const drawn = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (const vertex of mesh.vertices) {
        for (let axis = 0; axis < 3; axis += 1) {
          drawn.min[axis] = Math.min(drawn.min[axis]!, vertex[axis]!);
          drawn.max[axis] = Math.max(drawn.max[axis]!, vertex[axis]!);
        }
      }
      const exact = await withCadKernel((cad) => {
        try {
          const solid = exactPartSolid(cad, { shape, transform: exactBooleanPlacement(shape) });
          return cad.getBoundingBox(solid, true);
        } finally {
          cad.releaseAll();
        }
      });
      const tolerance = 0.01;
      expect(Math.abs(exact.xmin - drawn.min[0]!)).toBeLessThan(tolerance);
      expect(Math.abs(exact.xmax - drawn.max[0]!)).toBeLessThan(tolerance);
      expect(Math.abs(exact.ymin - drawn.min[1]!)).toBeLessThan(tolerance);
      expect(Math.abs(exact.ymax - drawn.max[1]!)).toBeLessThan(tolerance);
      expect(Math.abs(exact.zmin - drawn.min[2]!)).toBeLessThan(tolerance);
      expect(Math.abs(exact.zmax - drawn.max[2]!)).toBeLessThan(tolerance);
    },
  );

  it("still moves a tilted shape, which is why face editing is not offered for one (#420)", async () => {
    const tilted = placed({ kind: "box", x: 12, z: -7, elevation: 3, width: 30, depth: 10, height: 6, size: 30, rotation: 0, rotationX: 20 });
    expect(faceEditingCanBeEnabled(tilted)).toBe(false);
    const drawn = placedBoundingBox(tilted).vertices;
    const drawnMinZ = Math.min(...drawn.map((vertex) => vertex[2]!));
    const exactMinZ = await withCadKernel((cad) => {
      try {
        return cad.getBoundingBox(exactPartSolid(cad, { shape: tilted, transform: exactBooleanPlacement(tilted) }), true).zmin;
      } finally {
        cad.releaseAll();
      }
    });
    // Turned about its base rather than its centre: 3 mm up the box, sin 20° of it.
    expect(exactMinZ - drawnMinZ).toBeCloseTo(3 * Math.sin(20 * Math.PI / 180), 3);
  });
});
