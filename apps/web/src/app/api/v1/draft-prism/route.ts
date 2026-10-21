import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

/** Draft a solid along its vertical extrusion axis and persist the exact result. */
const postDraftPrism = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  if (typeof body.angle !== "number" || !Number.isFinite(body.angle)) {
    return apiError("Send angle as a number of degrees, between -45 and 45, excluding zero.", 400, "invalid_request");
  }
  if (!validateApiV1RequestBody("POST /api/v1/draft-prism", { angle: body.angle })) return apiError("The draft-prism request does not match its contract.", 400, "invalid_request");

  const drafted = await apiEngine(context.root).draftPrism(projectId, shapeId, body.angle);
  if (!drafted.ok) return apiEngineError(drafted.failure, { oneShape: true });
  return apiJson({
    shape: apiShapeSummary(drafted.value.shape),
    triangles: drafted.value.shape.importedMesh?.triangleCount ?? 0,
    revision: drafted.value.revision,
  });
}

export const POST = withApiV1Contract("POST /api/v1/draft-prism", postDraftPrism);
