/**
 * "Enable face editing" rebuilds a parametric shape as the exact solid the
 * CAD worker builds from `{ exact: { shape, transform: exactBooleanPlacement(shape) } }`,
 * and the editor then places the new shape from that solid's bounds. If the
 * solid sat anywhere else, or turned the wrong way, the shape would jump when
 * face editing was enabled. Each case compares the exact solid's bounds with
 * the shape's own bounding box placed by `transformMesh`, the transform the
 * viewport and exports apply. That box is exact for a box turned any way and
 * for any shape that is not turned. A tilted box is where the exact solid used
 * to turn about its base rather than its centre and land off where it was drawn
 * (#420), so tilted boxes are among the cases; `exactSolidRotation.e2e.ts`
 * checks the centre of mass of tilted asymmetric shapes.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CAD_TEST_TIMEOUT_MS } from "../unit/support/cadTestTimeout";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { exactPartSolid } from "@constructorfleet/sketchforge-engine/exactBooleanSolids";
import { exactBooleanPlacement } from "@constructorfleet/sketchforge-engine/exactBooleanParts";
import { transformMesh, type Vec3 } from "@constructorfleet/sketchforge-engine/meshTransform";
import { createTorusGeometry, putGeometryOnBase } from "@constructorfleet/sketchforge-engine/primitiveGeometry";
import { shapeDepth, shapeWidth } from "@constructorfleet/sketchforge-engine/workplaneShapes";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { faceEditingCanBeEnabled } from "@/lib/shapeFaces";
import type { WorkplaneShape } from "@/types/sketchforge";
import { measureMesh } from "../unit/support/meshMeasure";

function placed(overrides: Partial<WorkplaneShape> & Pick<WorkplaneShape, "kind">): WorkplaneShape {
  return { ...sceneShape({ name: overrides.kind, color: "#d41721", ...overrides }), ...overrides };
}

const CASES: WorkplaneShape[] = [
  placed({ kind: "box", x: 12, z: -7, elevation: 3, width: 30, depth: 10, height: 6, size: 30, rotation: 30 }),
  placed({ kind: "wedge", x: -15, z: 4, elevation: 1, width: 20, depth: 12, height: 9, size: 20, rotation: 0 }),
  placed({ kind: "cone", x: 5, z: 5, elevation: 2, width: 16, depth: 16, height: 18, size: 16, rotation: 0 }),
  placed({ kind: "roof", x: 0, z: -20, elevation: 0, width: 24, depth: 14, height: 8, size: 24, rotation: 0 }),
  placed({ kind: "box", x: 12, z: -7, elevation: 3, width: 30, depth: 10, height: 6, size: 30, rotation: 0, rotationX: 20 }),
  placed({ kind: "box", x: -4, z: 9, elevation: 5, width: 18, depth: 12, height: 14, size: 18, rotation: 30, rotationZ: -25 }),
  placed({ kind: "box", x: 6, z: 2, elevation: 0, width: 22, depth: 8, height: 10, size: 22, rotation: 15, rotationX: 40, rotationZ: 35 }),
];

/** The shape's local bounding box, centred in X and Z and standing on Y = 0, placed in the world. */
function placedBoundingBox(shape: WorkplaneShape) {
  const [w, d, h] = [shapeWidth(shape) / 2, shapeDepth(shape) / 2, shape.height];
  const vertices: Vec3[] = [];
  for (const x of [-w, w]) for (const y of [0, h]) for (const z of [-d, d]) vertices.push([x, y, z]);
  return transformMesh({ name: shape.name, vertices, faces: [] }, shape);
}

describe("exact rebuild for face editing", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it.each(CASES.map((shape) => [`${shape.kind} at (${shape.x}, ${shape.elevation}, ${shape.z}) turned ${shape.rotation}°/${shape.rotationX ?? 0}°/${shape.rotationZ ?? 0}°`, shape] as const))(
    "puts the %s where the viewport draws it",
    async (_, shape) => {
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
          return { ...cad.getBoundingBox(solid, true), volume: cad.getVolume(solid), centre: cad.getCenterOfMass(solid) };
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
      if (shape.kind === "box") {
        // A box's centre of mass is its middle, which the viewport turns it
        // about and so never moves, whatever the rotation. Checked alongside
        // the bounds because bounds are a proxy; this is the quantity itself.
        expect(exact.volume).toBeCloseTo(shapeWidth(shape) * shapeDepth(shape) * shape.height, 4);
        expect(exact.centre.x).toBeCloseTo(shape.x, 4);
        expect(exact.centre.y).toBeCloseTo((shape.elevation ?? 0) + shape.height / 2, 4);
        expect(exact.centre.z).toBeCloseTo(shape.z, 4);
      }
      // Last, so a shape that would move fails on where it lands rather than
      // on being refused.
      expect(faceEditingCanBeEnabled(shape)).toBe(true);
    },
  );
});


const TORUS_CASES = [
  placed({ kind: "torus", x: 4, z: -3, elevation: 2, width: 40, depth: 40, height: 10, size: 40 }),
  placed({ kind: "torus", x: 4, z: -3, elevation: 2, width: 40, depth: 40, height: 10, size: 40, rotationX: 30 }),
] as const;

function viewportTorusCentre(shape: WorkplaneShape) {
  const mesh = putGeometryOnBase(createTorusGeometry(shapeWidth(shape), shape.height, shapeDepth(shape)));
  const localCentre = new THREE.Vector3(...measureMesh(mesh).centroid);
  const pivot = new THREE.Vector3(0, shape.height / 2, 0);
  return localCentre
    .sub(pivot)
    .applyEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shape.rotation ?? 0),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ))
    .add(pivot)
    .add(new THREE.Vector3(shape.x, shape.elevation ?? 0, shape.z));
}

describe("exact torus face editing placement", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it.each(TORUS_CASES.map((shape) => [`rotationX=${shape.rotationX ?? 0}`, shape] as const))(
    "keeps an untilted or tilted torus at the viewport mesh centre (%s)",
    async (_, shape) => {
      const drawn = viewportTorusCentre(shape);
      const exact = await withCadKernel((cad) => {
        try {
          const solid = exactPartSolid(cad, { shape, transform: exactBooleanPlacement(shape) });
          return cad.getCenterOfMass(solid);
        } finally {
          cad.releaseAll();
        }
      });
      expect(exact.x).toBeCloseTo(drawn.x, 3);
      expect(exact.y).toBeCloseTo(drawn.y, 3);
      expect(exact.z).toBeCloseTo(drawn.z, 3);
    },
  );
});
