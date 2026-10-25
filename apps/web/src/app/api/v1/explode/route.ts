import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { parseApiV1Query, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

/** Turn one imported STEP assembly into separate exact solids. */
async function postExplode(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("POST /api/v1/explode", request);
  if (!query.ok) return query.invalid.includes("projectId") ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();
  const result = await apiEngine(context.root, request).explode(projectId, shapeId);
  if (!result.ok) return apiEngineError(result.failure, { oneShape: true, cadFailed: "The STEP assembly could not be exploded." });
  return apiJson({ shapes: result.value.shapes.map(apiShapeSummary), revision: result.value.revision });
}

export const POST = withApiV1Contract("POST /api/v1/explode", postExplode);
