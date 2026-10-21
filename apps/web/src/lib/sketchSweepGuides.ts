import type { SketchOperation } from "@/types/sketchforge";

type GuidePath = {
  closed: boolean;
  points: readonly { id: string }[];
  steps: readonly { segment: { id: string } }[];
};

export type SketchSweepGuideRole = "section" | "spine";

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
