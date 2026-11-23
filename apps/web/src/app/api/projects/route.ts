import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { LocalizedError, errorResponseFields } from "@/i18n/LocalizedError";
import { caughtErrorResponse, errorResponse } from "@/lib/apiErrors";
import { sameOriginRequest } from "@/lib/apiRequests";
import {
  deleteProjectFiles,
  ensureProjectsDirectory,
  listProjectRecords,
  projectPackagePath,
  projectRecord,
  readProjectMetadata,
  readProjectPackage,
  regularFileStat,
  withProjectLock,
  writeProjectMetadata,
  writeProjectPackage,
  type ProjectMetadata,
} from "@/lib/engine/serverProjectFiles";
import {
  SERVER_PROJECTS_ENV,
  SERVER_PROJECT_REVISION_HEADER,
  safeServerProjectId,
  serverMetadataRevision,
  serverPackageBaseIsStale,
  serverProjectRevision,
  serverProjectWriteIsStale,
} from "@/lib/serverProjectStore";
import { SKF_LIMITS, SKF_MEDIA_TYPE } from "@/lib/engine/skfProject";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/** Names a package's content, so a delete can require the bytes a write left (#672). */
function packageDigest(bytes: Uint8Array | null) {
  return bytes ? createHash("sha256").update(bytes).digest("hex") : "none";
}

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
      // Read the sidecar first. Writers write the package and then the sidecar, so these
      // bytes are at least as new as this label. The other order could label old bytes
      // with a newer revision, and a save based on that label would pass the base check.
      const revision = String(serverProjectRevision(await readProjectMetadata(root, projectId)));
      const bytes = await readProjectPackage(root, projectId);
      if (!bytes) {
        const missing = errorResponse("errors.projects.notFound", 404);
        missing.headers.set(SERVER_PROJECT_REVISION_HEADER, revision);
        return missing;
      }
      return new Response(bytes, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": SKF_MEDIA_TYPE,
          // The base a client sends back with its next package write.
          [SERVER_PROJECT_REVISION_HEADER]: revision,
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
    const baseField = formData.get("baseRevision");
    const baseRevision = typeof baseField === "string" ? Number(baseField) : undefined;
    const baseMetadataField = formData.get("baseMetadataRevision");
    const baseMetadataRevision = typeof baseMetadataField === "string" ? Number(baseMetadataField) : undefined;

    const locked = await withProjectLock(root, projectId, async () => {
      const stored = await readProjectMetadata(root, projectId);
      const storedRevision = serverProjectRevision(stored);
      // A based metadata write saw a stored copy; with none left, a delete overtook it (#672).
      // Package writes stay allowed: a client with the project open may save it back (#665).
      const basedMetadataOnly = metadata && !packageBytes && Number.isFinite(baseMetadataRevision);
      if (basedMetadataOnly && !stored && !(await regularFileStat(projectPackagePath(root, projectId)))) {
        return errorResponse("errors.projects.notFound", 410, { conflict: "deleted" });
      }
      // A later clock is not a later copy: another client may have saved since this one loaded.
      // Only this check is a conflict; the client offers the newer copy for it.
      if (packageBytes && serverPackageBaseIsStale(stored, baseRevision)) {
        return errorResponse("errors.projects.changedBeforeSave", 409, { conflict: "newerRevision", storedRevision });
      }
      if (packageBytes && serverProjectWriteIsStale(stored, writtenRevision)) {
        return errorResponse("errors.projects.changedBeforeSave", 409);
      }
      // A list read before another client's rename or settings change would revert it.
      const storedMetadataRevision = serverMetadataRevision(stored);
      if (metadata && baseMetadataRevision !== undefined && Number.isFinite(baseMetadataRevision) && storedMetadataRevision > baseMetadataRevision) {
        return errorResponse("errors.projects.changedBeforeSave", 409, { conflict: "newerMetadata", storedMetadataRevision });
      }

      if (packageBytes) await writeProjectPackage(root, projectId, packageBytes);
      // The revision belongs to the package. A list write sent while a save was in flight
      // carries an older one, and one sent before its save lands a newer one; neither may move it.
      const writtenMetadata = metadata
        ? { ...metadata, ...(!packageBytes && storedRevision > 0 ? { revision: storedRevision } : {}), metadataRevision: storedMetadataRevision + 1 }
        : null;
      if (writtenMetadata) await writeProjectMetadata(root, projectId, writtenMetadata);
      // The sidecar revision is the package's, as REST v1 keeps it, so the next writer's base can be checked.
      else if (packageBytes && stored && writtenRevision) {
        const revision = serverProjectRevision(writtenRevision);
        if (revision > serverProjectRevision(stored)) await writeProjectMetadata(root, projectId, { ...stored, revision });
      }

      const savedMetadata = writtenMetadata ?? stored;
      const sidecar = await readProjectMetadata(root, projectId);
      // Hashing the stored package costs a read; only a create's re-delete needs it.
      const packageState = packageBytes
        ? packageDigest(packageBytes)
        : basedMetadataOnly ? undefined : packageDigest(await readProjectPackage(root, projectId));
      const storedState = { revision: serverProjectRevision(sidecar), metadataRevision: serverMetadataRevision(sidecar), ...(packageState ? { package: packageState } : {}) };
      return NextResponse.json(
        { project: savedMetadata ? await projectRecord(root, projectId, savedMetadata) : null, stored: storedState },
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
    const params = new URL(request.url).searchParams;
    const projectId = safeServerProjectId(params.get("projectId") ?? "");
    if (!projectId) return errorResponse("errors.projects.invalidId", 400);
    const expectedRevision = params.get("expectedRevision");
    const expectedMetadataRevision = params.get("expectedMetadataRevision");
    const expectedPackage = params.get("expectedPackage");

    const locked = await withProjectLock(root, projectId, async () => {
      // A conditional delete undoes one write; it spares a copy another client saved since (#672).
      if (expectedRevision !== null || expectedMetadataRevision !== null || expectedPackage !== null) {
        const stored = await readProjectMetadata(root, projectId);
        const changed = (expectedRevision !== null && String(serverProjectRevision(stored)) !== expectedRevision)
          || (expectedMetadataRevision !== null && String(serverMetadataRevision(stored)) !== expectedMetadataRevision)
          || (expectedPackage !== null && packageDigest(await readProjectPackage(root, projectId)) !== expectedPackage);
        if (changed) return errorResponse("errors.projects.changedBeforeSave", 409, { conflict: "changed" });
      }
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
