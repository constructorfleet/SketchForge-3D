/**
 * The loft, both halves, plus its one display label.
 *
 * This file used to hold the profile maths and the mesh builder together, which
 * meant anything wanting a normalizer -- `serverCadSolids` builds a loft as an
 * exact solid and needs the same answers -- also took `three` and the `@/i18n`
 * type import below. The maths now lives in `loftProfile` (no `three`) and the
 * builder in `loftMesh`; this is the editor-facing barrel, so no call site had
 * to move. Kernel-side callers should import `@/lib/loftProfile` directly, and
 * must not import this file: `@/i18n` re-exports `useTranslations` and so pulls
 * React.
 */

import type { MessageKey, Translator } from "@/i18n";
import type { LoftProfileShape } from "@/types/sketchforge";

export * from "@/lib/loftProfile";
export * from "@/lib/loftMesh";

/** Display text for a loft cross-section, keyed on the value saved in projects. */
const LOFT_PROFILE_SHAPE_KEYS: Record<LoftProfileShape, MessageKey> = {
  Oval: "panels.loftShape.oval",
  Rectangle: "panels.loftShape.rectangle",
  Triangle: "panels.loftShape.triangle",
  Pentagon: "panels.loftShape.pentagon",
  Hexagon: "panels.loftShape.hexagon",
};

export function loftProfileShapeLabel(t: Translator, option: string): string {
  const key = LOFT_PROFILE_SHAPE_KEYS[option as LoftProfileShape];
  return key ? t(key) : option;
}
