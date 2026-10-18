import { apiContext, apiError, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/serverProjectDocument";
import { withProjectLock } from "@/lib/serverProjectFiles";
import { applyEdgeTreatment, shapeWithCadResult, ServerCadError } from "@/lib/serverCadOperations";

export const runtime = "nodejs";
export const revalidate = false;

function edgeIndexes(value: unknown) {
  if (value === undefined || value === null || value === "all") return undefined;
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "number") ? (value as number[]) : null;
}

/**
 * Round or cut a shape's edges, on the server.
 *
 * The editor does this in a browser worker, which means every client downloads
 * the CAD kernel and runs the solid modelling itself. Here the server does it,
 * and the result is stored as exact geometry so STEP export and any later
 * treatment build on it rather than on a triangle mesh.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiError("Invalid project id.", 400);
  if (!shapeId) return apiError("A shapeId is required.", 400);

  const body = await apiJsonBody(request);
  if (!body) return apiError("Expected a JSON object body.", 400);
  const kind = body.kind === "chamfer" ? "chamfer" : body.kind === "fillet" ? "fillet" : null;
  if (!kind) return apiError('Send kind: "fillet" or kind: "chamfer".', 400);
  if (typeof body.amount !== "number") return apiError("Send amount as a number: the fillet radius or chamfer distance in mm.", 400);
  if (body.angle !== undefined && typeof body.angle !== "number") return apiError("angle must be a number of degrees.", 400);
  const edges = edgeIndexes(body.edges);
  if (edges === null) return apiError('edges must be a list of edge indexes, or "all".', 400);

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiError("That project is not on the server.", 404);
    const shape = document.shapes.find((candidate) => candidate.id === shapeId);
    if (!shape) return apiError("That shape is not in the project.", 404);
    if (shape.locked) return apiError("That shape is locked.", 409);

    let treated;
    try {
      const result = await applyEdgeTreatment(shape, { kind, amount: body.amount as number, angle: body.angle as number | undefined, edges });
      treated = shapeWithCadResult(shape, result);
    } catch (error) {
      if (error instanceof ServerCadError) return apiError(error.message, error.status);
      return apiError("The CAD kernel could not complete that operation.", 500);
    }

    const shapes = document.shapes.map((candidate) => (candidate.id === shapeId ? treated : candidate));
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({
      shape: apiShapeSummary(treated),
      triangles: treated.importedMesh?.triangleCount ?? 0,
      revision: written.revision,
    });
  });
  return locked.busy ? apiError("That project is being changed; try again.", 409) : locked.result;
}
