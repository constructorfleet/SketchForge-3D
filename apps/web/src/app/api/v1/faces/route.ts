import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson } from "@/lib/apiV1";
import { parseListFacesQuery, parseListFacesResponse } from "@/lib/apiV1OperationContract";
import { apiReadOnlyOptions } from "@/lib/apiV1Methods";

export const runtime = "nodejs";
export const revalidate = false;

/** A shape's faces, numbered as a shell request refers to them, and named where they can be. */
export async function GET(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseListFacesQuery(request);
  if (!query.ok) return query.error === "invalid_project_id" ? apiErrors.invalidProjectId() : apiErrors.shapeIdRequired();
  const { projectId, shapeId } = query;

  const faces = await apiEngine(context.root).faces(projectId, shapeId);
  if (!faces.ok) {
    return apiEngineError(faces.failure, { oneShape: true, cadFailed: "The CAD kernel could not read that shape." });
  }
  const response = parseListFacesResponse({ faces: faces.value });
  if (!response) return apiError("The CAD kernel returned an invalid face listing.", 500, "cad_failed");
  return apiJson(response);
}

/**
 * The methods this route answers, and -- more importantly -- the reason it is
 * not prerendered into a permanent 404. See `apiV1Methods`.
 */
export const OPTIONS = apiReadOnlyOptions;
