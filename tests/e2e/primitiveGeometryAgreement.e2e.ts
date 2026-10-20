/**
 * The mesh primitives against the exact ones, kind by kind.
 *
 * Every primitive in this editor is built twice over: once as a three.js mesh
 * for the viewport and the mesh boolean fallbacks, and once as an OCCT solid in
 * `serverCadSolids.ts` for the REST API, the exact cut and every edge treatment.
 * Two dispatches over the same `shape.kind` union, and until this file nothing
 * checked that they agreed about what a roof is. They are not required to agree
 * triangle for triangle -- one tessellates a curve and the other does not -- but
 * they had better agree about how much solid there is and where it sits, because
 * a user who fillets a dome, cuts a hole in it and exports it has been handed
 * three different answers from three different builders.
 *
 * This is the test the duplication was hiding: the mesh builders lived in
 * `WorkplaneViewport.tsx` and `SketchForgeEditor.tsx`, and this harness cannot
 * import JSX, so there was no way to write it. It became possible the moment
 * they moved into `apps/web/src/lib/primitiveGeometry.ts`.
 *
 * **Volume and centroid, never bounding extents.** A bounding box cannot see a
 * mirrored solid or a reversed winding, and a box or a cylinder is invariant
 * under the exact 180-degree error a negated yaw produces. That blind spot has
 * hidden two real bugs here already -- a box built from its corner rather than
 * its centre, and the rotation composition `exactSolidRotation.e2e.ts` now pins
 * down, which disagreed with the editor in four of six cases while every test
 * in the suite passed in both directions.
 *
 * In `tests/e2e/` rather than the required gate because it loads the OCCT kernel
 * -- `docs/ENGINE_EXTRACTION.md` §6.1 asks for it here. Worth noting that
 * `tests/unit/exactEditorBooleans.test.ts` loads the same kernel inside the
 * gate, so this could move there later if the signal is wanted on every push.
 */
import { describe, expect, it } from "vitest";
import {
  createHalfSphereGeometry,
  createHollowCylinderGeometry,
  createPyramidGeometry,
  createRoofGeometry,
  createRoundRoofGeometry,
  createTorusGeometry,
  createWedgeGeometry,
} from "@/lib/primitiveGeometry";
import { withCadKernel } from "@/lib/serverCadKernel";
import { exactSolidForShape } from "@/lib/serverCadSolids";
import { sceneShape } from "@/lib/shapeCatalog";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";
import type * as THREE from "three";
import { measureMesh } from "../unit/support/meshMeasure";

/**
 * Three different awkward dimensions, on purpose.
 *
 * With a cube, or with width equal to depth, a builder that swapped two axes --
 * or applied a rotation the other builder did not -- would agree with its
 * counterpart anyway. Nothing here is symmetric enough for that.
 */
const W = 41;
const H = 13;
const D = 23;

function shapeOf(overrides: Partial<WorkplaneShape> & Pick<WorkplaneShape, "kind">): WorkplaneShape {
  return sceneShape({ name: overrides.kind, color: "#d41721", width: W, height: H, depth: D, size: W, ...overrides });
}

/**
 * How the viewport builds each kind, copied from the dispatch in
 * `createShapeObject` so that the same defaults apply -- a disagreement about
 * `shape.sides ?? 4` is exactly the kind of drift this is looking for.
 */
type Candidate = {
  label: string;
  shape: WorkplaneShape;
  mesh: (shape: WorkplaneShape) => THREE.BufferGeometry;
  /** Fraction of the exact volume the tessellated mesh may miss by. */
  volumeTolerance: number;
  /** Millimetres the mesh centroid may sit away from the exact one. */
  centroidTolerance: number;
};

const width = (shape: WorkplaneShape) => shapeWidth(shape);
const depth = (shape: WorkplaneShape) => shapeDepth(shape);

const CANDIDATES: Candidate[] = [
  {
    label: "roof",
    shape: shapeOf({ kind: "roof" }),
    mesh: (shape) => createRoofGeometry(width(shape), shape.height, depth(shape)),
    // A flat-faced prism either way: these should agree to the kernel's noise.
    volumeTolerance: 1e-6,
    centroidTolerance: 1e-6,
  },
  {
    label: "wedge",
    shape: shapeOf({ kind: "wedge" }),
    mesh: (shape) => createWedgeGeometry(width(shape), shape.height, depth(shape)),
    volumeTolerance: 1e-6,
    centroidTolerance: 1e-6,
  },
  {
    label: "pyramid",
    shape: shapeOf({ kind: "pyramid" }),
    mesh: (shape) => createPyramidGeometry(width(shape), shape.height, depth(shape), shape.sides ?? 4),
    volumeTolerance: 1e-6,
    centroidTolerance: 1e-6,
  },
  {
    label: "six-sided pyramid",
    shape: shapeOf({ kind: "pyramid", sides: 6 }),
    mesh: (shape) => createPyramidGeometry(width(shape), shape.height, depth(shape), shape.sides ?? 4),
    // Still flat-faced, but the footprint fit runs through floating point twice.
    volumeTolerance: 1e-4,
    centroidTolerance: 1e-3,
  },
  {
    label: "barrel roof",
    shape: shapeOf({ kind: "roundRoof" }),
    mesh: (shape) => createRoundRoofGeometry(width(shape), shape.height, depth(shape), shape.sides ?? 64),
    // A 64-segment arc inscribed in a true ellipse.
    volumeTolerance: 0.005,
    centroidTolerance: 0.05,
  },
  {
    label: "half sphere",
    shape: shapeOf({ kind: "halfSphere" }),
    mesh: (shape) => createHalfSphereGeometry(width(shape), shape.height, depth(shape), shape.steps ?? 32),
    // 64 longitudes by 16 latitudes against a true ellipsoid.
    volumeTolerance: 0.01,
    centroidTolerance: 0.05,
  },
  {
    label: "torus",
    shape: shapeOf({ kind: "torus" }),
    mesh: (shape) => createTorusGeometry(width(shape), shape.height, depth(shape)),
    volumeTolerance: 0.01,
    centroidTolerance: 0.05,
  },
  {
    label: "tube",
    shape: shapeOf({ kind: "tube" }),
    mesh: (shape) => createHollowCylinderGeometry(width(shape), shape.height, depth(shape), shape.bevel ?? 4, 144),
    volumeTolerance: 0.005,
    centroidTolerance: 0.05,
  },
  {
    label: "ring",
    shape: shapeOf({ kind: "ring" }),
    mesh: (shape) => createHollowCylinderGeometry(width(shape), shape.height, depth(shape), shape.bevel ?? 4, 144),
    volumeTolerance: 0.005,
    centroidTolerance: 0.05,
  },
];

describe("mesh primitives agree with the exact solids", () => {
  for (const candidate of CANDIDATES) {
    it(`a ${candidate.label} is the same solid both ways`, async () => {
      const exact = await withCadKernel((cad) => {
        const query = cad.queryBatch([exactSolidForShape(cad, candidate.shape)])[0];
        return {
          volume: query.volume,
          centroid: [query.centerOfMass.x, query.centerOfMass.y, query.centerOfMass.z] as const,
        };
      });

      const measured = measureMesh(candidate.mesh(candidate.shape));

      // A negative signed volume means the mesh is wound inside out, which the
      // CSG evaluator reads as a hole. Checked before the comparison, because
      // the magnitudes would still match.
      expect(measured.volume, `${candidate.label} mesh winding`).toBeGreaterThan(0);
      expect(exact.volume, `${candidate.label} exact volume`).toBeGreaterThan(0);

      const missing = (exact.volume - measured.volume) / exact.volume;
      expect(
        Math.abs(missing),
        `${candidate.label}: mesh volume ${measured.volume}, exact ${exact.volume}`,
      ).toBeLessThan(candidate.volumeTolerance);
      // And the mesh is the inscribed one, so it may fall short but never
      // overshoot. A builder that drifted to a larger shape entirely would land
      // on the wrong side of this even while its volume stayed in tolerance.
      expect(missing, `${candidate.label} mesh should not exceed the exact solid`).toBeGreaterThan(-1e-6);

      measured.centroid.forEach((value, axis) => {
        expect(
          Math.abs(value - exact.centroid[axis]),
          `${candidate.label} centroid on ${"xyz"[axis]}: mesh ${value}, exact ${exact.centroid[axis]}`,
        ).toBeLessThan(candidate.centroidTolerance);
      });
    });
  }
});
