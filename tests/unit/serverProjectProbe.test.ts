import { afterEach, describe, expect, it, vi } from "vitest";
import { probeServerProjects } from "@/lib/serverProjectStore";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeServerProjects", () => {
  it("gives up on a server that never answers, so the page is not held waiting on it", async () => {
    // A fetch that only ends when its signal aborts, as a hung server would.
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })));
    const outcome = await Promise.race([
      probeServerProjects({ timeoutMs: 20 }).then(() => "answered", () => "gave up"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2000)),
    ]);
    expect(outcome).toBe("gave up");
  });

  it("still reads a listing that arrives in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: true, projects: [] }), { status: 200 })));
    await expect(probeServerProjects({ timeoutMs: 1000 })).resolves.toEqual({ enabled: true, projects: [] });
  });
});
