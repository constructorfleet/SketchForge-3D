import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's faces, numbered as a shell request refers to them, and named where they can be. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const faces = await apiEngine(context.root).faces(projectId, shapeId);
  if (!faces.ok) {
    return apiEngineError(faces.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape." });
  }
  return apiJson({ faces: faces.value });
}

/**
 * The methods this route answers, and -- more importantly -- the reason it is
 * not prerendered into a permanent 404. See `apiV1Methods`.
 */
export const OPTIONS = apiReadOnlyOptions;
