import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { readProjectDocument } from "@/lib/engine/serverProjectDocument";
import { exportProjectScene, PROJECT_EXPORT_FORMATS, type ProjectExportFormat } from "@constructorfleet/sketchforge-engine/sceneExport";

export const runtime = "nodejs";
export const revalidate = false;

/** Export a server-stored project artifact for a macro or other API client. */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const body = await apiJsonBody(request);
  if (!body) return apiErrors.jsonBodyRequired();
  if (typeof body.format !== "string" || !PROJECT_EXPORT_FORMATS.includes(body.format as ProjectExportFormat)) {
    return apiError(`format must be one of: ${PROJECT_EXPORT_FORMATS.join(", ")}.`, 400, "unsupported_format");
  }
  const shapeIds = body.shapeIds === undefined ? undefined : apiShapeIds(body.shapeIds);
  if (body.shapeIds !== undefined && !shapeIds) {
    return apiError("shapeIds must be a list of distinct shape ids.", 400, "invalid_request");
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 120)) {
    return apiError("name must be a string no longer than 120 characters.", 400, "invalid_request");
  }

  const document = await readProjectDocument(context.root, projectId);
  if (!document) return apiErrors.projectNotFound();
  if (shapeIds) {
    const knownIds = new Set(document.shapes.map((shape) => shape.id));
    const missing = shapeIds.filter((id) => !knownIds.has(id));
    if (missing.length) return apiError(`These shapes are not in the project: ${missing.join(", ")}.`, 404, "shape_not_found");
  }

  try {
    const artifact = await exportProjectScene(document, {
      format: body.format as ProjectExportFormat,
      shapeIds: shapeIds ?? undefined,
      name: body.name as string | undefined,
    });
    return apiJson({
      format: artifact.format,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      bytes: artifact.data.byteLength,
      shapeCount: artifact.shapeCount,
      ...(artifact.exportedCount === undefined ? {} : { exportedCount: artifact.exportedCount }),
      ...(artifact.skipped === undefined ? {} : { skipped: artifact.skipped }),
      base64: Buffer.from(artifact.data).toString("base64"),
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "The project could not be exported.", 422, "geometry_failed");
  }
}
