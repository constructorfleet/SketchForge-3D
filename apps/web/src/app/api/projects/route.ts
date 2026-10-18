import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { LocalizedError, errorResponseFields } from "@/i18n/LocalizedError";
import { caughtErrorResponse, errorResponse } from "@/lib/apiErrors";
import {
  SERVER_PROJECTS_ENV,
  safeServerProjectId,
  serverProjectMetadataFileName,
  serverProjectPackageFileName,
  serverProjectWriteIsStale,
  sortedServerProjects,
  type ServerProjectRecord,
} from "@/lib/serverProjectStore";
import { SKF_LIMITS, SKF_MEDIA_TYPE } from "@/lib/skfProject";

export const runtime = "nodejs";
export const revalidate = false;

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

// The same shape as a localStorage project entry, so the dashboard can
// normalise a server record through the path it already has for stored ones.
type ProjectMetadata = Record<string, unknown>;

function projectsDirectory() {
  const configured = process.env[SERVER_PROJECTS_ENV]?.trim();
  return configured ? path.resolve(configured) : null;
}

/** Deliberately duplicated from the shared-projects route, which is byte-identical to upstream's. */
function sameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host") || requestUrl.host;
    const protocol = forwardedProtocol || requestUrl.protocol.replace(/:$/, "");
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

async function regularFileStat(filePath: string) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readMetadata(root: string, projectId: string): Promise<ProjectMetadata | null> {
  const filePath = path.join(root, serverProjectMetadataFileName(projectId));
  if (!(await regularFileStat(filePath))) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ProjectMetadata) : null;
  } catch {
    return null;
  }
}

/** Write through a temporary file in the same directory, so a crash cannot leave a half-written project. */
async function writeFileAtomically(filePath: string, bytes: Uint8Array | string) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function projectRecord(root: string, projectId: string, metadata: ProjectMetadata): Promise<ServerProjectRecord> {
  const packageStat = await regularFileStat(path.join(root, serverProjectPackageFileName(projectId)));
  const metadataStat = await regularFileStat(path.join(root, serverProjectMetadataFileName(projectId)));
  const updatedAt = typeof metadata.updatedAt === "number" && Number.isFinite(metadata.updatedAt)
    ? metadata.updatedAt
    : Math.max(packageStat?.mtimeMs ?? 0, metadataStat?.mtimeMs ?? 0);
  return {
    projectId,
    updatedAt,
    packageBytes: packageStat?.size ?? 0,
    metadata,
  };
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
  const root = projectsDirectory();
  if (!root) return disabledResponse();
  try {
    await fs.mkdir(root, { recursive: true });
    const requestedId = new URL(request.url).searchParams.get("projectId");
    if (requestedId !== null) {
      const projectId = safeServerProjectId(requestedId);
      if (!projectId) return errorResponse("errors.projects.invalidId", 400);
      const filePath = path.join(root, serverProjectPackageFileName(projectId));
      const stat = await regularFileStat(filePath);
      if (!stat) return errorResponse("errors.projects.notFound", 404);
      const bytes = await fs.readFile(filePath);
      return new Response(bytes, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": SKF_MEDIA_TYPE,
        },
      });
    }

    const entries = await fs.readdir(root, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const projectId = safeServerProjectId(entry.name.slice(0, -".json".length));
        if (!projectId) return null;
        const metadata = await readMetadata(root, projectId);
        if (!metadata) return null;
        return projectRecord(root, projectId, metadata);
      }));
    return NextResponse.json(
      { enabled: true, projects: sortedServerProjects(records.filter((record): record is ServerProjectRecord => Boolean(record))) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return caughtErrorResponse(error, "errors.projects.loadFailed", 500, { enabled: true, projects: [] });
  }
}

export async function POST(request: Request) {
  const root = projectsDirectory();
  if (!root) return errorResponse("errors.projects.disabled", 404);
  if (!sameOriginRequest(request)) return errorResponse("errors.projects.sameOrigin", 403);

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > SKF_LIMITS.archiveBytes + MAX_METADATA_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
    return errorResponse("errors.projects.tooLarge", 413);
  }

  let lockHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let lockPath = "";
  try {
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

    await fs.mkdir(root, { recursive: true });
    lockPath = path.join(root, `${projectId}.lock`);
    try {
      lockHandle = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return errorResponse("errors.projects.busySaving", 409);
      throw error;
    }

    const stored = await readMetadata(root, projectId);
    if (serverProjectWriteIsStale(stored, writtenRevision)) {
      return errorResponse("errors.projects.changedBeforeSave", 409);
    }

    if (packageBytes) {
      await writeFileAtomically(path.join(root, serverProjectPackageFileName(projectId)), packageBytes);
    }
    if (metadata) {
      await writeFileAtomically(path.join(root, serverProjectMetadataFileName(projectId)), `${JSON.stringify(metadata, null, 2)}\n`);
    }

    const savedMetadata = metadata ?? stored;
    return NextResponse.json(
      { project: savedMetadata ? await projectRecord(root, projectId, savedMetadata) : null },
      { status: stored ? 200 : 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return caughtErrorResponse(error, "errors.projects.saveFailed", 400);
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => undefined);
    if (lockPath) await fs.unlink(lockPath).catch(() => undefined);
  }
}

export async function DELETE(request: Request) {
  const root = projectsDirectory();
  if (!root) return errorResponse("errors.projects.disabled", 404);
  if (!sameOriginRequest(request)) return errorResponse("errors.projects.sameOrigin", 403);

  let lockHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let lockPath = "";
  try {
    const projectId = safeServerProjectId(new URL(request.url).searchParams.get("projectId") ?? "");
    if (!projectId) return errorResponse("errors.projects.invalidId", 400);

    await fs.mkdir(root, { recursive: true });
    lockPath = path.join(root, `${projectId}.lock`);
    try {
      lockHandle = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return errorResponse("errors.projects.busySaving", 409);
      throw error;
    }

    const metadataPath = path.join(root, serverProjectMetadataFileName(projectId));
    const packagePath = path.join(root, serverProjectPackageFileName(projectId));
    const existed = Boolean(await regularFileStat(metadataPath)) || Boolean(await regularFileStat(packagePath));
    if (!existed) return errorResponse("errors.projects.notFound", 404);

    await Promise.all([metadataPath, packagePath].map((filePath) => fs.unlink(filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
    return NextResponse.json({ deleted: true, projectId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return caughtErrorResponse(error, "errors.projects.deleteFailed", 500);
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => undefined);
    if (lockPath) await fs.unlink(lockPath).catch(() => undefined);
  }
}
