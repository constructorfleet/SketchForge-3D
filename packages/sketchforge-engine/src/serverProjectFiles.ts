/**
 * The project directory on disk (upstream issues #109 and #55).
 *
 * Node-only: import this from route handlers, never from anything the browser
 * bundles. `serverProjectStore` holds the parts both sides share.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  SERVER_PROJECTS_ENV,
  safeServerProjectId,
  serverProjectMetadataFileName,
  serverProjectPackageFileName,
  sortedServerProjects,
  type ServerProjectRecord,
} from "./support/lib/serverProjectStore.js";

export type ProjectMetadata = Record<string, unknown>;

export function projectsDirectory() {
  const configured = process.env[SERVER_PROJECTS_ENV]?.trim();
  return configured ? path.resolve(configured) : null;
}

export async function ensureProjectsDirectory() {
  const root = projectsDirectory();
  if (!root) return null;
  await fs.mkdir(root, { recursive: true });
  return root;
}

/** A stat for a real file, or null. A symlink is not a real file here: it could point anywhere. */
export async function regularFileStat(filePath: string) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Write through a temporary file in the same directory, so a crash cannot leave a half-written project. */
export async function writeFileAtomically(filePath: string, bytes: Uint8Array | string) {
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

/**
 * Hold a project for the duration of `work`, or report it busy.
 *
 * An exclusive create is the lock: whoever makes the file owns the project
 * until it is removed, which keeps two writers from interleaving a metadata
 * and a package write on the same project.
 */
export async function withProjectLock<T>(root: string, projectId: string, work: () => Promise<T>): Promise<{ busy: true } | { busy: false; result: T }> {
  const lockPath = path.join(root, `${projectId}.lock`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { busy: true };
    throw error;
  }
  try {
    return { busy: false, result: await work() };
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export function projectMetadataPath(root: string, projectId: string) {
  return path.join(root, serverProjectMetadataFileName(projectId));
}

export function projectPackagePath(root: string, projectId: string) {
  return path.join(root, serverProjectPackageFileName(projectId));
}

export async function readProjectMetadata(root: string, projectId: string): Promise<ProjectMetadata | null> {
  const filePath = projectMetadataPath(root, projectId);
  if (!(await regularFileStat(filePath))) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ProjectMetadata) : null;
  } catch {
    return null;
  }
}

export async function writeProjectMetadata(root: string, projectId: string, metadata: ProjectMetadata) {
  await writeFileAtomically(projectMetadataPath(root, projectId), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function readProjectPackage(root: string, projectId: string) {
  const filePath = projectPackagePath(root, projectId);
  if (!(await regularFileStat(filePath))) return null;
  return new Uint8Array(await fs.readFile(filePath));
}

export async function writeProjectPackage(root: string, projectId: string, bytes: Uint8Array) {
  await writeFileAtomically(projectPackagePath(root, projectId), bytes);
}

export async function deleteProjectFiles(root: string, projectId: string) {
  const paths = [projectMetadataPath(root, projectId), projectPackagePath(root, projectId)];
  const existed = (await Promise.all(paths.map(regularFileStat))).some(Boolean);
  await Promise.all(paths.map((filePath) => fs.unlink(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  })));
  return existed;
}

export async function projectRecord(root: string, projectId: string, metadata: ProjectMetadata): Promise<ServerProjectRecord> {
  const packageStat = await regularFileStat(projectPackagePath(root, projectId));
  const metadataStat = await regularFileStat(projectMetadataPath(root, projectId));
  const updatedAt = typeof metadata.updatedAt === "number" && Number.isFinite(metadata.updatedAt)
    ? metadata.updatedAt
    : Math.max(packageStat?.mtimeMs ?? 0, metadataStat?.mtimeMs ?? 0);
  return { projectId, updatedAt, packageBytes: packageStat?.size ?? 0, metadata };
}

/** Every project the directory holds, newest first. A project exists once its metadata sidecar does. */
export async function listProjectRecords(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const records = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const projectId = safeServerProjectId(entry.name.slice(0, -".json".length));
      if (!projectId) return null;
      const metadata = await readProjectMetadata(root, projectId);
      if (!metadata) return null;
      return projectRecord(root, projectId, metadata);
    }));
  return sortedServerProjects(records.filter((record): record is ServerProjectRecord => Boolean(record)));
}
