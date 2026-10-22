import { apiContext, apiError, apiErrors, apiJson } from "@/lib/apiV1";
import { parseApiV1Query, parseThicknessResponse, withApiV1Contract } from "@/lib/apiV1OperationContract";
import { readProjectDocument } from "@/lib/engine/serverProjectDocument";
import { wallThickness } from "@constructorfleet/sketchforge-engine/serverCadThickness";
import { ServerCadError } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** Estimate the thinnest wall by sampling opposing surface pairs. */
const getThickness = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("GET /api/v1/thickness", request);
  if (!query.ok) return query.invalid.includes("projectId") ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = query.values;
  const document = await readProjectDocument(context.root, projectId);
  if (!document) return apiErrors.projectNotFound();
  const shape = document.shapes.find((candidate) => candidate.id === shapeId);
  if (!shape) return apiError(`Shape ${shapeId} is not in the project.`, 404, "shape_not_found");
  try {
    const response = parseThicknessResponse({ thickness: await wallThickness(shape) });
    if (!response) return apiError("The CAD kernel returned an invalid wall-thickness estimate.", 500, "cad_failed");
    return apiJson(response);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Wall thickness could not be estimated.", error instanceof ServerCadError ? error.status : 422, "geometry_failed");
  }
};

export const GET = withApiV1Contract("GET /api/v1/thickness", getThickness);

export const OPTIONS = apiReadOnlyOptions;
