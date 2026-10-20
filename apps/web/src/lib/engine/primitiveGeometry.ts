import * as THREE from "three";
import { regularPolygonFootprintScale } from "@/lib/engine/regularPolygonFootprint";

/**
 * The mesh primitives the editor draws, in one place.
 *
 * These seven builders used to exist twice, verbatim: once in
 * `WorkplaneViewport.tsx` for the thing on screen, and once in
 * `SketchForgeEditor.tsx` under `createBoolean*` names for the operands handed
 * to a mesh CSG. The copies had already drifted -- the half-sphere shaded
 * differently in the two paths -- and nothing could have noticed, because the
 * test harness cannot import JSX and so could not reach either copy. Living in
 * a `.ts` module is the whole point: `tests/unit/primitiveGeometry.test.ts` and
 * `tests/e2e/primitiveGeometryAgreement.e2e.ts` are the first tests in this
 * repository that can see a primitive builder at all.
 *
 * The two differences between the old copies survive as options rather than
 * being decided here, so that consolidating them changed no behaviour. Which of
 * the two half-sphere normal strategies is right is a real question and a
 * separate one.
 */
export type PrimitiveGeometryOptions = {
  /**
   * Keep the index buffer.
   *
   * The viewport flattens every indexed primitive with `.toNonIndexed()`; the
   * boolean path kept the index, because its mesh conversion flattens later and
   * on its own terms. `false` is the default so the viewport's call sites read
   * as they did.
   *
   * No effect on `createHollowCylinderGeometry` or `createHalfSphereGeometry`,
   * which build raw triangle soup and have no index either way.
   */
  indexed?: boolean;
  /**
   * How a half-sphere gets its normals.
   *
   * `"analytic"` is the viewport's: an ellipsoid normal per dome vertex and a
   * flat `(0, -1, 0)` across the bottom cap. `"computed"` is the boolean path's
   * `computeVertexNormals()`, which averages the face normals and so rounds the
   * hard rim between the dome and its cap.
   *
   * Defaults to `"analytic"`, the viewport's behaviour.
   */
  halfSphereNormals?: "analytic" | "computed";
};

type Vec3 = [number, number, number];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Flatten unless the caller wants the index buffer, which is the viewport's default. */
function finish(geometry: THREE.BufferGeometry, options?: PrimitiveGeometryOptions) {
  return options?.indexed ? geometry : geometry.toNonIndexed();
}

/**
 * Sit a geometry on the workplane: base at `y = 0`, with normals and bounds
 * current.
 *
 * Note that this recomputes vertex normals, so a builder's own normals do not
 * survive it -- see `createHalfSphereGeometry`.
 */
export function putGeometryOnBase(geometry: THREE.BufferGeometry) {
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const minY = geometry.boundingBox?.min.y ?? 0;
  geometry.translate(0, -minY, 0);
  return geometry;
}

/** A gable roof: a triangular prism with its ridge over the middle. */
export function createRoofGeometry(width: number, height: number, depth: number, options?: PrimitiveGeometryOptions) {
  const w = width / 2;
  const d = depth / 2;
  const vertices = new Float32Array([
    -w, 0, -d, w, 0, -d, 0, height, -d,
    -w, 0, d, w, 0, d, 0, height, d,
  ]);
  const indices = [
    0, 2, 1,
    3, 4, 5,
    0, 1, 4, 0, 4, 3,
    0, 3, 5, 0, 5, 2,
    1, 2, 5, 1, 5, 4,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  return finish(geometry, options);
}

/** A wedge: the same prism with its ridge over one side, so one face is vertical. */
export function createWedgeGeometry(width: number, height: number, depth: number, options?: PrimitiveGeometryOptions) {
  const w = width / 2;
  const d = depth / 2;
  const vertices = new Float32Array([
    -w, 0, -d, w, 0, -d, w, height, -d,
    -w, 0, d, w, 0, d, w, height, d,
  ]);
  const indices = [
    0, 2, 1,
    3, 4, 5,
    0, 1, 4, 0, 4, 3,
    1, 2, 5, 1, 5, 4,
    0, 3, 5, 0, 5, 2,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  return finish(geometry, options);
}

/**
 * A pyramid.
 *
 * Four sides is a rectangle to an apex, built outright. Any other count is a
 * cone of that many sides, fitted to width and depth by the same footprint
 * scale the exact builder uses.
 */
export function createPyramidGeometry(width: number, height: number, depth: number, sides = 4, options?: PrimitiveGeometryOptions) {
  const count = Math.max(3, Math.round(sides));
  if (count !== 4) {
    const footprintScale = regularPolygonFootprintScale(width, depth, count);
    const geometry = new THREE.ConeGeometry(1, height, count);
    geometry.scale(footprintScale.x, 1, footprintScale.z);
    geometry.translate(footprintScale.offsetX, height / 2, footprintScale.offsetZ);
    return finish(geometry, options);
  }

  const w = width / 2;
  const d = depth / 2;
  const vertices = new Float32Array([
    -w, 0, -d, w, 0, -d, w, 0, d, -w, 0, d,
    0, height, 0,
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    0, 4, 1,
    1, 4, 2,
    2, 4, 3,
    3, 4, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  return finish(geometry, options);
}

/**
 * A torus lying flat.
 *
 * Its tube radius comes from the height and its major radius from the smaller
 * of width and depth; it is then stretched so the outer diameter matches width
 * and depth separately. Unlike the other kinds here it comes back centred on
 * `y = 0` rather than sitting on it.
 */
export function createTorusGeometry(width: number, height: number, depth: number, options?: PrimitiveGeometryOptions) {
  const tubeRadius = Math.max(0.1, height / 2);
  const majorRadius = Math.max(0.2, Math.min(width, depth) / 2 - tubeRadius);
  const geometry = new THREE.TorusGeometry(majorRadius, tubeRadius, 36, 144);
  geometry.rotateX(Math.PI / 2);
  // Those two floors put the outer diameter at 0.6 at the very least, so the
  // guard never fires; it is kept because one of the two copies this replaces
  // had it and dropping it would be a change, however unreachable.
  const outerDiameter = (majorRadius + tubeRadius) * 2;
  geometry.scale(width / Math.max(0.001, outerDiameter), 1, depth / Math.max(0.001, outerDiameter));
  return finish(geometry, options);
}

/**
 * A tube or ring: an elliptical wall of a given thickness, open at both ends.
 *
 * Built as triangle soup, so `indexed` does not apply.
 */
export function createHollowCylinderGeometry(width: number, height: number, depth: number, thickness: number, segments = 96) {
  const outerX = width / 2;
  const outerZ = depth / 2;
  const safeThickness = clamp(thickness, 0.1, Math.max(0.1, Math.min(outerX, outerZ) - 0.1));
  const innerX = Math.max(0.1, outerX - safeThickness);
  const innerZ = Math.max(0.1, outerZ - safeThickness);
  const count = Math.max(12, Math.round(segments));
  const positions: number[] = [];
  const point = (rx: number, rz: number, y: number, index: number): Vec3 => {
    const angle = (index / count) * Math.PI * 2;
    return [Math.cos(angle) * rx, y, Math.sin(angle) * rz];
  };
  const addTri = (a: Vec3, b: Vec3, c: Vec3) => positions.push(...a, ...b, ...c);
  const addQuad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    addTri(a, b, c);
    addTri(a, c, d);
  };

  for (let index = 0; index < count; index += 1) {
    const next = index + 1;
    const ob0 = point(outerX, outerZ, 0, index);
    const ob1 = point(outerX, outerZ, 0, next);
    const ot0 = point(outerX, outerZ, height, index);
    const ot1 = point(outerX, outerZ, height, next);
    const ib0 = point(innerX, innerZ, 0, index);
    const ib1 = point(innerX, innerZ, 0, next);
    const it0 = point(innerX, innerZ, height, index);
    const it1 = point(innerX, innerZ, height, next);

    addQuad(ob0, ot0, ot1, ob1);
    addQuad(ib1, it1, it0, ib0);
    addQuad(ot0, it0, it1, ot1);
    addQuad(ob0, ob1, ib1, ib0);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

/** A barrel roof: a half disc extruded along depth, then scaled in Y to the height. */
export function createRoundRoofGeometry(width: number, height: number, depth: number, sides = 64, options?: PrimitiveGeometryOptions) {
  const radius = width / 2;
  const segments = Math.max(4, Math.round(sides));
  const shape = new THREE.Shape();
  shape.moveTo(-radius, 0);
  shape.absarc(0, 0, radius, Math.PI, 0, true);
  shape.lineTo(-radius, 0);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: segments });
  geometry.translate(0, 0, -depth / 2);
  geometry.scale(1, height / Math.max(0.001, radius), 1);
  return finish(geometry, options);
}

/**
 * A dome: the upper half of an ellipsoid of the full height, with a flat cap.
 *
 * Built as triangle soup, so `indexed` does not apply. `halfSphereNormals`
 * chooses between the two strategies the copies had.
 */
export function createHalfSphereGeometry(width: number, height: number, depth: number, steps = 32, options?: PrimitiveGeometryOptions) {
  const analytic = (options?.halfSphereNormals ?? "analytic") === "analytic";
  const lon = Math.max(8, Math.round(steps) * 2);
  const lat = Math.max(4, Math.round(steps / 2));
  const rx = width / 2;
  const rz = depth / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const point = (latIndex: number, lonIndex: number): Vec3 => {
    const theta = (latIndex / lat) * (Math.PI / 2);
    const phi = ((lonIndex % lon) / lon) * Math.PI * 2;
    const ring = Math.sin(theta);
    return [Math.cos(phi) * rx * ring, Math.cos(theta) * height, Math.sin(phi) * rz * ring];
  };
  const normal = ([x, y, z]: Vec3): Vec3 => {
    const vector = new THREE.Vector3(x / Math.max(0.001, rx * rx), y / Math.max(0.001, height * height), z / Math.max(0.001, rz * rz)).normalize();
    return [vector.x, vector.y, vector.z];
  };
  const addTri = (a: Vec3, b: Vec3, c: Vec3) => {
    positions.push(...a, ...b, ...c);
    if (analytic) normals.push(...normal(a), ...normal(b), ...normal(c));
  };
  const addCapTri = (a: Vec3, b: Vec3, c: Vec3) => {
    positions.push(...a, ...b, ...c);
    if (analytic) normals.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
  };

  const top: Vec3 = [0, height, 0];
  for (let xStep = 0; xStep < lon; xStep += 1) {
    addTri(top, point(1, xStep + 1), point(1, xStep));
  }

  for (let yStep = 1; yStep < lat; yStep += 1) {
    for (let xStep = 0; xStep < lon; xStep += 1) {
      const next = xStep + 1;
      const a = point(yStep, xStep);
      const b = point(yStep, next);
      const c = point(yStep + 1, next);
      const d = point(yStep + 1, xStep);
      addTri(a, c, d);
      addTri(a, b, c);
    }
  }

  const capY = 0;
  const bottomCenter: Vec3 = [0, capY, 0];
  const capPoint = (lonIndex: number): Vec3 => {
    const phi = ((lonIndex % lon) / lon) * Math.PI * 2;
    return [Math.cos(phi) * rx, capY, Math.sin(phi) * rz];
  };
  for (let xStep = 0; xStep < lon; xStep += 1) {
    addCapTri(bottomCenter, capPoint(xStep), capPoint(xStep + 1));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (analytic) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  return geometry;
}
