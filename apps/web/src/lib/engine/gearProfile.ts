/**
 * Gear profile maths and normalizers (upstream issue #55).
 *
 * The pure half of the gear: tooth count, tooth size and pitch, bore limits,
 * helix angle and quality, settled from whatever a stored shape happens to
 * carry. Nothing here imports `three`, so a kernel-side caller can take these
 * answers -- they have to match the mesh, or an exact gear and a displayed one
 * disagree -- without taking the mesher.
 *
 * The mesh builder lives in `gearMesh`; `gearGeometry` re-exports both halves.
 */

import type { GearType, WorkplaneShape } from "@/types/sketchforge";

export const DEFAULT_GEAR_TEETH = 12;
export const DEFAULT_GEAR_TOOTH_SIZE = 2.5;
export const DEFAULT_GEAR_CENTER_HOLE_SIZE = 6;
export const DEFAULT_GEAR_TYPE: GearType = "spur";
export const DEFAULT_GEAR_HELIX_ANGLE = 22.5;
export const DEFAULT_GEAR_HELIX_QUALITY = 16;
export const MIN_GEAR_TEETH = 6;
export const MAX_GEAR_TEETH = 64;
export const MIN_GEAR_HELIX_ANGLE = -45;
export const MAX_GEAR_HELIX_ANGLE = 45;
export const MIN_GEAR_HELIX_QUALITY = 4;
export const MAX_GEAR_HELIX_QUALITY = 32;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeGearTeeth(value?: number) {
  return clamp(Math.round(Number.isFinite(value) ? value as number : DEFAULT_GEAR_TEETH), MIN_GEAR_TEETH, MAX_GEAR_TEETH);
}

export function normalizeGearType(value?: string): GearType {
  return value === "helical" || value === "bevel" ? value : DEFAULT_GEAR_TYPE;
}

export function normalizeGearToothSize(value: number | undefined, width: number, depth: number) {
  const maximum = Math.max(0.2, Math.min(width, depth) * 0.22);
  return clamp(Number.isFinite(value) ? value as number : DEFAULT_GEAR_TOOTH_SIZE, 0.2, maximum);
}

export function gearToothPitch(width: number, depth: number, teeth?: number) {
  return Math.PI * Math.max(0.01, Math.min(width, depth)) / normalizeGearTeeth(teeth);
}

export function normalizeGearToothWidth(value: number | undefined, width: number, depth: number, teeth?: number) {
  const pitch = gearToothPitch(width, depth, teeth);
  return clamp(Number.isFinite(value) ? value as number : pitch * 0.54, pitch * 0.12, pitch * 0.82);
}

export function gearCenterHoleLimits(width: number, depth: number, toothSize?: number) {
  const outerRadius = Math.max(0.005, Math.min(width, depth) / 2);
  const normalizedToothSize = normalizeGearToothSize(toothSize, width, depth);
  const rootRadius = Math.max(outerRadius * 0.34, outerRadius - normalizedToothSize);
  const max = Math.max(0.01, rootRadius * 1.5);
  return { min: 0, max };
}

export function normalizeGearCenterHoleSize(value: number | undefined, width: number, depth: number, toothSize?: number) {
  const limits = gearCenterHoleLimits(width, depth, toothSize);
  const outerRadius = Math.max(0.005, Math.min(width, depth) / 2);
  const normalizedToothSize = normalizeGearToothSize(toothSize, width, depth);
  const rootRadius = Math.max(outerRadius * 0.34, outerRadius - normalizedToothSize);
  const defaultSize = Math.min(outerRadius * 0.4, rootRadius * 1.1);
  return clamp(Number.isFinite(value) ? value as number : defaultSize, limits.min, limits.max);
}

export function normalizeGearHelixAngle(value?: number) {
  return clamp(
    Number.isFinite(value) ? value as number : DEFAULT_GEAR_HELIX_ANGLE,
    MIN_GEAR_HELIX_ANGLE,
    MAX_GEAR_HELIX_ANGLE,
  );
}

export function normalizeGearHelixQuality(value?: number) {
  return clamp(
    Math.round(Number.isFinite(value) ? value as number : DEFAULT_GEAR_HELIX_QUALITY),
    MIN_GEAR_HELIX_QUALITY,
    MAX_GEAR_HELIX_QUALITY,
  );
}

export function gearSettings(shape: Pick<WorkplaneShape, "width" | "depth" | "teeth" | "toothSize" | "toothWidth" | "centerHoleSize" | "gearType" | "helixAngle" | "helixQuality">) {
  return {
    teeth: normalizeGearTeeth(shape.teeth),
    toothSize: normalizeGearToothSize(shape.toothSize, shape.width, shape.depth),
    toothWidth: normalizeGearToothWidth(shape.toothWidth, shape.width, shape.depth, shape.teeth),
    centerHoleSize: normalizeGearCenterHoleSize(shape.centerHoleSize, shape.width, shape.depth, shape.toothSize),
    gearType: normalizeGearType(shape.gearType),
    helixAngle: normalizeGearHelixAngle(shape.helixAngle),
    helixQuality: normalizeGearHelixQuality(shape.helixQuality),
  };
}
