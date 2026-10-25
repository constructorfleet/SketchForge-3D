import { NextResponse } from "next/server";
import { exportProjectScene, type ProjectExportFormat } from "@constructorfleet/sketchforge-engine/sceneExport";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { measureBetween } from "@constructorfleet/sketchforge-engine/serverCadMeasure";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_EDITOR_CAD_REQUEST_BYTES = 32 * 1024 * 1024;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function validShape(value: unknown): value is WorkplaneShape {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string");
}

/** Run the same exact CAD kernel operations as the REST API on the editor's latest in-memory geometry. */
export async function POST(request: Request) {
  const size = Number(request.headers.get("content-length") ?? 0);
  if (size > MAX_EDITOR_CAD_REQUEST_BYTES) return json({ error: "The editor CAD request is too large." }, 413);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_EDITOR_CAD_REQUEST_BYTES) return json({ error: "The editor CAD request is too large." }, 413);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "Expected a JSON object." }, 400);
    body = value as Record<string, unknown>;
  } catch {
    return json({ error: "Expected a JSON object." }, 400);
  }
  if (typeof body.projectId !== "string" || !body.projectId.trim()) return json({ error: "A project id is required." }, 400);
  try {
    if (body.operation === "properties") {
      if (!validShape(body.shape)) return json({ error: "A shape is required." }, 400);
      return json({ properties: await shapeProperties(body.shape) });
    }
    if (body.operation === "measure") {
      const from = body.from as { shape?: unknown; entity?: unknown; index?: unknown } | undefined;
      const to = body.to as { shape?: unknown; entity?: unknown; index?: unknown } | undefined;
      if (!from || !to || !validShape(from.shape) || !validShape(to.shape)) return json({ error: "Two valid shapes are required." }, 400);
      const measurement = await measureBetween(
        { shape: from.shape, entity: from.entity === "edge" || from.entity === "face" ? from.entity : "shape", ...(typeof from.index === "number" ? { index: from.index } : {}) },
        { shape: to.shape, entity: to.entity === "edge" || to.entity === "face" ? to.entity : "shape", ...(typeof to.index === "number" ? { index: to.index } : {}) },
      );
      return json(measurement);
    }
    if (body.operation === "export") {
      if (!Array.isArray(body.shapes) || !body.shapes.length || !body.shapes.every(validShape)) return json({ error: "At least one valid shape is required." }, 400);
      if (body.format !== "svg" && body.format !== "dxf") return json({ error: "Only kernel SVG and section DXF are supported." }, 400);
      const artifact = await exportProjectScene(
        { projectName: typeof body.name === "string" ? body.name : "SketchForge design", shapes: body.shapes } as Parameters<typeof exportProjectScene>[0],
        {
          format: body.format as ProjectExportFormat,
          ...(body.section && typeof body.section === "object" ? { section: body.section as { plane: "xy" | "xz" | "yz"; offset: number } } : {}),
          ...(typeof body.view === "string" ? { view: body.view as "front" | "back" | "top" | "bottom" | "left" | "right" | "iso" | "multiview" } : {}),
        },
      );
      return new Response(Buffer.from(artifact.data), { headers: { "Content-Type": artifact.mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`, "Cache-Control": "no-store" } });
    }
    return json({ error: "Unknown editor CAD operation." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "The CAD kernel could not complete the operation." }, 422);
  }
}
