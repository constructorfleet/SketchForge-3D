import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's edges, numbered as a fillet or chamfer request refers to them. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const edges = await apiEngine(context.root).edges(projectId, shapeId);
  if (!edges.ok) {
    return apiEngineError(edges.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape." });
  }
  return apiJson({ edges: edges.value });
}

/**
 * The methods this route answers, and -- more importantly -- the reason it is
 * not prerendered into a permanent 404. See `apiV1Methods`.
 */
export const OPTIONS = apiReadOnlyOptions;
