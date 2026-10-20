import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
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
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const ids = apiShapeIds(body.ids);
  if (!ids) return apiError("Send ids: a list of distinct shape ids to group.", 400, "invalid_request");

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();

    const wanted = new Set(ids);
    const members = document.shapes.filter((shape) => wanted.has(shape.id));
    if (members.length !== ids.length) {
      const found = new Set(members.map((shape) => shape.id));
      return apiErrors.shapesNotFound(ids.filter((id) => !found.has(id)));
    }
    const immovable = members.filter((shape) => shape.locked);
    if (immovable.length > 0) {
      return apiErrors.shapeLocked(`Unlock every shape first; these are locked: ${immovable.map((shape) => shape.id).join(", ")}.`);
    }

    const outcome = await buildGroupFromSelection(members);
    if ("error" in outcome) return apiError(outcome.error, outcome.status, "geometry_failed");
    // Nothing was removed, so this is not the operation the caller asked for.
    // Refused before the project is written, and refused rather than answered
    // with the solid unchanged, which is the one reply a script cannot tell
    // from success. The editor treats the same case as a failed cut.
    if (outcome.cutRemovedNothing) {
      return apiError("None of the holes meet the solid, so there is nothing to cut.", 422, "geometry_failed");
    }

    const shapes = [...document.shapes.filter((shape) => !wanted.has(shape.id)), outcome.group];
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shape: apiShapeSummary(outcome.group), revision: written.revision }, 201);
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
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

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();
    const group = document.shapes.find((shape) => shape.id === shapeId);
    if (!group) return apiErrors.shapeNotFound();
    if (group.locked) return apiErrors.shapeLocked("That group is locked.");
    if (!group.groupedShapes?.length) return apiError("That shape is not a group.", 422, "invalid_request");

    const children = restoreGroupedChildren(group);
    const shapes = [...document.shapes.filter((shape) => shape.id !== shapeId), ...children];
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shapes: children.map(apiShapeSummary), revision: written.revision });
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}
