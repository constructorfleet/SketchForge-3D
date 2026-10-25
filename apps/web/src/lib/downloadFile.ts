import { LocalizedError } from "@/i18n";

export type DownloadResult = { mode: "browser" } | { mode: "folder"; path: string };

export type DownloadTarget = {
  /** "folder" writes through `/api/local-download`; only a server build has that route. */
  mode: "browser" | "folder";
  folder: string;
  localDownloadAvailable: boolean;
};

/**
 * Saves a file the way the dashboard's download setting says: into the chosen
 * server folder, or as an ordinary browser download.
 */
export async function downloadBlob(filename: string, blob: Blob, target: DownloadTarget): Promise<DownloadResult> {
  const folder = target.folder.trim();
  if (target.localDownloadAvailable && target.mode === "folder" && folder) {
    const formData = new FormData();
    formData.set("file", blob, filename);
    formData.set("filename", filename);
    formData.set("folder", folder);
    const response = await fetch("/api/local-download", { method: "POST", body: formData });
    const payload = (await response.json().catch(() => null)) as { error?: string; path?: string } | null;
    if (!response.ok || !payload?.path) throw payload?.error ? new Error(payload.error) : new LocalizedError("errors.editor.saveExport");
    return { mode: "folder", path: payload.path };
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { mode: "browser" };
}
