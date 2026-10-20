import type { Transport } from "../http.js";
import { IMPORTABLE_MESH_FORMATS, type MeshImportRequest, type MeshImportResult } from "../types.js";

/**
 * Bytes as base64, without assuming which runtime this is.
 *
 * The server also accepts a multipart upload, but the transport here speaks
 * JSON and nothing else -- adding a second content type to it for one endpoint
 * would be a larger change than encoding the bytes.
 *
 * `btoa` is fed one chunk at a time: a spread of a megabyte-long array
 * overflows the call stack, and a model file is routinely larger than that.
 *
 * Exported so a test can exercise both branches: deleting `globalThis.Buffer`
 * around a whole request takes the test harness down with it.
 */
export function meshBytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");

  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export class Imports {
  constructor(private readonly transport: Transport) {}

  /**
   * Adds the model a file describes, and keeps the file with the project.
   *
   * The source file is stored as a project asset and the shape points at it,
   * both in one write -- a shape stored without its asset loses its geometry
   * the next time the project is saved.
   *
   * `stl`, `obj` and `svg`. A STEP file is refused with `unsupported_format`:
   * reading one needs the CAD kernel the editor loads in a browser.
   */
  async apply(projectId: string, request: MeshImportRequest): Promise<MeshImportResult> {
    return this.transport.send<MeshImportResult>({
      method: "POST",
      path: "/imports",
      query: { projectId },
      body: {
        fileName: request.fileName,
        data: meshBytesToBase64(request.bytes),
        ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
      },
      retryable: true,
    });
  }

  /** Whether this file's name is one the server will try to read at all. */
  readable(fileName: string) {
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    return (IMPORTABLE_MESH_FORMATS as readonly string[]).includes(extension);
  }
}
