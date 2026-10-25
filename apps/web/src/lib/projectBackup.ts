import { unzipSync, zipSync, type Zippable } from "fflate";
import { projectExportFileName } from "@/lib/exportNames";

/**
 * "Export all projects" (issue #333): one ZIP holding each project's `.skf`
 * package. Only the packages go in. Dashboard thumbnails are generated from
 * the shapes and are not part of a project, so they are left out.
 */

export const PROJECTS_BACKUP_MEDIA_TYPE = "application/zip";

export type ProjectBackupEntry = {
  projectName: string;
  /** The project revision; used as the entry's modification time. */
  modifiedAt: number;
  package: Uint8Array;
};

/** ZIP timestamps start in 1980; fflate rejects anything earlier. */
const ZIP_EPOCH = Date.UTC(1980, 0, 2);

/**
 * Windows refuses these as file names, with or without an extension: the
 * classic devices, the console handles, and COM/LPT with a superscript digit.
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const FALLBACK_BASE = projectExportFileName("", "skf").replace(/\.skf$/, "");

/** A base name that extracts on every platform: no leading dot (hidden on Unix) and no Windows device name. */
function portableBaseName(projectName: string) {
  let base = projectExportFileName(projectName, "skf").replace(/\.skf$/, "").replace(/^[. ]+/, "");
  if (!base) base = FALLBACK_BASE;
  // Windows reads "CON.backup.skf" as the CON device too: only the part before the first dot counts.
  return WINDOWS_RESERVED_NAME.test(base.split(".")[0].trim()) ? `_${base}` : base;
}

/** One file name per project, safe on every platform, unique without regard to case. */
export function projectBackupEntryNames(projectNames: string[]): string[] {
  const used = new Set<string>();
  return projectNames.map((projectName) => {
    const base = portableBaseName(projectName);
    let candidate = `${base}.skf`;
    for (let copy = 2; used.has(candidate.toLowerCase()); copy += 1) candidate = `${base} (${copy}).skf`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * Builds the backup archive. Packages are stored, not deflated again: a
 * `.skf` is already compressed, and storing keeps each entry byte-identical.
 */
export function writeProjectsBackup(entries: ProjectBackupEntry[]): Uint8Array {
  const names = projectBackupEntryNames(entries.map((entry) => entry.projectName));
  const files: Zippable = {};
  entries.forEach((entry, index) => {
    const mtime = Number.isFinite(entry.modifiedAt) && entry.modifiedAt > ZIP_EPOCH ? entry.modifiedAt : ZIP_EPOCH;
    files[names[index]] = [entry.package, { level: 0, mtime }];
  });
  return zipSync(files);
}

/** Reads the `.skf` packages back out of a backup archive, in archive order. */
export function readProjectsBackup(bytes: Uint8Array): Array<{ fileName: string; package: Uint8Array }> {
  const files = unzipSync(bytes, { filter: (file) => /\.skf$/i.test(file.name) && !file.name.includes("/") });
  return Object.entries(files).map(([fileName, packageBytes]) => ({ fileName, package: packageBytes }));
}

/**
 * Picks the copy of a project to back up. The in-session copy can hold edits
 * autosave has not written yet, but another tab or a server client may have
 * stored a newer one since; the higher revision wins, as it does in autosave.
 * On a tie the in-session copy is used.
 */
export function newerBackupSource<T extends { revision: number }>(inSession: T | null, stored: T | null): T | null {
  if (!inSession) return stored;
  if (!stored) return inSession;
  return stored.revision > inSession.revision ? stored : inSession;
}

/**
 * The revision to compare a stored copy by. A server package's revision is
 * its `modifiedAt`; when that is missing the load falls back to the current
 * time, which would beat any in-session copy and drop its unsaved edits from
 * the backup. For backup selection a missing time counts as the oldest.
 */
export function storedBackupRevision(record: { revision: number; packageModifiedAt?: number }): number {
  if (!("packageModifiedAt" in record) || record.packageModifiedAt === undefined) return record.revision;
  const modifiedAt = record.packageModifiedAt;
  return Number.isFinite(modifiedAt) && modifiedAt > 0 ? modifiedAt : 0;
}

/** `sketchforge-projects-YYYY-MM-DD.zip`, in local time. */
export function projectsBackupFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `sketchforge-projects-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}
