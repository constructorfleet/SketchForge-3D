import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody } from "@/lib/apiV1";
import { parseApiV1Query, withApiV1Contract } from "@/lib/apiV1OperationContract";
// The engine's checks and reply, so MCP local mode answers the same requests the same way.
import {
  API_SKETCH_CONSTRAINT_MESSAGES,
  apiSketchConstraintBound,
  isApiSketchConstraintBindRequest,
  SKETCH_CONSTRAINT_WORDING,
} from "@constructorfleet/sketchforge-engine/apiSketchConstraints";

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
    return apiError(API_SKETCH_CONSTRAINT_MESSAGES.constraintIdRequired, 400, "invalid_request");
  }
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  if (!isApiSketchConstraintBindRequest(body)) {
    return apiError(API_SKETCH_CONSTRAINT_MESSAGES.body, 400, "invalid_request");
  }

  const { projectId, shapeId, constraintId } = query.values as { projectId: string; shapeId: string; constraintId: string };
  const bound = await apiEngine(context.root, request).bindSketchConstraint(projectId, shapeId, constraintId, body.expression);
  if (!bound.ok) return apiEngineError(bound.failure, SKETCH_CONSTRAINT_WORDING);
  return apiJson(apiSketchConstraintBound(bound.value, constraintId));
}

export const PATCH = withApiV1Contract(KEY, patchHandler);
