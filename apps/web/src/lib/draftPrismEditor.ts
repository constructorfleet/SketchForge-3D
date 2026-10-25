import { draftPrismLoop } from "@constructorfleet/sketchforge-engine/sketchCadProfile";
import type { SketchProfile, WorkplaneShape } from "@/types/sketchforge";

export type DraftPrismControlState = {
  available: boolean;
  disabledReason: "not-sketch-extrusion" | "unsupported-profile" | null;
};

/** The same test the draft itself applies, so the card is offered exactly when the draft can be built (#349). */
function hasSupportedProfile(profile: SketchProfile | undefined) {
  return Boolean(profile) && typeof draftPrismLoop(profile!) !== "string";
}

/** Describes whether the selected sketch shape can use the bounded draft control. */
export function draftPrismControlForShape(shape: WorkplaneShape): DraftPrismControlState {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile) {
    return { available: false, disabledReason: "not-sketch-extrusion" };
  }
  return hasSupportedProfile(shape.sketchProfile)
    ? { available: true, disabledReason: null }
    : { available: false, disabledReason: "unsupported-profile" };
}

export function isDraftPrismAngle(angle: number) {
  return Number.isFinite(angle) && angle !== 0 && Math.abs(angle) < 45;
}

/** Values submitted by the editor for a supported, valid draft operation. */
export function draftPrismRequestForShape(shape: WorkplaneShape, angle: number) {
  if (!draftPrismControlForShape(shape).available || !isDraftPrismAngle(angle)) return null;
  return { profile: shape.sketchProfile as SketchProfile, height: shape.height, angle };
}
