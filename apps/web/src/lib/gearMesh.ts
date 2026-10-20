/**
 * The gear mesh builder (upstream issue #55).
 *
 * The `three` half of the gear. Every decision about what the numbers mean
 * lives in `gearProfile`, which has no `three` import; this file only turns
 * them into rings and sweeps them into a `BufferGeometry`.
 */

import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  gearToothPitch,
  normalizeGearCenterHoleSize,
  normalizeGearHelixAngle,
  normalizeGearHelixQuality,
  normalizeGearTeeth,
  normalizeGearToothSize,
  normalizeGearToothWidth,
  normalizeGearType,
} from "@/lib/gearProfile";
import type { GearType } from "@/types/sketchforge";

export type GearGeometryOptions = {
  width: number;
  depth: number;
  height: number;
  teeth?: number;
  toothSize?: number;
  toothWidth?: number;
  centerHoleSize?: number;
  gearType?: GearType;
  helixAngle?: number;
  helixQuality?: number;
};

export function createGearGeometry({
  width,
  depth,
  height,
  teeth: requestedTeeth,
  toothSize: requestedToothSize,
  toothWidth: requestedToothWidth,
  centerHoleSize: requestedCenterHoleSize,
  gearType: requestedType,
  helixAngle: requestedHelixAngle,
  helixQuality: requestedHelixQuality,
}: GearGeometryOptions) {
  const safeWidth = Math.max(0.01, width);
  const safeDepth = Math.max(0.01, depth);
  const safeHeight = Math.max(0.01, height);
  const teeth = normalizeGearTeeth(requestedTeeth);
  const toothSize = normalizeGearToothSize(requestedToothSize, safeWidth, safeDepth);
  const toothPitch = gearToothPitch(safeWidth, safeDepth, teeth);
  const toothWidth = normalizeGearToothWidth(requestedToothWidth, safeWidth, safeDepth, teeth);
  const toothFraction = toothWidth / toothPitch;
  const centerHoleSize = normalizeGearCenterHoleSize(requestedCenterHoleSize, safeWidth, safeDepth, toothSize);
  const hasCenterHole = centerHoleSize > 0;
  const gearType = normalizeGearType(requestedType);
  const helixAngle = normalizeGearHelixAngle(requestedHelixAngle);
  const helixQuality = normalizeGearHelixQuality(requestedHelixQuality);
  const outlineCount = teeth * 4;
  const ringCount = gearType === "helical" ? helixQuality : 2;
  const twist = gearType === "helical" ? THREE.MathUtils.degToRad(helixAngle) : 0;
  const topScale = gearType === "bevel" ? 0.68 : 1;
  const outerX = safeWidth / 2;
  const outerZ = safeDepth / 2;
  const rootX = Math.max(outerX * 0.34, outerX - toothSize);
  const rootZ = Math.max(outerZ * 0.34, outerZ - toothSize);
  const boreX = centerHoleSize / 2;
  const boreZ = centerHoleSize / 2;
  const toothPhases = [0.05, (1 - toothFraction) / 2, (1 + toothFraction) / 2, 0.95] as const;
  const positions: number[] = [];
  const indices: number[] = [];

  const outerIndex = (ring: number, point: number) => ring * outlineCount * 2 + point;
  const innerIndex = (ring: number, point: number) => ring * outlineCount * 2 + outlineCount + point;

  for (let ring = 0; ring < ringCount; ring += 1) {
    const progress = ring / (ringCount - 1);
    const y = progress * safeHeight;
    const ringTwist = progress * twist;
    const scale = 1 + (topScale - 1) * progress;

    for (let tooth = 0; tooth < teeth; tooth += 1) {
      for (let phaseIndex = 0; phaseIndex < toothPhases.length; phaseIndex += 1) {
        const phase = toothPhases[phaseIndex];
        const angle = ((tooth + phase) / teeth) * Math.PI * 2 + ringTwist;
        const isOuter = phaseIndex === 1 || phaseIndex === 2;
        const radiusX = (isOuter ? outerX : rootX) * scale;
        const radiusZ = (isOuter ? outerZ : rootZ) * scale;
        positions.push(Math.cos(angle) * radiusX, y, Math.sin(angle) * radiusZ);
      }
    }

    for (let point = 0; point < outlineCount; point += 1) {
      const angle = (point / outlineCount) * Math.PI * 2;
      positions.push(Math.cos(angle) * boreX, y, Math.sin(angle) * boreZ);
    }
  }

  let outlineMinX = Number.POSITIVE_INFINITY;
  let outlineMaxX = Number.NEGATIVE_INFINITY;
  let outlineMinZ = Number.POSITIVE_INFINITY;
  let outlineMaxZ = Number.NEGATIVE_INFINITY;
  for (let ring = 0; ring < ringCount; ring += 1) {
    for (let point = 0; point < outlineCount; point += 1) {
      const offset = outerIndex(ring, point) * 3;
      outlineMinX = Math.min(outlineMinX, positions[offset]);
      outlineMaxX = Math.max(outlineMaxX, positions[offset]);
      outlineMinZ = Math.min(outlineMinZ, positions[offset + 2]);
      outlineMaxZ = Math.max(outlineMaxZ, positions[offset + 2]);
    }
  }
  const outlineScaleX = safeWidth / Math.max(Number.EPSILON, outlineMaxX - outlineMinX);
  const outlineScaleZ = safeDepth / Math.max(Number.EPSILON, outlineMaxZ - outlineMinZ);
  for (let ring = 0; ring < ringCount; ring += 1) {
    for (let point = 0; point < outlineCount; point += 1) {
      const offset = outerIndex(ring, point) * 3;
      positions[offset] *= outlineScaleX;
      positions[offset + 2] *= outlineScaleZ;
    }
  }

  for (let ring = 0; ring < ringCount - 1; ring += 1) {
    for (let point = 0; point < outlineCount; point += 1) {
      const next = (point + 1) % outlineCount;
      const outerBottom = outerIndex(ring, point);
      const outerNextBottom = outerIndex(ring, next);
      const outerTop = outerIndex(ring + 1, point);
      const outerNextTop = outerIndex(ring + 1, next);
      indices.push(outerBottom, outerTop, outerNextTop, outerBottom, outerNextTop, outerNextBottom);

      if (hasCenterHole) {
        const innerBottom = innerIndex(ring, point);
        const innerNextBottom = innerIndex(ring, next);
        const innerTop = innerIndex(ring + 1, point);
        const innerNextTop = innerIndex(ring + 1, next);
        indices.push(innerBottom, innerNextBottom, innerNextTop, innerBottom, innerNextTop, innerTop);
      }
    }
  }

  const topRing = ringCount - 1;
  for (let point = 0; point < outlineCount; point += 1) {
    const next = (point + 1) % outlineCount;
    const bottomOuter = outerIndex(0, point);
    const bottomOuterNext = outerIndex(0, next);
    const bottomInner = innerIndex(0, point);
    const bottomInnerNext = innerIndex(0, next);
    if (hasCenterHole) {
      indices.push(bottomOuter, bottomOuterNext, bottomInnerNext, bottomOuter, bottomInnerNext, bottomInner);
    } else {
      indices.push(bottomOuter, bottomOuterNext, innerIndex(0, 0));
    }

    const topOuter = outerIndex(topRing, point);
    const topOuterNext = outerIndex(topRing, next);
    const topInner = innerIndex(topRing, point);
    const topInnerNext = innerIndex(topRing, next);
    if (hasCenterHole) {
      indices.push(topOuter, topInner, topInnerNext, topOuter, topInnerNext, topOuterNext);
    } else {
      indices.push(topOuter, innerIndex(topRing, 0), topOuterNext);
    }
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const geometry = toCreasedNormals(indexed, THREE.MathUtils.degToRad(12));
  indexed.dispose();
  geometry.computeBoundingBox();
  return geometry;
}
