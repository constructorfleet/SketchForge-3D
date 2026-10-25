import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson } from "@/lib/apiV1";
import { parseApiV1Query, parseShapePropertiesResponse, withApiV1Contract } from "@/lib/apiV1OperationContract";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** Exact mass properties for one shape, with the geometry source and precision. */
const getProperties = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("GET /api/v1/properties", request);
  if (!query.ok) return query.invalid.includes("projectId") ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = query.values;

  const properties = await apiEngine(context.root, request).properties(projectId, shapeId);
  if (!properties.ok) {
    return apiEngineError(properties.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape's properties." });
  }
  const response = parseShapePropertiesResponse({ properties: properties.value });
  if (!response) return apiError("The CAD kernel returned invalid shape properties.", 500, "cad_failed");
  return apiJson(response);
};

export const GET = withApiV1Contract("GET /api/v1/properties", getProperties);

export const OPTIONS = apiReadOnlyOptions;
