import type { SketchOperation } from "@/types/sketchforge";
import { orderedCadSketchPaths } from "@/lib/sketchCadProfile";
import type { SketchProfile, SketchSweepFrame } from "@/types/sketchforge";
import { deriveSketchSweepFrames } from "@constructorfleet/sketchforge-engine/sketchSweepFrames";

type GuidePath = {
  closed: boolean;
  points: readonly { id: string }[];
  steps: readonly { segment: { id: string } }[];
};

export type SketchSweepGuideRole = "section" | "spine";
export type SketchSweepStage = "section" | "spine";

export type SketchSweepFrames = { section: SketchSweepFrame; spine: SketchSweepFrame };

export type SketchSweepStatus = {
  hasSection: boolean;
  hasSpine: boolean;
  sectionCount: number;
  spineCount: number;
  ready: boolean;
};

const SWEEP_ORIGIN_TOLERANCE = 1e-6;

export function sketchToolForSweepStage(stage: SketchSweepStage): "select" | "line" {
  return stage === "section" ? "select" : "line";
}

export function projectSweepSectionPoint<T extends {
  x: number;
  z: number;
  handleIn?: { x: number; z: number };
  handleOut?: { x: number; z: number };
}>(point: T): T {
  return {
    ...point,
    x: 0,
    z: point.x,
    ...(point.handleIn ? { handleIn: { x: 0, z: point.handleIn.x } } : {}),
    ...(point.handleOut ? { handleOut: { x: 0, z: point.handleOut.x } } : {}),
  };
}

export function sketchSweepStage(paths: readonly GuidePath[], operation: SketchOperation): SketchSweepStage | null {
  if (operation !== "sweep") return null;
  return paths.some((path) => path.closed) ? "spine" : "section";
}

export function sweepFramesForSectionWorkplane(section: SketchSweepFrame): SketchSweepFrames {
  return deriveSketchSweepFrames(section);
}

export function formatSweepAxis(axis: SketchSweepFrame["xAxis"]): string {
  const rounded = [axis.x, axis.y, axis.z].map((coordinate) => {
    const value = Math.abs(coordinate) < 0.005 ? 0 : Number(coordinate.toFixed(2));
    return value.toFixed(2);
  });
  return `(${rounded.join(", ")})`;
}

export function tagSweepProfile(profile: SketchProfile, frames: SketchSweepFrames): SketchProfile {
  const pointRoles = new Map<string, SketchSweepGuideRole>();
  for (const path of orderedCadSketchPaths(profile)) {
    const role = path.closed ? "section" : "spine";
    path.points.forEach((point) => pointRoles.set(point.id, role));
  }
  return {
    ...profile,
    points: profile.points.map((point) => ({
      ...point,
      sweepRole: point.sweepRole ?? pointRoles.get(point.id) ?? "section",
    })),
    sweepFrames: profile.sweepFrames ?? frames,
  };
}

export function snapInitialSweepSpineEndpoint(
  profile: SketchProfile,
  startPointId: string | null,
  endpoint: { x: number; z: number },
): { x: number; z: number } {
  const spinePoints = profile.points.filter((point) => point.sweepRole === "spine");
  if (spinePoints.length === 0 && !startPointId) return { x: 0, z: 0 };
  if (!startPointId) return endpoint;
  const pointsById = new Map(profile.points.map((point) => [point.id, point]));
  const start = pointsById.get(startPointId);
  if (start?.sweepRole !== "spine") return endpoint;
  const spineSegments = profile.segments.filter((segment) =>
    pointsById.get(segment.startId)?.sweepRole === "spine" && pointsById.get(segment.endId)?.sweepRole === "spine",
  );
  if (spinePoints.length !== 1 || spineSegments.length !== 0) return endpoint;
  return { x: endpoint.x, z: start.z };
}

/** Progress through the two stages, and whether the profile can be swept. */
export function sweepProfileStatus(paths: readonly GuidePath[]): SketchSweepStatus {
  const sections = paths.filter((path) => path.closed);
  const spines = paths.filter((path) => !path.closed && path.steps.length > 0);
  return {
    hasSection: sections.length > 0,
    hasSpine: spines.length > 0,
    sectionCount: sections.length,
    spineCount: spines.length,
    ready: sections.length > 0 && spines.length === 1,
  };
}

/**
 * The spine point the sweep starts from. The builder starts a sweep at the
 * section origin, so prefer the spine point there over whatever end the path
 * ordering happened to choose.
 */
export function sweepSpineStartPointId(profile: SketchProfile): string | null {
  const spinePoints = profile.points.filter((point) => point.sweepRole === "spine");
  if (spinePoints.length === 0) return null;
  const atOrigin = spinePoints.find((point) => Math.hypot(point.x, point.z) < SWEEP_ORIGIN_TOLERANCE);
  return (atOrigin ?? spinePoints[0]!).id;
}

/**
 * Adds the start point at the section origin when a sweep has a section but no
 * spine yet, so the start is explicit instead of appearing where the first
 * click happens to land. An existing spine, even a legacy one, is left alone.
 */
export function withSweepSpineStart(
  profile: SketchProfile,
  id: string,
): { profile: SketchProfile; pointId: string | null; created: boolean } {
  const existing = sweepSpineStartPointId(profile);
  if (existing) return { profile, pointId: existing, created: false };
  return {
    profile: {
      ...profile,
      points: [...profile.points, { id, x: 0, z: 0, sweepRole: "spine", mode: "corner" }],
    },
    pointId: id,
    created: true,
  };
}

/** Centre of the section's bounds, which is where the sweep starts. */
export function sweepSectionOffset(profile: SketchProfile): { x: number; z: number } | null {
  const sectionPoints = profile.points.filter((point) => point.sweepRole === "section");
  if (sectionPoints.length === 0) return null;
  const xs = sectionPoints.map((point) => point.x);
  const zs = sectionPoints.map((point) => point.z);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };
}

/** Moves the section, and any fixed constraints on it, onto the sweep origin. */
export function centerSweepSection(profile: SketchProfile): SketchProfile {
  const offset = sweepSectionOffset(profile);
  if (!offset || (Math.abs(offset.x) < SWEEP_ORIGIN_TOLERANCE && Math.abs(offset.z) < SWEEP_ORIGIN_TOLERANCE)) {
    return profile;
  }
  const sectionIds = new Set(profile.points.filter((point) => point.sweepRole === "section").map((point) => point.id));
  return {
    ...profile,
    points: profile.points.map((point) => {
      if (!sectionIds.has(point.id)) return point;
      return {
        ...point,
        x: point.x - offset.x,
        z: point.z - offset.z,
        ...(point.handleIn ? { handleIn: { ...point.handleIn, x: point.handleIn.x - offset.x, z: point.handleIn.z - offset.z } } : {}),
        ...(point.handleOut ? { handleOut: { ...point.handleOut, x: point.handleOut.x - offset.x, z: point.handleOut.z - offset.z } } : {}),
      };
    }),
    ...(profile.constraints ? {
      constraints: profile.constraints.map((constraint) => constraint.kind === "fixed" && sectionIds.has(constraint.pointId)
        ? { ...constraint, xMm: constraint.xMm - offset.x, zMm: constraint.zMm - offset.z }
        : constraint),
    } : {}),
  };
}

export function sketchSweepGuideRoles(paths: readonly GuidePath[], operation: SketchOperation) {
  const pointRoles = new Map<string, SketchSweepGuideRole>();
  const segmentRoles = new Map<string, SketchSweepGuideRole>();
  if (operation !== "sweep" || !paths.some((path) => path.closed)) {
    return { pointRoles, segmentRoles };
  }

  for (const path of paths) {
    const role: SketchSweepGuideRole = path.closed ? "section" : "spine";
    path.points.forEach((point) => pointRoles.set(point.id, role));
    path.steps.forEach(({ segment }) => segmentRoles.set(segment.id, role));
  }
  return { pointRoles, segmentRoles };
}
