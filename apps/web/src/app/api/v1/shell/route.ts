import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * The faces to leave open, or null when the field is malformed.
 *
 * A single entry on its own is a list of one: `openFaces: "top"` is how a
 * script asking for a tray wants to write it, and the same reading the boolean
 * endpoint gives `holeIds`.
 */
function openFaces(value: unknown) {
  if (value === undefined || value === null) return [];
  const entries = typeof value === "string" || typeof value === "number" ? [value] : value;
  if (!Array.isArray(entries)) return null;
  return entries.every((entry) => typeof entry === "string" || typeof entry === "number")
    ? (entries as (string | number)[])
    : null;
}

/**
 * Hollow a shape out, on the server.
 *
 * The one operation a 3D print wants most and the editor has never had: a solid
 * box costs four times the filament of a 2 mm-walled one, and the same box with
 * its top face open is a tray. Done here with OCCT, and stored as exact
 * geometry, so a hollowed part still exports to STEP and can still be filleted.
 */
const postShell = async (request: Request) => {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  const thickness = body.thickness ?? body.wall;
  if (typeof thickness !== "number") {
    return apiError("Send thickness as a number: the wall thickness in mm, measured inwards.", 400, "invalid_request");
  }
  const faces = openFaces(body.openFaces ?? body.open);
  if (faces === null) {
    return apiError(
      'openFaces must be a list of face directions ("top", "bottom", "left", "right", "front", "back") or face indexes.',
      400,
      "invalid_request",
    );
  }
  if (!validateApiV1RequestBody("POST /api/v1/shell", { thickness, ...(body.openFaces === undefined && body.open === undefined ? {} : { openFaces: body.openFaces ?? body.open }) })) return apiError("The shell request does not match its contract.", 400, "invalid_request");

  const hollowed = await apiEngine(context.root).shell(projectId, shapeId, { thickness, openFaces: faces });
  if (!hollowed.ok) return apiEngineError(hollowed.failure, { oneShape: true });
  return apiJson({
    shape: apiShapeSummary(hollowed.value.shape),
    triangles: hollowed.value.shape.importedMesh?.triangleCount ?? 0,
    revision: hollowed.value.revision,
  });
}

export const POST = withApiV1Contract("POST /api/v1/shell", postShell);
