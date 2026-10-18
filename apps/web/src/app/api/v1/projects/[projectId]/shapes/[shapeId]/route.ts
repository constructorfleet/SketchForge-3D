import { apiContext, apiError, apiJson, apiJsonBody, apiProjectId } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/serverProjectDocument";
import { withProjectLock } from "@/lib/serverProjectFiles";
import { shapeWithRequestedChanges } from "@/lib/shapeRequests";

export const runtime = "nodejs";
export const revalidate = false;

type RouteContext = { params: Promise<{ projectId: string; shapeId: string }> };

async function routeIds(routeContext: RouteContext) {
  const params = await routeContext.params;
  return { projectId: apiProjectId(params.projectId), shapeId: decodeURIComponent(params.shapeId) };
}

export async function PATCH(request: Request, routeContext: RouteContext) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = await routeIds(routeContext);
  if (!projectId) return apiError("Invalid project id.", 400);

  const body = await apiJsonBody(request);
  if (!body) return apiError("Expected a JSON object body.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
    const existing = document.shapes.find((shape) => shape.id === shapeId);
    if (!existing) return apiError("That shape is not in the project.", 404);
    if (existing.locked && body.locked !== false) {
      return apiError("That shape is locked. Send locked: false to change it.", 409);
    }

    const updated = shapeWithRequestedChanges(existing, body);
    const shapes = document.shapes.map((shape) => (shape.id === shapeId ? updated : shape));
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ shape: apiShapeSummary(updated), revision: written.revision });
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}

export async function DELETE(request: Request, routeContext: RouteContext) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = await routeIds(routeContext);
  if (!projectId) return apiError("Invalid project id.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
    const existing = document.shapes.find((shape) => shape.id === shapeId);
    if (!existing) return apiError("That shape is not in the project.", 404);
    if (existing.locked) return apiError("That shape is locked.", 409);

    const shapes = document.shapes.filter((shape) => shape.id !== shapeId);
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({ deleted: true, id: shapeId, revision: written.revision });
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}
