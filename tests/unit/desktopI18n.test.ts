import { describe, expect, it, vi } from "vitest";
import desktopI18nModule from "../../apps/desktop/i18n.cjs";
import enDesktop from "@/i18n/locales/en/desktop.json";
import ruDesktop from "@/i18n/locales/ru/desktop.json";

const { createDesktopI18n } = desktopI18nModule;

describe("desktop main-process i18n", () => {
  it("reads the web catalogs and resolves the OS language", () => {
    const i18n = createDesktopI18n();
    expect(i18n.resolveLocale(["ru-RU", "en-US"])).toBe("ru");
    expect(i18n.resolveLocale(["ja-JP"])).toBe("en");
    expect(i18n.resolveLocale(["pt-BR"])).toBe("pt");
    expect(i18n.resolveLocale(["cs-CZ", "en"])).toBe("cs");
    expect(i18n.setLocale("ru")).toBe(true);
    expect(i18n.t("desktop.tray.quit")).toBe(ruDesktop.desktop.tray.quit);
    expect(i18n.t("desktop.updates.available", { version: "2.0.0" })).toContain("2.0.0");
  });

  it("only loads catalogs for plain language codes", () => {
    const load = vi.fn((locale: string) => (locale === "en" ? enDesktop : null));
    const i18n = createDesktopI18n(load);
    for (const code of ["../../../etc/passwd", "en/../../x", "", null, 42, "toolong"]) {
      expect(i18n.setLocale(code)).toBe(false);
    }
    expect(load.mock.calls.every(([locale]) => /^[a-z]{2,3}$/.test(locale))).toBe(true);
    expect(i18n.getLocale()).toBe("en");
  });

  it("reports a change only when the language actually changes", () => {
    const i18n = createDesktopI18n();
    expect(i18n.setLocale("en")).toBe(false);
    expect(i18n.setLocale("ru-RU")).toBe(true);
    expect(i18n.setLocale("ru")).toBe(false);
    expect(i18n.setLocale("xx")).toBe(false);
    expect(i18n.getLocale()).toBe("ru");
  });

  it("falls back to English for keys a language lacks", () => {
    const i18n = createDesktopI18n((locale) => (locale === "en" ? { a: { b: "Hello {name}" } } : locale === "xx" ? {} : null));
    i18n.setLocale("xx");
    expect(i18n.t("a.b", { name: "Ann" })).toBe("Hello Ann");
    expect(i18n.t("missing.key")).toBe("missing.key");
  });
});
