import { apiContext, apiError, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/engine/serverProjectDocument";
import { withProjectLock } from "@/lib/engine/serverProjectFiles";
import { separateShapeParts } from "@/lib/engine/serverShapeGroups";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Split a shape into the bodies it is made of.
 *
 * What a cut leaves behind is often several separate pieces -- a bar cut
 * through the middle is two bars -- and until they are separate shapes a script
 * cannot move, colour or export one of them on its own.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();
    const shape = document.shapes.find((candidate) => candidate.id === shapeId);
    if (!shape) return apiErrors.shapeNotFound();
    if (shape.locked) return apiErrors.shapeLocked();
    if (shape.hole) return apiError("A hole has nothing to separate; it is a cutter, not a body.", 422, "invalid_request");

    const parts = separateShapeParts(shape);
    if (parts.length <= 1) {
      // A shape built from parameters is one body by construction, so the
      // server can answer this without meshing anything.
      return apiError("That shape is a single connected body.", 422, "invalid_request");
    }

    const shapes = [...document.shapes.filter((candidate) => candidate.id !== shapeId), ...parts];
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shapes: parts.map(apiShapeSummary), revision: written.revision });
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}
