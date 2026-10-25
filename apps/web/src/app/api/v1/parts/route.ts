import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiErrors, apiJson } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { parseApiV1Query, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Split a shape into the bodies it is made of.
 *
 * What a cut leaves behind is often several separate pieces -- a bar cut
 * through the middle is two bars -- and until they are separate shapes a script
 * cannot move, colour or export one of them on its own.
 */
async function postParts(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("POST /api/v1/parts", request);
  if (!query.ok) return query.invalid.includes("projectId") ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = query.values;

  const separated = await apiEngine(context.root, request).separate(projectId, shapeId);
  if (!separated.ok) return apiEngineError(separated.failure, { oneShape: true });
  return apiJson({ shapes: separated.value.shapes.map(apiShapeSummary), revision: separated.value.revision });
}

export const POST = withApiV1Contract("POST /api/v1/parts", postParts);
