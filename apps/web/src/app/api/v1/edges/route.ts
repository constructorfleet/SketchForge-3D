import { apiContext, apiError, apiJson, apiTarget } from "@/lib/apiV1";
import { readProjectDocument } from "@/lib/serverProjectDocument";
import { shapeEdges, ServerCadError } from "@/lib/serverCadOperations";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's edges, numbered as a fillet or chamfer request refers to them. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);
  if (!shapeId) return apiError("A shapeId is required.", 400);

  const document = await readProjectDocument(context.root, projectId);
  if (!document) return apiError("That project is not on the server.", 404);
  const shape = document.shapes.find((candidate) => candidate.id === shapeId);
  if (!shape) return apiError("That shape is not in the project.", 404);

  try {
    return apiJson({ edges: await shapeEdges(shape) });
  } catch (error) {
    if (error instanceof ServerCadError) return apiError(error.message, error.status);
    return apiError("The CAD kernel could not read that shape.", 500);
  }
}
