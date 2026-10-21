import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { parseApiTargetQuery, parseMeasureBetweenRequest, parseMeasureBetweenResponse, parseMeasurementsResponse, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

const CAD_FAILED = "The CAD kernel could not measure that shape.";

/** A shape's edges and faces, measured from its exact geometry. */
async function getMeasurements(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiTargetQuery(request);
  if (!query.ok) return query.error === "invalid_project_id" ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = query;

  const measured = await apiEngine(context.root).measurements(projectId, shapeId);
  if (!measured.ok) {
    return apiEngineError(measured.failure, { oneShape: true, cadFailed: CAD_FAILED });
  }
  const response = parseMeasurementsResponse({ measurements: measured.value });
  if (!response) return apiError("The CAD kernel returned invalid measurements.", 500, "cad_failed");
  return apiJson(response);
}

/** The distance between two entities, and the angle between them if both are flat faces. */
async function measureEntities(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();

  const ends = parseMeasureBetweenRequest(body);
  if (!ends.ok) return apiError(`"${ends.side}" ${ends.error}`, 400, "invalid_request");

  const measured = await apiEngine(context.root).measureBetween(projectId, ends.from, ends.to);
  if (!measured.ok) {
    return apiEngineError(measured.failure, { cadFailed: CAD_FAILED });
  }
  const response = parseMeasureBetweenResponse(measured.value);
  if (!response) return apiError("The CAD kernel returned an invalid measurement.", 500, "cad_failed");
  return apiJson(response);
}

export const GET = withApiV1Contract("GET /api/v1/measurements", getMeasurements);
export const POST = withApiV1Contract("POST /api/v1/measurements", measureEntities);
