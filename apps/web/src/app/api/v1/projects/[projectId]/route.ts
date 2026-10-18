import { apiContext, apiError, apiJson, apiProjectId } from "@/lib/apiV1";
import { deleteProjectFiles, withProjectLock } from "@/lib/serverProjectFiles";
import { readProjectDocument } from "@/lib/serverProjectDocument";
import { apiShapeSummary } from "@/lib/apiShapes";

export const runtime = "nodejs";
export const revalidate = false;

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, routeContext: RouteContext) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const projectId = apiProjectId((await routeContext.params).projectId);
  if (!projectId) return apiError("Invalid project id.", 400);

  const document = await readProjectDocument(context.root, projectId);
  if (!document) return apiError("That project is not on the server.", 404);
  return apiJson({
    project: {
      id: projectId,
      name: document.projectName,
      createdAt: document.createdAt,
      snapGrid: document.snapGrid,
      workspace: document.workspace,
      shapes: document.shapes.map(apiShapeSummary),
    },
  });
}

export async function DELETE(request: Request, routeContext: RouteContext) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const projectId = apiProjectId((await routeContext.params).projectId);
  if (!projectId) return apiError("Invalid project id.", 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const existed = await deleteProjectFiles(context.root, projectId);
    return existed ? apiJson({ deleted: true, id: projectId }) : apiError("That project is not on the server.", 404);
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}
