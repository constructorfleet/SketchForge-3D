import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { parseApiV1Query, validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

const AXES = ["x", "y", "z"] as const;

/** Reflect selected exact parameter-built solids across their shared bounds plane. */
async function postMirrors(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("POST /api/v1/mirrors", request);
  if (!query.ok) return apiErrors.invalidProjectId();
  const { projectId } = query.values;

  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiError("Expected a JSON object body.", 400, "invalid_body");
  const ids = apiShapeIds(body.ids);
  if (!ids?.length) return apiError("Send ids: a list of distinct shape ids to mirror.", 400, "invalid_request");
  const axis = AXES.find((candidate) => candidate === body.axis);
  if (!axis) return apiError("Send axis as x, y, or z.", 400, "invalid_request");
  if (!validateApiV1RequestBody("POST /api/v1/mirrors", { ids, axis })) {
    return apiError("The mirror request does not match its contract.", 400, "invalid_request");
  }

  const mirrored = await apiEngine(context.root, request).mirrorBaked(projectId, ids, axis);
  if (!mirrored.ok) return apiEngineError(mirrored.failure, {
    tooFewShapes: () => "Select at least one shape to mirror.",
    locked: (locked) => `Unlock these shapes before mirroring: ${locked.join(", ")}.`,
    cadFailed: "The exact mirror could not be completed.",
  });
  return apiJson({
    moved: mirrored.value.moved,
    axis,
    shapes: mirrored.value.shapes.map(apiShapeSummary),
    revision: mirrored.value.revision,
  });
}

export const POST = withApiV1Contract("POST /api/v1/mirrors", postMirrors);
