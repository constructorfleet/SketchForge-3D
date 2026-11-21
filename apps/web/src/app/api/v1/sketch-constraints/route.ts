import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiShapeSummary } from "@/lib/apiShapes";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody } from "@/lib/apiV1";
import { parseApiV1Query, validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";
import { sketchConstraintSummary, type BindableSketchConstraint } from "@constructorfleet/sketchforge-engine/sketchConstraintBindings";

export const runtime = "nodejs";
export const revalidate = false;

const KEY = "PATCH /api/v1/sketch-constraints";

/** Binds one dimensional constraint to an expression, or unbinds it with null. */
async function patchHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query(KEY, request);
  if (!query.ok) {
    if (query.invalid.includes("projectId")) return apiErrors.invalidProjectId();
    if (query.invalid.includes("shapeId")) return apiErrors.shapeIdRequired();
    return apiError("A constraintId is required.", 400, "invalid_request");
  }
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  if (!validateApiV1RequestBody(KEY, body)) {
    return apiError("Send expression as a non-empty string, or null to remove the binding.", 400, "invalid_request");
  }

  const { projectId, shapeId, constraintId } = query.values as { projectId: string; shapeId: string; constraintId: string };
  const bound = await apiEngine(context.root, request).bindSketchConstraint(projectId, shapeId, constraintId, body.expression as string | null);
  if (!bound.ok) return apiEngineError(bound.failure, { oneShape: true });
  const constraint = bound.value.shape.sketchProfile?.constraints?.find((candidate) => candidate.id === constraintId);
  return apiJson({
    shape: apiShapeSummary(bound.value.shape),
    constraint: sketchConstraintSummary(constraint as BindableSketchConstraint),
    revision: bound.value.revision,
  });
}

export const PATCH = withApiV1Contract(KEY, patchHandler);
