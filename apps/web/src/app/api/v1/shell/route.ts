import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { readProjectDocument, writeProjectDocument } from "@/lib/serverProjectDocument";
import { withProjectLock } from "@/lib/serverProjectFiles";
import { shapeWithCadResult, ServerCadError } from "@/lib/serverCadOperations";
import { applyShell } from "@/lib/serverCadShell";

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
export async function POST(request: Request) {
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

  const locked = await withProjectLock(context.root, projectId, async () => {
    const document = await readProjectDocument(context.root, projectId);
    if (!document) return apiErrors.projectNotFound();
    const shape = document.shapes.find((candidate) => candidate.id === shapeId);
    if (!shape) return apiErrors.shapeNotFound();
    if (shape.locked) return apiErrors.shapeLocked();

    let hollowed;
    try {
      const result = await applyShell(shape, { thickness, openFaces: faces });
      hollowed = shapeWithCadResult(shape, result);
    } catch (error) {
      if (error instanceof ServerCadError) return apiError(error.message, error.status, "cad_failed");
      return apiError("The CAD kernel could not complete that operation.", 500, "cad_failed");
    }

    const shapes = document.shapes.map((candidate) => (candidate.id === shapeId ? hollowed : candidate));
    const written = await writeProjectDocument(context.root, projectId, document, shapes);
    return apiJson({
      shape: apiShapeSummary(hollowed),
      triangles: hollowed.importedMesh?.triangleCount ?? 0,
      revision: written.revision,
    });
  });
  return locked.busy ? apiErrors.projectBusy() : locked.result;
}
