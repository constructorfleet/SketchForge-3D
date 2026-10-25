import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import desktopI18nModule from "../../apps/desktop/i18n.cjs";
import desktopPortModule from "../../apps/desktop/port.cjs";

const { createDesktopI18n } = desktopI18nModule;
const {
  DEFAULT_DESKTOP_PORT,
  DESKTOP_PORT_VARIABLE,
  assertPortAvailable,
  listenFailure,
  listenFailureMessage,
  portFallbackMessage,
  resolveDesktopPort,
} = desktopPortModule;

const desktopDir = path.resolve(__dirname, "..", "..", "apps", "desktop");

describe("resolveDesktopPort", () => {
  it("defaults to 62158 without a warning when the variable is unset or blank", () => {
    const warn = vi.fn();
    expect(DEFAULT_DESKTOP_PORT).toBe(62158);
    expect(resolveDesktopPort(undefined, warn)).toBe(62158);
    expect(resolveDesktopPort("", warn)).toBe(62158);
    expect(resolveDesktopPort("   ", warn)).toBe(62158);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts every port from 1 to 65535, with surrounding whitespace", () => {
    const warn = vi.fn();
    expect(resolveDesktopPort("1", warn)).toBe(1);
    expect(resolveDesktopPort("8080", warn)).toBe(8080);
    expect(resolveDesktopPort(" 62159\n", warn)).toBe(62159);
    expect(resolveDesktopPort("65535", warn)).toBe(65535);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["not a number", "abc"],
    ["zero, which asks the OS for a random port and so a new origin each launch", "0"],
    ["above the port range", "65536"],
    ["negative", "-1"],
    ["fractional", "8080.5"],
    ["trailing garbage that parseInt would accept", "8080abc"],
    ["exponent notation", "1e4"],
    ["hexadecimal", "0x1F90"],
  ])("falls back to 62158 and warns when the value is %s", (_label, value) => {
    const warn = vi.fn();
    expect(resolveDesktopPort(value, warn)).toBe(62158);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    // The fallback changes the storage origin, so the warning must say what was ignored and what is used instead.
    expect(message).toContain(DESKTOP_PORT_VARIABLE);
    expect(message).toContain(JSON.stringify(value));
    expect(message).toContain("62158");
  });
});

describe("listenFailure", () => {
  it("recognises a busy port from the error code and from the web process's stderr", () => {
    expect(listenFailure(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }))).toBe("inUse");
    expect(listenFailure("Error: listen EADDRINUSE: address already in use 127.0.0.1:62158\n    at Server.setupListenHandle")).toBe("inUse");
  });

  it("recognises a port the user may not listen on", () => {
    expect(listenFailure(Object.assign(new Error("listen EACCES"), { code: "EACCES" }))).toBe("accessDenied");
    expect(listenFailure("Error: listen EACCES: permission denied 127.0.0.1:80")).toBe("accessDenied");
  });

  it("ignores other failures", () => {
    expect(listenFailure(Object.assign(new Error("listen EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" }))).toBeNull();
    expect(listenFailure("SyntaxError: Unexpected token")).toBeNull();
    expect(listenFailure("")).toBeNull();
    expect(listenFailure(null)).toBeNull();
    expect(listenFailure(undefined)).toBeNull();
  });
});

describe("assertPortAvailable", () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function occupyPort() {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as net.AddressInfo).port;
  }

  it("rejects with EADDRINUSE when another program holds the port", async () => {
    const port = await occupyPort();
    await expect(assertPortAvailable(port, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("resolves and releases the port when it is free", async () => {
    const port = await occupyPort();
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(assertPortAvailable(port, "127.0.0.1")).resolves.toBeUndefined();
    // The probe must not keep the port, or the web process could not take it.
    await expect(assertPortAvailable(port, "127.0.0.1")).resolves.toBeUndefined();
  });
});

describe("localized port messages", () => {
  const locales = fs.readdirSync(path.resolve(desktopDir, "..", "web", "src", "i18n", "locales"));
  const messages = {
    inUse: (t: Parameters<typeof listenFailureMessage>[0]) => listenFailureMessage(t, "inUse", 41234),
    accessDenied: (t: Parameters<typeof listenFailureMessage>[0]) => listenFailureMessage(t, "accessDenied", 41234),
  };

  function translatorFor(locale: string) {
    const i18n = createDesktopI18n();
    i18n.setLocale(locale);
    return i18n.t;
  }

  describe.each(Object.entries(messages))("%s", (_kind, build) => {
    it.each(locales)("names the port and the variable in %s", (locale) => {
      const message = build(translatorFor(locale));
      expect(message).not.toMatch(/^desktop\./);
      expect(message).toContain("41234");
      expect(message).toContain(DESKTOP_PORT_VARIABLE);
      expect(message).not.toMatch(/\{\w+\}/);
    });

    it("is translated rather than English in every other locale", () => {
      const english = build(translatorFor("en"));
      for (const locale of locales.filter((code) => code !== "en")) expect(build(translatorFor(locale)), locale).not.toBe(english);
    });
  });

  describe("the fallback notice", () => {
    it.each(locales)("names the rejected value, the fallback port and the variable in %s", (locale) => {
      const t = translatorFor(locale);
      const notice = portFallbackMessage(t, "80{port}80");
      expect(notice.title).not.toMatch(/^desktop\./);
      expect(notice.message).not.toMatch(/^desktop\./);
      // A value that looks like a placeholder is shown as typed, not substituted.
      expect(notice.message).toContain("80{port}80");
      expect(notice.message).toContain(String(DEFAULT_DESKTOP_PORT));
      expect(notice.message).toContain(DESKTOP_PORT_VARIABLE);
      expect(notice.message.replace("80{port}80", "")).not.toMatch(/\{\w+\}/);
    });

    it("is translated rather than English in every other locale", () => {
      const english = portFallbackMessage(translatorFor("en"), "abc");
      for (const locale of locales.filter((code) => code !== "en")) {
        const notice = portFallbackMessage(translatorFor(locale), "abc");
        expect(notice.title, locale).not.toBe(english.title);
        expect(notice.message, locale).not.toBe(english.message);
      }
    });
  });
});
