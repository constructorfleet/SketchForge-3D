import type { Transport } from "../http.js";
import {
  PROJECT_EXPORT_FORMATS,
  type ExportSkippedShape,
  type ProjectExportArtifact,
  type ProjectExportFormat,
  type ProjectExportRequest,
} from "../types.js";

/**
 * Base64 back to the exact bytes, without assuming which runtime this is.
 *
 * Exported so a test can exercise the browser branch without deleting
 * `globalThis.Buffer` around a whole request.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const nodeBuffer = (globalThis as { Buffer?: { from(input: string, encoding: string): Uint8Array } }).Buffer;
  if (nodeBuffer) return Uint8Array.from(nodeBuffer.from(base64, "base64"));
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The refusals `POST /exports` would answer with, raised before the request.
 *
 * The server refuses these too; checking here first keeps a typo in a macro
 * from costing a round trip, and keeps the messages the server's own.
 */
function refusal(request: ProjectExportRequest): string | undefined {
  if (!(PROJECT_EXPORT_FORMATS as readonly string[]).includes(request.format)) {
    return `format must be one of: ${PROJECT_EXPORT_FORMATS.join(", ")}.`;
  }
  // A view on anything but an SVG would be silently ignored by the exporter,
  // which is the one answer a script cannot tell from success.
  if (request.view !== undefined && request.format !== "svg") return "view only applies to the svg format.";
  if (request.section !== undefined && request.format !== "svg" && request.format !== "dxf") {
    return "section only applies to svg and dxf formats.";
  }
  if (request.section !== undefined && request.view !== undefined) return "section and view cannot be used together.";
  return undefined;
}

export class Exports {
  constructor(private readonly transport: Transport) {}

  /**
   * Export the project, or the named shapes, as one file.
   *
   * The artifact comes back whole as `data`; writing it to disk is the
   * caller's choice. `view` projects an SVG; `section` cuts SVG or DXF
   * contours with one axis plane.
   */
  async export(projectId: string, request: ProjectExportRequest): Promise<ProjectExportArtifact> {
    const refused = refusal(request);
    if (refused) throw new Error(refused);

    const payload = await this.transport.send<{
      format: ProjectExportFormat;
      filename: string;
      mimeType: string;
      bytes: number;
      shapeCount: number;
      exportedCount?: number;
      skipped?: ExportSkippedShape[];
      base64: string;
    }>({
      method: "POST",
      path: "/exports",
      query: { projectId },
      body: {
        format: request.format,
        ...(request.shapeIds === undefined ? {} : { shapeIds: [...request.shapeIds] }),
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.view === undefined ? {} : { view: request.view }),
        ...(request.section === undefined ? {} : { section: { plane: request.section.plane, offset: request.section.offset } }),
      },
    });
    return {
      format: payload.format,
      filename: payload.filename,
      mimeType: payload.mimeType,
      bytes: payload.bytes,
      shapeCount: payload.shapeCount,
      ...(payload.exportedCount === undefined ? {} : { exportedCount: payload.exportedCount }),
      ...(payload.skipped === undefined ? {} : { skipped: payload.skipped }),
      data: base64ToBytes(payload.base64),
    };
  }
}
