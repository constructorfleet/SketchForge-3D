import type { MessageKey } from "@/i18n/locales";
import { notice, type Notice } from "@/i18n/notice";
import { errorText } from "@/i18n/translator";
import { SKF_MEDIA_TYPE } from "@/lib/engine/skfProject";
import type { DesktopProjectFile } from "@/types/desktop";

/**
 * Turn a project file the desktop shell delivered into the `File` the
 * dashboard's `.skf` import already takes, or the message to show instead.
 * Validation of the package itself stays with `importSkfProject`.
 */
export function desktopProjectFileToFile(payload: DesktopProjectFile): { file: File } | { errorKey: MessageKey } {
  if (payload && "error" in payload && payload.error === "tooLarge") return { errorKey: "errors.skf.archiveTooLarge" };
  if (!payload || typeof payload.fileName !== "string" || !("bytes" in payload) || !(payload.bytes instanceof Uint8Array)) {
    return { errorKey: "dashboard.open.failed" };
  }
  return { file: new File([payload.bytes as Uint8Array<ArrayBuffer>], payload.fileName, { type: SKF_MEDIA_TYPE }) };
}

/**
 * Open a file the desktop shell delivered and report each step through
 * `show`, in the same order as the editor's own `.skf` import: a validating
 * notice, then whatever the import returns. Nothing is thrown, so one bad
 * file cannot stop the files queued behind it.
 */
export async function openDesktopProjectFile(
  payload: DesktopProjectFile,
  host: { open: (file: File) => Promise<{ ok: boolean; message: Notice } | void>; show: (value: Notice) => void },
): Promise<void> {
  const result = desktopProjectFileToFile(payload);
  if ("errorKey" in result) {
    const { errorKey } = result;
    host.show(notice((t) => t(errorKey)));
    return;
  }
  const { file } = result;
  host.show(notice((t) => t("editor.import.validatingSkf", { name: file.name })));
  try {
    const opened = await host.open(file);
    if (opened?.message) host.show(opened.message);
  } catch (error) {
    host.show(notice((t) => errorText(t, error, "dashboard.open.failed")));
  }
}
