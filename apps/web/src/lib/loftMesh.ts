/**
 * The loft mesh builder (upstream issue #55).
 *
 * The `three` half of the loft. Everything about *where* a ring vertex sits
 * lives in `loftProfile`, which has no `three` import; this file only sweeps
 * those rings into a `BufferGeometry`, so a kernel-side caller can take the
 * profile maths without taking the mesher.
 */

import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  buildAngles,
  DEFAULT_LOFT_BOTTOM_SHAPE,
  DEFAULT_LOFT_TOP_SHAPE,
  normalizeLoftLayers,
  normalizeLoftRotation,
  normalizeLoftSegments,
  normalizeLoftShape,
  normalizeLoftTopSize,
  shapeCorners,
  shapePoint,
  smootherstep,
} from "@/lib/engine/loftProfile";
import type { LoftProfileShape } from "@/types/sketchforge";

export type LoftGeometryOptions = {
  width: number;
  depth: number;
  height: number;
  bottomShape?: LoftProfileShape;
  topShape?: LoftProfileShape;
  topWidth?: number;
  topDepth?: number;
  bottomRotation?: number;
  topRotation?: number;
  segments?: number;
  layers?: number;
};

export function createLoftGeometry({
  width,
  depth,
  height,
  bottomShape: requestedBottomShape,
  topShape: requestedTopShape,
  topWidth: requestedTopWidth,
  topDepth: requestedTopDepth,
  bottomRotation: requestedBottomRotation,
  topRotation: requestedTopRotation,
  segments: requestedSegments,
  layers: requestedLayers,
}: LoftGeometryOptions): THREE.BufferGeometry {
  const safeWidth = Math.max(0.01, width);
  const safeDepth = Math.max(0.01, depth);
  const safeHeight = Math.max(0.01, height);
  const bottomShape = normalizeLoftShape(requestedBottomShape, DEFAULT_LOFT_BOTTOM_SHAPE);
  const topShape = normalizeLoftShape(requestedTopShape, DEFAULT_LOFT_TOP_SHAPE);
  const bottomRotation = THREE.MathUtils.degToRad(normalizeLoftRotation(requestedBottomRotation));
  const topRotation = THREE.MathUtils.degToRad(normalizeLoftRotation(requestedTopRotation));
  const segments = normalizeLoftSegments(requestedSegments);
  const layers = normalizeLoftLayers(requestedLayers);

  const bX = Math.max(0.001, safeWidth / 2);
  const bY = Math.max(0.001, safeDepth / 2);
  const tX = Math.max(0.001, normalizeLoftTopSize(requestedTopWidth, safeWidth) / 2);
  const tY = Math.max(0.001, normalizeLoftTopSize(requestedTopDepth, safeDepth) / 2);

  const bottomCorners = shapeCorners(bottomShape, bX, bY, bottomRotation);
  const topCorners = shapeCorners(topShape, tX, tY, topRotation);
  const angles = buildAngles(bottomCorners, topCorners, segments, bottomRotation, topRotation);
  const segmentCount = angles.length;

  const positions: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };

  const ringAt = (u: number) => {
    const blend = smootherstep(u);
    const y = safeHeight * u;
    const ring: number[] = [];
    for (const angle of angles) {
      const [bx, bz] = shapePoint(bottomShape, angle.aBottom, bX, bY, bottomRotation);
      const [tx, tz] = shapePoint(topShape, angle.aTop, tX, tY, topRotation);
      ring.push(push(bx * (1 - blend) + tx * blend, y, bz * (1 - blend) + tz * blend));
    }
    return ring;
  };

  const grid: number[][] = [];
  for (let layer = 0; layer <= layers; layer += 1) grid.push(ringAt(layer / layers));

  for (let layer = 0; layer < layers; layer += 1) {
    for (let i = 0; i < segmentCount; i += 1) {
      const j = (i + 1) % segmentCount;
      const a = grid[layer][i];
      const b = grid[layer][j];
      const c = grid[layer + 1][j];
      const d = grid[layer + 1][i];
      indices.push(a, d, b, b, d, c);
    }
  }

  const bottomRing = ringAt(0);
  const bottomCenter = push(0, 0, 0);
  for (let i = 0; i < segmentCount; i += 1) {
    const j = (i + 1) % segmentCount;
    indices.push(bottomCenter, bottomRing[i], bottomRing[j]);
  }

  const topRing = ringAt(1);
  const topCenter = push(0, safeHeight, 0);
  for (let i = 0; i < segmentCount; i += 1) {
    const j = (i + 1) % segmentCount;
    indices.push(topCenter, topRing[j], topRing[i]);
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const geometry = toCreasedNormals(indexed, THREE.MathUtils.degToRad(15));
  indexed.dispose();
  geometry.computeBoundingBox();
  return geometry;
}
