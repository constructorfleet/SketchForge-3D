import { describe, expect, it, vi } from "vitest";
import { englishNotice, notice, type Notice } from "@/i18n/notice";
import { desktopProjectFileToFile, openDesktopProjectFile } from "@/lib/desktopProjectFile";
import { SKF_MEDIA_TYPE } from "@/lib/engine/skfProject";

describe("openDesktopProjectFile", () => {
  function harness(open: (file: File) => Promise<{ ok: boolean; message: Notice } | void>) {
    const shown: string[] = [];
    const openSpy = vi.fn(open);
    return { shown, open: openSpy, show: (value: Notice) => shown.push(englishNotice(value)) };
  }

  it("shows the validating notice, then the result the import returns, as the editor's own .skf import does", async () => {
    const h = harness(async (file) => ({ ok: true, message: notice((t) => t("dashboard.open.opened", { fileName: file.name })) }));
    await openDesktopProjectFile({ fileName: "Bracket.skf", bytes: new Uint8Array([1]) }, h);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.shown).toEqual([
      "Validating Bracket.skf before opening it as a new project",
      "Opened Bracket.skf as a new editable local project",
    ]);
  });

  it("shows a failed import's message instead of dropping it", async () => {
    const h = harness(async () => ({ ok: false, message: notice((t) => t("errors.skf.notPackage")) }));
    await openDesktopProjectFile({ fileName: "Broken.skf", bytes: new Uint8Array([1]) }, h);
    expect(h.shown.at(-1)).toBe(".skf file is not a valid package");
  });

  it("reports a file the shell could not deliver without trying to import it", async () => {
    const h = harness(async () => undefined);
    await openDesktopProjectFile({ fileName: "Huge.skf", error: "tooLarge" }, h);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.shown).toEqual([".skf file exceeds the 512 MB archive limit"]);
  });

  it("reports an import that throws rather than letting it escape", async () => {
    const h = harness(async () => {
      throw new Error("disk vanished");
    });
    await expect(openDesktopProjectFile({ fileName: "x.skf", bytes: new Uint8Array([1]) }, h)).resolves.toBeUndefined();
    expect(h.shown.at(-1)).toBe("disk vanished");
  });
});

describe("desktopProjectFileToFile", () => {
  it("wraps the bytes the main process read as an .skf File for the dashboard import path", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9]);
    const result = desktopProjectFileToFile({ fileName: "Bracket.skf", bytes });
    expect("file" in result).toBe(true);
    if (!("file" in result)) return;
    expect(result.file.name).toBe("Bracket.skf");
    expect(result.file.type).toBe(SKF_MEDIA_TYPE);
    expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(bytes);
  });

  it("reports a file over the archive limit with the engine's message", () => {
    expect(desktopProjectFileToFile({ fileName: "Huge.skf", error: "tooLarge" })).toEqual({ errorKey: "errors.skf.archiveTooLarge" });
  });

  it("reports an unreadable or malformed delivery as a failed open", () => {
    expect(desktopProjectFileToFile({ fileName: "Gone.skf", error: "unreadable" })).toEqual({ errorKey: "dashboard.open.failed" });
    expect(desktopProjectFileToFile({ fileName: "x.skf" } as never)).toEqual({ errorKey: "dashboard.open.failed" });
    expect(desktopProjectFileToFile(null as never)).toEqual({ errorKey: "dashboard.open.failed" });
  });
});
