import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson } from "@/lib/apiV1";
import { parseApiV1Query, parseListFacesResponse, withApiV1Contract } from "@/lib/apiV1OperationContract";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's faces, numbered as a shell request refers to them, and named where they can be. */
const getFaces = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("GET /api/v1/faces", request);
  if (!query.ok) {
    if (query.invalid.includes("projectId")) return apiErrors.invalidProjectId();
    if (query.invalid.includes("shapeId")) return apiErrors.shapeIdRequired();
    return apiError("topology must be mesh or exact.", 400, "invalid_request");
  }
  const { projectId, shapeId, topology } = query.values;

  const faces = await apiEngine(context.root).faces(projectId, shapeId, topology === "exact" ? "exact" : undefined);
  if (!faces.ok) {
    return apiEngineError(faces.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape." });
  }
  const response = parseListFacesResponse({ faces: faces.value });
  if (!response) return apiError("The CAD kernel returned an invalid face listing.", 500, "cad_failed");
  return apiJson(response);
};

export const GET = withApiV1Contract("GET /api/v1/faces", getFaces);

/**
 * The methods this route answers, and -- more importantly -- the reason it is
 * not prerendered into a permanent 404. See `apiV1Methods`.
 */
export const OPTIONS = apiReadOnlyOptions;
