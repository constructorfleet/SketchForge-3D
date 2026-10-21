import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson } from "@/lib/apiV1";
import { parseApiTargetQuery, parseShapePropertiesResponse } from "@/lib/apiV1OperationContract";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** Exact mass properties for one shape, with the geometry source and precision. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiTargetQuery(request);
  if (!query.ok) return query.error === "invalid_project_id" ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = query;

  const properties = await apiEngine(context.root).properties(projectId, shapeId);
  if (!properties.ok) {
    return apiEngineError(properties.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape's properties." });
  }
  const response = parseShapePropertiesResponse({ properties: properties.value });
  if (!response) return apiError("The CAD kernel returned invalid shape properties.", 500, "cad_failed");
  return apiJson(response);
}

export const OPTIONS = apiReadOnlyOptions;
