import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiRequestBodyBytes, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";
import { withApiV1Contract } from "@/lib/apiV1OperationContract";
import { IMPORTABLE_MESH_FORMATS } from "@/lib/engine/meshImport";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Sixty-four megabytes, which is a very large STL and a nonsensical SVG.
 *
 * A limit rather than no limit because the whole file is held in memory twice
 * -- once as the upload and once inside the project package -- and the point of
 * refusing early is that the project is never touched.
 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

type Upload = { fileName: string; bytes: Uint8Array; mediaType?: string };

/** A base64 string as bytes, or null when it is not base64. */
function decodeBase64(value: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
}

/**
 * The file a request carries, either way of sending one.
 *
 * `multipart/form-data` is what a person reaches for -- `curl -F
 * file=@bracket.stl` -- and base64 in JSON is what a client library reaches
 * for, since both client libraries speak JSON and nothing else. Supporting one
 * would have made the other awkward, and the two together are a dozen lines.
 *
 * A string is returned instead when the request cannot be read, so the handler
 * can say which half was wrong.
 */
async function uploadFrom(request: Request): Promise<Upload | string> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) return "The multipart body could not be read.";
    const file = form.get("file");
    if (!(file instanceof File)) return 'Send the model as a form field named "file".';
    const fileName = (typeof form.get("fileName") === "string" ? String(form.get("fileName")) : file.name).trim();
    if (!fileName) return "The uploaded file has no name, and the name is what chooses the importer. Send fileName.";
    return { fileName, bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type || undefined };
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected a JSON object body, or a multipart form.";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  if (!fileName) return `Send fileName: the model's file name, which is what chooses the importer (${IMPORTABLE_MESH_FORMATS.join(", ")}).`;
  const data = body.data ?? body.contents;
  if (typeof data !== "string") return "Send data: the file's bytes, base64 encoded.";
  const bytes = decodeBase64(data);
  if (!bytes?.length) return "data was not readable base64, or was empty.";
  return { fileName, bytes, mediaType: typeof body.mediaType === "string" ? body.mediaType : undefined };
}

/**
 * Import a model file into a project.
 *
 * The importers have always been here; what the API never had was the step
 * after them. An imported shape carries its triangles *and* an id pointing at
 * the source file, which is kept on the project as an asset -- write the shape
 * without the asset and the next save strips the import back out again. Both
 * land in one write.
 *
 * The file name is not decoration: it chooses the importer, it names the asset,
 * and for an STL it decides which way is up, because SketchForge's own older
 * exports are Y-up and are recognised by their header.
 */
async function handlePost(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();

  const requestBytes = await apiRequestBodyBytes(request, { maxBytes: MAX_IMPORT_BYTES });
  if (requestBytes instanceof Response) return requestBytes;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const boundedRequest = new Request(request.url, { method: request.method, headers, body: Buffer.from(requestBytes) });
  const upload = await uploadFrom(boundedRequest);
  if (typeof upload === "string") return apiError(upload, 400, "invalid_body");
  if (upload.bytes.byteLength > MAX_IMPORT_BYTES) {
    return apiError(`A model can be at most ${MAX_IMPORT_BYTES / (1024 * 1024)}MB.`, 413, "invalid_request");
  }

  const imported = await apiEngine(context.root).importMesh(projectId, upload);
  if (!imported.ok) return apiEngineError(imported.failure);
  return apiJson({
    shape: apiShapeSummary(imported.value.shape),
    triangles: imported.value.shape.importedMesh?.triangleCount ?? 0,
    revision: imported.value.revision,
  }, 201);
}

export const POST = withApiV1Contract("POST /api/v1/imports", handlePost);
