import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServerMetadataConflictError,
  ServerPackageRequestError,
  ServerProjectConflictError,
  ServerProjectDeletedError,
  deleteServerProject,
  fetchServerProjectPackage,
  saveServerProjectMetadata,
  saveServerProjectPackage,
} from "@/lib/serverProjectStore";

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

describe("server project metadata writes", () => {
  it("sends the metadata revision the list was read at", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await saveServerProjectMetadata("project-1", { name: "Bracket" }, 3);
    expect((fetch.mock.calls[0][1]?.body as FormData).get("baseMetadataRevision")).toBe("3");
  });

  it("turns a refusal for newer metadata into a metadata conflict", async () => {
    answer(new Response(JSON.stringify({ errorKey: "errors.projects.changedBeforeSave", conflict: "newerMetadata", storedMetadataRevision: 5 }), { status: 409 }));
    const error = await saveServerProjectMetadata("project-1", { name: "Bracket" }, 3).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerMetadataConflictError);
    expect(error).not.toBeInstanceOf(ServerProjectConflictError);
  });
});

// Issue #672: the server refuses a based metadata write once the project is deleted.
describe("server project writes after a delete", () => {
  const deleted = () => new Response(JSON.stringify({ errorKey: "errors.projects.notFound", conflict: "deleted" }), { status: 410 });

  it("turns the refusal of a metadata write into a deleted-project error", async () => {
    answer(deleted());
    expect(await saveServerProjectMetadata("project-1", { name: "Bracket" }, 3).catch((caught: unknown) => caught)).toBeInstanceOf(ServerProjectDeletedError);
  });
});

// Issue #662: the server refuses one client's overlapping package and metadata writes as busy.
describe("server project writes while another write holds the project", () => {
  function busyThenSaved(busyCount: number) {
    let calls = 0;
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      calls += 1;
      return calls <= busyCount
        ? new Response(JSON.stringify({ error: "busy", errorKey: "errors.projects.busySaving" }), { status: 409 })
        : new Response(JSON.stringify({ project: { projectId: "project-1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("sends a package again once the project is free", async () => {
    const fetch = busyThenSaved(2);
    await expect(saveServerProjectPackage("project-1", new Uint8Array([1]), 50, 42)).resolves.toMatchObject({ project: { projectId: "project-1" } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((fetch.mock.calls[2][1]?.body as FormData).get("revision")).toBe("50");
  });

  it("sends metadata again once the project is free", async () => {
    const fetch = busyThenSaved(1);
    await expect(saveServerProjectMetadata("project-1", { name: "Bracket" }, 3)).resolves.toMatchObject({ project: { projectId: "project-1" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not send again a write refused for any other reason", async () => {
    for (const body of [
      { error: "changed", errorKey: "errors.projects.changedBeforeSave", conflict: "newerRevision", storedRevision: 77 },
      { error: "changed", errorKey: "errors.projects.changedBeforeSave", conflict: "newerMetadata" },
      { error: "nope", errorKey: "errors.projects.saveFailed" },
    ]) {
      const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 409 }));
      vi.stubGlobal("fetch", fetch);
      await saveServerProjectPackage("project-1", new Uint8Array([1]), 50, 42).catch(() => undefined);
      expect(fetch, body.errorKey).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up on a project that stays busy", async () => {
    const fetch = busyThenSaved(Number.POSITIVE_INFINITY);
    const error = await saveServerProjectPackage("project-1", new Uint8Array([1]), 50, 42).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ key: "errors.projects.busySaving" });
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
});

// Issue #672: a re-delete names what the late write stored, so it spares a copy saved since.
describe("server project deletes", () => {
  const busy = () => new Response(JSON.stringify({ error: "busy", errorKey: "errors.projects.busySaving" }), { status: 409 });

  it("reports what a write stored", async () => {
    answer(new Response(JSON.stringify({ project: null, stored: { revision: 0, metadataRevision: 0, package: "abc" } }), { status: 201 }));
    expect((await saveServerProjectPackage("project-1", new Uint8Array([1]), 50, 42)).stored).toEqual({ revision: 0, metadataRevision: 0, package: "abc" });
  });

  it("sends the stored state a delete is conditional on", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await deleteServerProject("project-1", { revision: 3, metadataRevision: 4, package: "abc" })).toBe(true);
    const query = new URL(fetch.mock.calls[0][0], "http://localhost").searchParams;
    expect([query.get("expectedRevision"), query.get("expectedMetadataRevision"), query.get("expectedPackage")]).toEqual(["3", "4", "abc"]);
  });

  it("leaves a project that changed since alone, without an error", async () => {
    answer(new Response(JSON.stringify({ errorKey: "errors.projects.changedBeforeSave", conflict: "changed" }), { status: 409 }));
    expect(await deleteServerProject("project-1", { revision: 3, metadataRevision: 4 })).toBe(false);
  });

  it("sends a delete again once the project is free", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => (calls++ < 2 ? busy() : new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    expect(await deleteServerProject("project-1")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
