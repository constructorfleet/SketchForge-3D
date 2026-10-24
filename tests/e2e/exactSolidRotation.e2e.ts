import { describe, expect, it } from "vitest";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { exactSolidForShape } from "@constructorfleet/sketchforge-engine/cadSolids";
import type { WorkplaneShape } from "@/types/sketchforge";

/**
 * The exact solid has to be turned the way the editor turns the shape, because
 * an edge treatment bakes that rotation into a mesh and then clears it: if the
 * two disagree, a filleted shape comes back facing a different way than the one
 * the user filleted.
 *
 * The editor uses `THREE.Euler(rotationX, rotation, rotationZ)` in its default
 * "XYZ" order, which is the matrix Rx * Ry * Rz, and turns the shape about its
 * centre, `height / 2` above its base -- not about the base, which is where the
 * exact solid used to turn a pitch or a roll (#420). This measures the solid's
 * centre of mass, which only an asymmetric shape exposes -- a box or a cylinder
 * is unchanged by a 180-degree error, which is how a negated yaw and a reversed
 * order survived here unnoticed.
 */
type Mat3 = readonly (readonly number[])[];
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const rx = (d: number): Mat3 => [[1, 0, 0], [0, Math.cos(rad(d)), -Math.sin(rad(d))], [0, Math.sin(rad(d)), Math.cos(rad(d))]];
const ry = (d: number): Mat3 => [[Math.cos(rad(d)), 0, Math.sin(rad(d))], [0, 1, 0], [-Math.sin(rad(d)), 0, Math.cos(rad(d))]];
const rz = (d: number): Mat3 => [[Math.cos(rad(d)), -Math.sin(rad(d)), 0], [Math.sin(rad(d)), Math.cos(rad(d)), 0], [0, 0, 1]];
const mul = (a: Mat3, b: Mat3): Mat3 => a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));
const apply = (m: Mat3, v: readonly number[]) => m.map((row) => row.reduce((sum, c, i) => sum + c * v[i], 0));

/** A point turned by `m` about a pivot `pivotY` above the origin, the way the viewport turns a shape. */
function turnedAbout(m: Mat3, pivotY: number, v: readonly number[]) {
  const [x, y, z] = apply(m, [v[0], v[1] - pivotY, v[2]]);
  return [x, y + pivotY, z];
}

/** The editor's own orientation for a shape, as a matrix. */
function editorRotation(shape: Pick<WorkplaneShape, "rotation" | "rotationX" | "rotationZ">) {
  return mul(mul(rx(shape.rotationX ?? 0), ry(shape.rotation ?? 0)), rz(shape.rotationZ ?? 0));
}

const ROTATIONS = [
  { rotation: 90, rotationX: 0, rotationZ: 0 },
  { rotation: 0, rotationX: 90, rotationZ: 0 },
  { rotation: 0, rotationX: 0, rotationZ: 90 },
  { rotation: -45, rotationX: 0, rotationZ: 0 },
  { rotation: 30, rotationX: 40, rotationZ: 0 },
  { rotation: 30, rotationX: 0, rotationZ: 50 },
  { rotation: 30, rotationX: 40, rotationZ: 50 },
] as const;

// Asymmetric in at least one axis, so a wrong orientation moves the centroid.
const ASYMMETRIC: Array<{ label: string; shape: Partial<WorkplaneShape> }> = [
  { label: "wedge", shape: { kind: "wedge", width: 40, depth: 20, height: 10 } },
  { label: "roof", shape: { kind: "roof", width: 40, depth: 20, height: 12 } },
  { label: "cone with a top radius", shape: { kind: "cone", width: 30, depth: 30, height: 24, topRadius: 5 } },
  { label: "pyramid", shape: { kind: "pyramid", width: 24, depth: 24, height: 30 } },
];

function shapeOf(overrides: Partial<WorkplaneShape>): WorkplaneShape {
  return {
    id: "s", name: "Shape", kind: "box", color: "#888888",
    x: 0, z: 0, elevation: 0, size: 40, width: 40, depth: 20, height: 10, rotation: 0,
    ...overrides,
  } as WorkplaneShape;
}

describe("exactSolidForShape orientation", () => {
  for (const { label, shape } of ASYMMETRIC) {
    it(`turns a ${label} the way the editor turns it`, async () => {
      const measured = await withCadKernel(async (cad) => {
        const flat = cad.queryBatch([exactSolidForShape(cad, shapeOf(shape))])[0];
        return {
          flat: [flat.centerOfMass.x, flat.centerOfMass.y, flat.centerOfMass.z] as const,
          volume: flat.volume,
          turned: ROTATIONS.map((rotation) => {
            const query = cad.queryBatch([exactSolidForShape(cad, shapeOf({ ...shape, ...rotation }))])[0];
            return { centre: [query.centerOfMass.x, query.centerOfMass.y, query.centerOfMass.z] as const, volume: query.volume };
          }),
        };
      });

      expect(measured.volume).toBeGreaterThan(0);
      ROTATIONS.forEach((rotation, index) => {
        const actual = measured.turned[index];
        const expected = turnedAbout(editorRotation(rotation), shapeOf(shape).height / 2, measured.flat);
        const where = `${label} at yaw ${rotation.rotation} pitch ${rotation.rotationX} roll ${rotation.rotationZ}`;
        // Rotating a solid cannot change how much of it there is.
        expect(actual.volume, `${where} changed volume`).toBeCloseTo(measured.volume, 2);
        expected.forEach((value, axis) => {
          expect(actual.centre[axis], `${where}, axis ${"xyz"[axis]}`).toBeCloseTo(value, 2);
        });
      });
    });
  }
});
