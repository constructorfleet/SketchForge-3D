import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Subtract shapes from shapes, on the server.
 *
 * The operands are named rather than marked: a script that computed a row of
 * holes should not have to go back and PATCH each one to `hole: true` before it
 * can take them out, and the same shape may well be a solid in one design and a
 * cutter in the next.
 *
 * Everything below the validation is `Engine.cut`: the project lock, the id
 * resolution, the document-order rule that decides whose colour the result
 * takes, and the refusal of a cut that removed nothing. This handler's job is
 * the request and the reply.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const solidIds = apiShapeIds(body.solidIds ?? body.solids);
  const holeIds = apiShapeIds(body.holeIds ?? body.holes);
  if (!solidIds?.length) return apiError("Send solidIds: the ids of the shapes to cut from.", 400, "invalid_request");
  if (!holeIds?.length) return apiError("Send holeIds: the ids of the shapes to subtract.", 400, "invalid_request");
  const both = solidIds.filter((id) => holeIds.includes(id));
  if (both.length > 0) return apiError(`A shape cannot be both a solid and a hole: ${both.join(", ")}.`, 400, "invalid_request");

  const cut = await apiEngine(context.root).cut(projectId, { solidIds, holeIds });
  if (!cut.ok) {
    return apiEngineError(cut.failure, {
      locked: (ids) => `Unlock every operand first; these are locked: ${ids.join(", ")}.`,
    });
  }
  return apiJson({
    shape: apiShapeSummary(cut.value.shape),
    triangles: cut.value.shape.importedMesh?.triangleCount ?? 0,
    revision: cut.value.revision,
  }, 201);
}
