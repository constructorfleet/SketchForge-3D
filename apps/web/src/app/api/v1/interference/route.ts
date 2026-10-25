import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

/** Exact shape-to-shape gaps and penetration volumes for a bounded scene subset. */
async function postInterference(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();

  let ids: string[] | undefined;
  if (body.ids !== undefined) {
    const parsed = apiShapeIds(body.ids);
    if (!parsed || parsed.length === 0) return apiError("ids must be a non-empty list of unique shape ids.", 400, "invalid_request");
    ids = parsed;
  }
  if (body.clearance !== undefined && (typeof body.clearance !== "number" || !Number.isFinite(body.clearance) || body.clearance < 0)) {
    return apiError("clearance must be a finite, non-negative number of millimetres.", 400, "invalid_request");
  }
  const contractBody = {
    ...(ids === undefined ? {} : { ids }),
    ...(body.clearance === undefined ? {} : { clearance: body.clearance }),
  };
  if (!validateApiV1RequestBody("POST /api/v1/interference", contractBody)) {
    return apiError("The interference request does not match its contract.", 400, "invalid_request");
  }

  const result = await apiEngine(context.root, request).interference(projectId, {
    ...(ids === undefined ? {} : { ids }),
    ...(body.clearance === undefined ? {} : { clearance: body.clearance as number }),
  });
  if (!result.ok) return apiEngineError(result.failure, { cadFailed: "The CAD kernel could not check interference." });
  return apiJson(result.value);
}

export const POST = withApiV1Contract("POST /api/v1/interference", postInterference);
