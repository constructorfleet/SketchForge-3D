import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson } from "@/lib/apiV1";
import { parseApiV1Query, parseListEdgesResponse, withApiV1Contract } from "@/lib/apiV1OperationContract";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's edges, numbered as a fillet or chamfer request refers to them. */
const getEdges = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("GET /api/v1/edges", request);
  if (!query.ok) return query.invalid.includes("projectId") ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = query.values;

  const edges = await apiEngine(context.root, request).edges(projectId, shapeId);
  if (!edges.ok) {
    return apiEngineError(edges.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape." });
  }
  const response = parseListEdgesResponse({ edges: edges.value });
  if (!response) return apiError("The CAD kernel returned an invalid edge listing.", 500, "cad_failed");
  return apiJson(response);
};

export const GET = withApiV1Contract("GET /api/v1/edges", getEdges);

/**
 * The methods this route answers, and -- more importantly -- the reason it is
 * not prerendered into a permanent 404. See `apiV1Methods`.
 */
export const OPTIONS = apiReadOnlyOptions;
