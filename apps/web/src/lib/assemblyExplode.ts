import type { MessageKey } from "@/i18n/locales";
import type { StepExplodeRefusal } from "@/lib/engine/stepAssemblyExplode";
import type { ProjectAsset, WorkplaneShape } from "@/types/sketchforge";

/** Whether the shape inspector should offer "Explode assembly" for this shape. */
export function canExplodeStepAssembly(shape: WorkplaneShape) {
  return shape.importedMesh?.sourceFormat === "step"
    && Boolean(shape.importedMesh.assetId)
    && Boolean(shape.stepAssembly?.length);
}

export type AssemblyExplodeResult =
  | {
      ok: true;
      /** The whole scene with the assembly replaced, in place, by `parts`. */
      shapes: WorkplaneShape[];
      parts: WorkplaneShape[];
      /** `flat` when the product tree could not be matched, and the parts are loose solids. */
      hierarchy: "nested" | "flat";
    }
  | { ok: false; messageKey: MessageKey; params?: Record<string, number> };

const REFUSAL_MESSAGES: Record<StepExplodeRefusal, MessageKey> = {
  not_step: "editor.explode.notStep",
  source_too_large: "editor.explode.sourceTooLarge",
  single_solid: "editor.explode.singleSolid",
  too_many_solids: "editor.explode.tooManySolids",
};

/**
 * Explode one imported STEP assembly in the editor's scene.
 *
 * Runs on the browser kernel STEP import already loaded, and answers with the
 * complete next scene so the caller can commit it as one history entry.
 */
export async function explodeAssemblyInScene(
  shapes: readonly WorkplaneShape[],
  shapeId: string,
  assets: readonly ProjectAsset[],
): Promise<AssemblyExplodeResult> {
  const index = shapes.findIndex((shape) => shape.id === shapeId);
  const shape = shapes[index];
  if (!shape) return { ok: false, messageKey: "editor.explode.selectOne" };
  if (shape.locked) return { ok: false, messageKey: "editor.explode.unlock" };
  const assetId = shape.importedMesh?.assetId;
  const source = assetId ? assets.find((asset) => asset.id === assetId) : undefined;
  if (!source) return { ok: false, messageKey: "editor.explode.sourceMissing" };

  const { explodeStepAssemblyInBrowser, StepExplodeError } = await import("@/lib/engine/stepAssemblyExplode");
  try {
    const exploded = await explodeStepAssemblyInBrowser(shape, source);
    return {
      ok: true,
      shapes: [...shapes.slice(0, index), ...exploded.shapes, ...shapes.slice(index + 1)],
      parts: exploded.shapes,
      hierarchy: exploded.hierarchy,
    };
  } catch (error) {
    if (error instanceof StepExplodeError) {
      return { ok: false, messageKey: REFUSAL_MESSAGES[error.reason], ...(Object.keys(error.params).length ? { params: error.params } : {}) };
    }
    return { ok: false, messageKey: "editor.explode.failed" };
  }
}
