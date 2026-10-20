import { apiContext, apiError, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";
import { readProjectDocument } from "@/lib/engine/serverProjectDocument";
import { ServerCadError } from "@/lib/engine/serverCadOperations";
import { shapeFaces } from "@/lib/engine/serverCadShell";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's faces, numbered as a shell request refers to them, and named where they can be. */
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
    return apiJson({ faces: await shapeFaces(shape) });
  } catch (error) {
    if (error instanceof ServerCadError) return apiError(error.message, error.status, "cad_failed");
    return apiError("The CAD kernel could not read that shape.", 500, "cad_failed");
  }
}

/**
 * The methods this route answers, and -- more importantly -- the reason it is
 * not prerendered into a permanent 404. See `apiV1Methods`.
 */
export const OPTIONS = apiReadOnlyOptions;
