import { NextResponse } from "next/server";
import { LocalizedError, errorResponseFields } from "@/i18n/LocalizedError";
import { caughtErrorResponse, errorResponse } from "@/lib/apiErrors";
import { sameOriginRequest } from "@/lib/apiRequests";
import {
  deleteProjectFiles,
  ensureProjectsDirectory,
  listProjectRecords,
  projectRecord,
  readProjectMetadata,
  readProjectPackage,
  withProjectLock,
  writeProjectMetadata,
  writeProjectPackage,
  type ProjectMetadata,
} from "@/lib/engine/serverProjectFiles";
import {
  SERVER_PROJECTS_ENV,
  safeServerProjectId,
  serverProjectWriteIsStale,
} from "@/lib/serverProjectStore";
import { SKF_LIMITS, SKF_MEDIA_TYPE } from "@/lib/engine/skfProject";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

function disabledResponse() {
  return NextResponse.json(
    {
      enabled: false,
      projects: [],
      ...errorResponseFields(new LocalizedError("errors.projects.notConfigured", { name: SERVER_PROJECTS_ENV })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const root = await ensureProjectsDirectory();
    if (!root) return disabledResponse();
    const requestedId = new URL(request.url).searchParams.get("projectId");
    if (requestedId !== null) {
      const projectId = safeServerProjectId(requestedId);
      if (!projectId) return errorResponse("errors.projects.invalidId", 400);
      const bytes = await readProjectPackage(root, projectId);
      if (!bytes) return errorResponse("errors.projects.notFound", 404);
      return new Response(bytes, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": SKF_MEDIA_TYPE,
        },
      });
    }

    return NextResponse.json(
      { enabled: true, projects: await listProjectRecords(root) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return caughtErrorResponse(error, "errors.projects.loadFailed", 500, { enabled: true, projects: [] });
  }
}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return errorResponse("errors.projects.sameOrigin", 403);

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > SKF_LIMITS.archiveBytes + MAX_METADATA_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
    return errorResponse("errors.projects.tooLarge", 413);
  }

  try {
    const root = await ensureProjectsDirectory();
    if (!root) return errorResponse("errors.projects.disabled", 404);
    const projectId = safeServerProjectId(new URL(request.url).searchParams.get("projectId") ?? "");
    if (!projectId) return errorResponse("errors.projects.invalidId", 400);

    // The dashboard writes the two halves of a project separately: the list
    // effect sends `metadata` when a name, thumbnail, or setting changes, and
    // autosave sends `project` with the revision it packed. A metadata-only
    // write must not clobber the package, and a package-only write must not
    // clobber the sidecar the list owns.
    const formData = await request.formData();
    const metadataField = formData.get("metadata");
    if (metadataField !== null && typeof metadataField !== "string") return errorResponse("errors.projects.invalidMetadata", 400);
    if (typeof metadataField === "string" && metadataField.length > MAX_METADATA_BYTES) return errorResponse("errors.projects.tooLarge", 413);
    let metadata: ProjectMetadata | null = null;
    if (typeof metadataField === "string") {
      try {
        const parsed = JSON.parse(metadataField) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        metadata = parsed as ProjectMetadata;
      } catch {
        return errorResponse("errors.projects.invalidMetadata", 400);
      }
    }

    const packageField = formData.get("project");
    const packageBytes = packageField instanceof Blob ? new Uint8Array(await packageField.arrayBuffer()) : null;
    if (packageBytes && packageBytes.byteLength > SKF_LIMITS.archiveBytes) {
      return errorResponse("errors.projects.tooLarge", 413);
    }
    if (!metadata && !packageBytes) return errorResponse("errors.projects.missingMetadata", 400);

    const revisionField = formData.get("revision");
    const writtenRevision = metadata ?? (typeof revisionField === "string" ? { revision: Number(revisionField) } : null);

    const locked = await withProjectLock(root, projectId, async () => {
      const stored = await readProjectMetadata(root, projectId);
      if (serverProjectWriteIsStale(stored, writtenRevision)) {
        return errorResponse("errors.projects.changedBeforeSave", 409);
      }

      if (packageBytes) await writeProjectPackage(root, projectId, packageBytes);
      if (metadata) await writeProjectMetadata(root, projectId, metadata);

      const savedMetadata = metadata ?? stored;
      return NextResponse.json(
        { project: savedMetadata ? await projectRecord(root, projectId, savedMetadata) : null },
        { status: stored ? 200 : 201, headers: { "Cache-Control": "no-store" } },
      );
    });
    return locked.busy ? errorResponse("errors.projects.busySaving", 409) : locked.result;
  } catch (error) {
    return caughtErrorResponse(error, "errors.projects.saveFailed", 400);
  }
}

export async function DELETE(request: Request) {
  if (!sameOriginRequest(request)) return errorResponse("errors.projects.sameOrigin", 403);

  try {
    const root = await ensureProjectsDirectory();
    if (!root) return errorResponse("errors.projects.disabled", 404);
    const projectId = safeServerProjectId(new URL(request.url).searchParams.get("projectId") ?? "");
    if (!projectId) return errorResponse("errors.projects.invalidId", 400);

    const locked = await withProjectLock(root, projectId, async () => {
      const existed = await deleteProjectFiles(root, projectId);
      return existed
        ? NextResponse.json({ deleted: true, projectId }, { headers: { "Cache-Control": "no-store" } })
        : errorResponse("errors.projects.notFound", 404);
    });
    return locked.busy ? errorResponse("errors.projects.busySaving", 409) : locked.result;
  } catch (error) {
    return caughtErrorResponse(error, "errors.projects.deleteFailed", 500);
  }
}
