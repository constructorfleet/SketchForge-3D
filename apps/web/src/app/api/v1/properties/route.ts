import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** Exact mass properties for one shape, with the geometry source and precision. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const properties = await apiEngine(context.root).properties(projectId, shapeId);
  if (!properties.ok) {
    return apiEngineError(properties.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape's properties." });
  }
  return apiJson({ properties: properties.value });
}

export const OPTIONS = apiReadOnlyOptions;
