import { describe, expect, it } from "vitest";
import { SketchForgeApiError, SketchForgeTransportError } from "./errors.js";
import { Transport, buildUrl, normalizeBaseUrl } from "./http.js";
import { fakeServer } from "./testing.js";

function transport(server = fakeServer({ status: 200, body: { ok: true } }), options = {}) {
  return new Transport({ baseUrl: "http://localhost:3100", token: "test-token", fetch: server.fetch, ...options });
}

describe("normalizeBaseUrl", () => {
  it("appends the api prefix to a host", () => {
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/api/v1");
  });

  it("is idempotent, so a base url copied from the docs works either way", () => {
    expect(normalizeBaseUrl("http://localhost:3000/api/v1")).toBe("http://localhost:3000/api/v1");
    expect(normalizeBaseUrl("http://localhost:3000/api/v1/")).toBe("http://localhost:3000/api/v1");
  });

  it("refuses an empty base url rather than requesting a relative path", () => {
    expect(() => normalizeBaseUrl("   ")).toThrow(/baseUrl is required/);
  });
});

describe("buildUrl", () => {
  it("puts ids in the query string, which is where the API takes them", () => {
    expect(buildUrl("http://host/api/v1", "/shapes", { projectId: "p1", shapeId: "s2" })).toBe(
      "http://host/api/v1/shapes?projectId=p1&shapeId=s2",
    );
  });

  it("omits parameters that were not given", () => {
    expect(buildUrl("http://host/api/v1", "/shapes", { projectId: "p1", shapeId: undefined })).toBe(
      "http://host/api/v1/shapes?projectId=p1",
    );
  });

  it("escapes a project id rather than splicing it in raw", () => {
    expect(buildUrl("http://host/api/v1", "/projects", { projectId: "a b&c" })).toContain("projectId=a+b%26c");
  });
});

describe("Transport", () => {
  it("sends the token as a bearer header", async () => {
    const server = fakeServer({ body: { projects: [] } });
    await transport(server).send({ method: "GET", path: "/projects" });
    expect(server.calls[0]?.headers.authorization).toBe("Bearer test-token");
  });

  it("sends a content type only when there is a body", async () => {
    const server = fakeServer({ body: {} });
    const sender = transport(server);
    await sender.send({ method: "GET", path: "/projects" });
    await sender.send({ method: "POST", path: "/projects", body: { name: "Plate" } });
    expect(server.calls[0]?.headers["content-type"]).toBeUndefined();
    expect(server.calls[1]?.headers["content-type"]).toBe("application/json");
    expect(server.calls[1]?.body).toEqual({ name: "Plate" });
  });

  it("raises the server's error message with its status", async () => {
    const server = fakeServer({ status: 422, body: { error: "too large for this shape's edges" } });
    await expect(transport(server).send({ method: "POST", path: "/treatments" })).rejects.toMatchObject({
      status: 422,
      detail: "too large for this shape's edges",
    });
  });

  it("recognises the API being switched off, which also answers 404", async () => {
    const server = fakeServer({ status: 404, body: { error: "The REST API is disabled. Set SKETCHFORGE_API_TOKEN to enable it." } });
    const error = await transport(server)
      .send({ method: "GET", path: "/projects" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SketchForgeApiError);
    expect((error as SketchForgeApiError).looksDisabled).toBe(true);
  });

  it("retries a write that lost the project lock", async () => {
    const server = fakeServer(
      { status: 409, body: { error: "That project is being changed; try again." } },
      { status: 201, body: { shapes: [], revision: 7 } },
    );
    const result = await transport(server).send<{ revision: number }>({ method: "POST", path: "/shapes", retryable: true });
    expect(result.revision).toBe(7);
    expect(server.calls).toHaveLength(2);
  });

  it("does not retry a locked shape, which answers 409 for a different reason", async () => {
    const server = fakeServer({ status: 409, body: { error: "That shape is locked." } });
    await expect(
      transport(server).send({ method: "DELETE", path: "/shapes", retryable: true }),
    ).rejects.toMatchObject({ status: 409 });
    expect(server.calls).toHaveLength(1);
  });

  it("gives up after the configured number of lock retries", async () => {
    const server = fakeServer({ status: 409, body: { error: "That project is being changed; try again." } });
    await expect(
      transport(server, { retryOnBusy: 2 }).send({ method: "POST", path: "/shapes", retryable: true }),
    ).rejects.toMatchObject({ status: 409 });
    expect(server.calls).toHaveLength(3);
  });

  it("reports a connection failure as a transport error rather than a status", async () => {
    const failing = new Transport({
      baseUrl: "http://localhost:3100",
      token: "t",
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(failing.send({ method: "GET", path: "/projects" })).rejects.toBeInstanceOf(SketchForgeTransportError);
  });
});
