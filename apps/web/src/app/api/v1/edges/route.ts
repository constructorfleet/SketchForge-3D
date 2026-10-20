import { apiContext, apiError, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { readProjectDocument } from "@/lib/serverProjectDocument";
import { shapeEdges, ServerCadError } from "@/lib/serverCadOperations";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's edges, numbered as a fillet or chamfer request refers to them. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const document = await readProjectDocument(context.root, projectId);
  if (!document) return apiErrors.projectNotFound();
  const shape = document.shapes.find((candidate) => candidate.id === shapeId);
  if (!shape) return apiErrors.shapeNotFound();

  try {
    return apiJson({ edges: await shapeEdges(shape) });
  } catch (error) {
    if (error instanceof ServerCadError) return apiError(error.message, error.status, "cad_failed");
    return apiError("The CAD kernel could not read that shape.", 500, "cad_failed");
  }
}
