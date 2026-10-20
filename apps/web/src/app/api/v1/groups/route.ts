import { apiContext, apiError, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/serverProjectDocument";
import { withProjectLock } from "@/lib/serverProjectFiles";
import { buildGroupFromSelection } from "@/lib/serverShapeBooleans";
import { restoreGroupedChildren } from "@/lib/serverShapeGroups";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Group shapes into one.
 *
 * Grouping is also how the app subtracts, so a selection holding both a solid
 * and a shape marked `hole: true` comes back cut rather than merely bundled --
 * the same thing the editor's Group button does with the same selection. The
 * booleans endpoint is the same operation with the operands named explicitly.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);

  const body = await apiJsonBody(request);
  if (!body) return apiError("Expected a JSON object body.", 400);
  const ids = apiShapeIds(body.ids);
  if (!ids) return apiError("Send ids: a list of distinct shape ids to group.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);

    const wanted = new Set(ids);
    const members = document.shapes.filter((shape) => wanted.has(shape.id));
    if (members.length !== ids.length) {
      const found = new Set(members.map((shape) => shape.id));
      return apiError(`Not in the project: ${ids.filter((id) => !found.has(id)).join(", ")}.`, 404);
    }
    const immovable = members.filter((shape) => shape.locked);
    if (immovable.length > 0) {
      return apiError(`Unlock every shape first; these are locked: ${immovable.map((shape) => shape.id).join(", ")}.`, 409);
    }

    const outcome = await buildGroupFromSelection(members);
    if ("error" in outcome) return apiError(outcome.error, outcome.status);

    const shapes = [...document.shapes.filter((shape) => !wanted.has(shape.id)), outcome.group];
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shape: apiShapeSummary(outcome.group), revision: written.revision }, 201);
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
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
  if (!projectId) return apiError("Invalid project id.", 400);
  if (!shapeId) return apiError("A shapeId is required.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
    const group = document.shapes.find((shape) => shape.id === shapeId);
    if (!group) return apiError("That shape is not in the project.", 404);
    if (group.locked) return apiError("That group is locked.", 409);
    if (!group.groupedShapes?.length) return apiError("That shape is not a group.", 422);

    const children = restoreGroupedChildren(group);
    const shapes = [...document.shapes.filter((shape) => shape.id !== shapeId), ...children];
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shapes: children.map(apiShapeSummary), revision: written.revision });
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}
