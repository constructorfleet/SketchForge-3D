import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerPackageRequestError, fetchServerProjectPackage } from "@/lib/serverProjectStore";

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
      expect(Array.from((await fetchServerProjectPackage("project-1")) ?? [])).toEqual([80, 75, 3, 4]);
    }
  });

  it("returns null for a project the server does not hold", async () => {
    answer(new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }));
    expect(await fetchServerProjectPackage("project-1")).toBeNull();
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
