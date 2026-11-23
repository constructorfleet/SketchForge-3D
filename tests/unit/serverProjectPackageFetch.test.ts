import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerPackageRequestError, ServerProjectConflictError, fetchServerProjectPackage, saveServerProjectPackage } from "@/lib/serverProjectStore";

// Issue #622: a package request that returns no package is storage trouble, not an unreadable copy.
afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(response: Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  }));
}

async function failure() {
  try {
    await fetchServerProjectPackage("project-1");
  } catch (error) {
    return error;
  }
  throw new Error("the request did not fail");
}

describe("server project package request", () => {
  it("returns the bytes of a package response", async () => {
    for (const type of ["application/vnd.sketchforge.project+zip", "application/zip", "application/octet-stream"]) {
      answer(new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { "Content-Type": type } }));
      expect(Array.from((await fetchServerProjectPackage("project-1")).bytes ?? [])).toEqual([80, 75, 3, 4]);
    }
  });

  it("returns no bytes, with the sidecar revision, for a project whose package the server does not hold", async () => {
    answer(new Response("{}", { status: 404, headers: { "Content-Type": "application/json", "X-SketchForge-Revision": "12" } }));
    expect(await fetchServerProjectPackage("project-1")).toEqual({ bytes: null, revision: 12 });
  });

  it("names the status of a failed package request", async () => {
    answer(new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }));
    const error = await failure();
    expect(error).toBeInstanceOf(ServerPackageRequestError);
    expect(error).toMatchObject({ reason: "status", detail: "503" });
  });

  it("treats a request that never reached the server as a network failure", async () => {
    answer(new TypeError("Failed to fetch"));
    expect(await failure()).toMatchObject({ reason: "network", detail: "Failed to fetch" });
  });

  it("refuses a 200 that is not a package, such as a proxy's HTML page", async () => {
    answer(new Response("<html>Sign in</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    expect(await failure()).toMatchObject({ reason: "notPackage", detail: "text/html; charset=utf-8" });
  });
});

// Issue #650: a package write carries the revision its copy was loaded at.
describe("server project package revisions", () => {
  it("reports the sidecar revision a package was served at", async () => {
    answer(new Response(new Uint8Array([80, 75]), {
      status: 200,
      headers: { "Content-Type": "application/vnd.sketchforge.project+zip", "X-SketchForge-Revision": "42" },
    }));
    expect((await fetchServerProjectPackage("project-1")).revision).toBe(42);
  });

  it("leaves the revision unknown when the server does not send one", async () => {
    answer(new Response(new Uint8Array([80, 75]), { status: 200, headers: { "Content-Type": "application/zip" } }));
    expect((await fetchServerProjectPackage("project-1")).revision).toBeUndefined();
  });

  it("sends the base revision with a package write", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await saveServerProjectPackage("project-1", new Uint8Array([1]), 50, 42);
    const body = fetch.mock.calls[0][1]?.body as FormData;
    expect(body.get("revision")).toBe("50");
    expect(body.get("baseRevision")).toBe("42");
  });

  it("sends no base for a write that may replace whatever is stored", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await saveServerProjectPackage("project-1", new Uint8Array([1]), 50);
    expect((fetch.mock.calls[0][1]?.body as FormData).has("baseRevision")).toBe(false);
  });

  it("turns a refusal for a newer stored revision into a conflict carrying that revision", async () => {
    answer(new Response(JSON.stringify({ error: "changed", errorKey: "errors.projects.changedBeforeSave", conflict: "newerRevision", storedRevision: 77 }), { status: 409 }));
    const error = await saveServerProjectPackage("project-1", new Uint8Array([1]), 50, 42).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerProjectConflictError);
    expect(error).toMatchObject({ storedRevision: 77 });
  });

  it("does not call a busy server a conflict", async () => {
    answer(new Response(JSON.stringify({ error: "busy", errorKey: "errors.projects.busySaving" }), { status: 409 }));
    const error = await saveServerProjectPackage("project-1", new Uint8Array([1]), 50, 42).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ServerProjectConflictError);
  });
});
