import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/serverProjectDocument";
import { withProjectLock } from "@/lib/serverProjectFiles";
import { buildGroupFromSelection } from "@/lib/serverShapeBooleans";
import { withHoleMode } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Subtract shapes from shapes, on the server.
 *
 * The operands are named rather than marked: a script that computed a row of
 * holes should not have to go back and PATCH each one to `hole: true` before it
 * can take them out, and the same shape may well be a solid in one design and a
 * cutter in the next.
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

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();

    const byId = new Map(document.shapes.map((shape) => [shape.id, shape]));
    const missing = [...solidIds, ...holeIds].filter((id) => !byId.has(id));
    if (missing.length > 0) return apiErrors.shapesNotFound(missing);

    const holes = new Set(holeIds);
    const operandIds = new Set([...solidIds, ...holeIds]);
    // Document order, not request order: it decides which solid's colour the
    // result takes, and a project's own order is the one the editor would use.
    const operands: WorkplaneShape[] = document.shapes
      .filter((shape) => operandIds.has(shape.id))
      .map((shape) => withHoleMode(shape, holes.has(shape.id)));
    const immovable = operands.filter((shape) => shape.locked);
    if (immovable.length > 0) {
      return apiErrors.shapeLocked(`Unlock every operand first; these are locked: ${immovable.map((shape) => shape.id).join(", ")}.`);
    }

    const outcome = await buildGroupFromSelection(operands);
    if ("error" in outcome) return apiError(outcome.error, outcome.status, "geometry_failed");

    const shapes = [...document.shapes.filter((shape) => !operandIds.has(shape.id)), outcome.group];
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({
      shape: apiShapeSummary(outcome.group),
      triangles: outcome.group.importedMesh?.triangleCount ?? 0,
      revision: written.revision,
    }, 201);
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}
