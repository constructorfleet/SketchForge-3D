import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";

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
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const kind = body.kind === "chamfer" ? "chamfer" : body.kind === "fillet" ? "fillet" : null;
  if (!kind) return apiError('Send kind: "fillet" or kind: "chamfer".', 400, "invalid_request");
  if (typeof body.amount !== "number") return apiError("Send amount as a number: the fillet radius or chamfer distance in mm.", 400, "invalid_request");
  if (body.angle !== undefined && typeof body.angle !== "number") return apiError("angle must be a number of degrees.", 400, "invalid_request");
  const edges = edgeIndexes(body.edges);
  if (edges === null) return apiError('edges must be a list of edge indexes, or "all".', 400, "invalid_request");

  const treated = await apiEngine(context.root).treat(projectId, shapeId, {
    kind,
    amount: body.amount,
    angle: body.angle as number | undefined,
    edges,
  });
  if (!treated.ok) return apiEngineError(treated.failure, { oneShape: true });
  return apiJson({
    shape: apiShapeSummary(treated.value.shape),
    triangles: treated.value.shape.importedMesh?.triangleCount ?? 0,
    revision: treated.value.revision,
  });
}
