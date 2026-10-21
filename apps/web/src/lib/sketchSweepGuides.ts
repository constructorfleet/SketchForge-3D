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
