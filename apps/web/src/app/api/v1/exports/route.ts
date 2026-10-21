import { apiContext, apiError, apiErrors, apiJson, apiJsonBody, apiShapeIds, apiTarget } from "@/lib/apiV1";
import { readProjectDocument } from "@/lib/engine/serverProjectDocument";
import { parseProjectionLayout, PROJECTION_LAYOUTS } from "@constructorfleet/sketchforge-engine/cadProjection";
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
  // `view` chooses what an SVG shows. On any other format it would be silently
  // ignored, which is the one answer a script cannot tell from success.
  if (body.view !== undefined && body.format !== "svg") {
    return apiError("view only applies to the svg format.", 400, "invalid_request");
  }
  const view = parseProjectionLayout(body.view);
  if (view === null) {
    return apiError(`view must be one of: ${PROJECTION_LAYOUTS.join(", ")}.`, 400, "invalid_request");
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
      view,
    });
    if (new URL(request.url).searchParams.get("download") === "1") {
      // The metadata header includes every field returned by JSON exports,
      // including STEP's skipped-shape details, so the Python file API can
      // stream the artifact body without losing its result metadata.
      const metadata = {
        format: artifact.format,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        shapeCount: artifact.shapeCount,
        ...(artifact.exportedCount === undefined ? {} : { exportedCount: artifact.exportedCount }),
        ...(artifact.skipped === undefined ? {} : { skipped: artifact.skipped }),
      };
      return new Response(Buffer.from(artifact.data), {
        headers: {
          "Content-Type": artifact.mimeType,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
          "X-SketchForge-Metadata": encodeURIComponent(JSON.stringify(metadata)),
          "Cache-Control": "no-store",
        },
      });
    }
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
