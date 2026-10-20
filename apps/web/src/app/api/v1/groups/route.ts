import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Group shapes into one.
 *
 * Grouping is also how the app subtracts, so a selection holding both a solid
 * and a shape marked `hole: true` comes back cut rather than merely bundled --
 * the same thing the editor's Group button does with the same selection. The
 * booleans endpoint is the same operation with the operands named explicitly,
 * and since both go through `Engine` they are now the same code as well.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const ids = apiShapeIds(body.ids);
  if (!ids) return apiError("Send ids: a list of distinct shape ids to group.", 400, "invalid_request");

  const grouped = await apiEngine(context.root).group(projectId, ids);
  if (!grouped.ok) {
    return apiEngineError(grouped.failure, {
      locked: (locked) => `Unlock every shape first; these are locked: ${locked.join(", ")}.`,
    });
  }
  return apiJson({ shape: apiShapeSummary(grouped.value.shape), revision: grouped.value.revision }, 201);
}

/**
 * Take a group apart, leaving its children where they appeared.
 *
 * A group can have been moved, turned and resized since it was made, so its
 * children come back carrying all of that rather than springing back to where
 * they were when it was built.
 */
export async function DELETE(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const ungrouped = await apiEngine(context.root).ungroup(projectId, shapeId);
  if (!ungrouped.ok) {
    return apiEngineError(ungrouped.failure, { oneShape: true, locked: () => "That group is locked." });
  }
  return apiJson({ shapes: ungrouped.value.shapes.map(apiShapeSummary), revision: ungrouped.value.revision });
}
