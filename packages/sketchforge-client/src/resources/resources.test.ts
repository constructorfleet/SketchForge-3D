import { describe, expect, it } from "vitest";
import { SketchForgeClient } from "../client.js";
import { fakeServer, type FakeServer } from "../testing.js";
import { MAX_SHAPES_PER_REQUEST, type ShapeRequest } from "../types.js";
import { chunk } from "./shapes.js";

function client(server: FakeServer) {
  return new SketchForgeClient({ baseUrl: "http://localhost:3100", token: "t", fetch: server.fetch });
}

function shapeSummary(id: string) {
  return { id, name: id, kind: "box", color: "#fff", hole: false, locked: false, hidden: false, x: 0, z: 0, elevation: 0, width: 1, depth: 1, height: 1, rotation: 0, rotationX: 0, rotationZ: 0 };
}

describe("chunk", () => {
  it("splits into runs of at most the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("leaves a short list in one piece", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("refuses a size of zero rather than looping forever", () => {
    expect(() => chunk([1], 0)).toThrow(/at least 1/);
  });
});

describe("projects", () => {
  it("unwraps the list", async () => {
    const server = fakeServer({ body: { projects: [{ id: "p1", name: "Plate", shapes: 2, revision: 1, updatedAt: 0, packageBytes: 0 }] } });
    await expect(client(server).projects.list()).resolves.toHaveLength(1);
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/projects");
  });

  it("asks for one project by query parameter", async () => {
    const server = fakeServer({ body: { project: { id: "p1", name: "Plate", createdAt: 0, snapGrid: {}, workspace: {}, shapes: [] } } });
    await client(server).projects.get("p1");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/projects?projectId=p1");
  });

  it("matches a project by name without assuming the server indexes names", async () => {
    const server = fakeServer({
      body: {
        projects: [
          { id: "p1", name: "Other", shapes: 0, revision: 1, updatedAt: 0, packageBytes: 0 },
          { id: "p2", name: "Plate", shapes: 0, revision: 1, updatedAt: 0, packageBytes: 0 },
        ],
      },
    });
    await expect(client(server).projects.findByName("Plate")).resolves.toMatchObject({ id: "p2" });
    await expect(client(server).projects.findByName("Missing")).resolves.toBeNull();
  });
});

describe("shapes", () => {
  it("returns the created shape rather than the envelope", async () => {
    const server = fakeServer({ status: 201, body: { shapes: [shapeSummary("s1")], revision: 3 } });
    await expect(client(server).shapes.create("p1", { kind: "box", width: 10 })).resolves.toMatchObject({ id: "s1" });
    expect(server.calls[0]?.body).toEqual({ kind: "box", width: 10 });
  });

  it("sends a batch as one request under the server's limit", async () => {
    const server = fakeServer({ status: 201, body: { shapes: [shapeSummary("s1")], revision: 3 } });
    const shapes: ShapeRequest[] = Array.from({ length: 5 }, () => ({ kind: "cylinder", width: 8 }));
    await client(server).shapes.createMany("p1", shapes);
    expect(server.calls).toHaveLength(1);
    expect((server.calls[0]?.body as { shapes: unknown[] }).shapes).toHaveLength(5);
  });

  it("splits a batch longer than the server accepts", async () => {
    const server = fakeServer({ status: 201, body: { shapes: [shapeSummary("s1")], revision: 3 } });
    const shapes: ShapeRequest[] = Array.from({ length: MAX_SHAPES_PER_REQUEST + 1 }, () => ({ kind: "box" }));
    const written = await client(server).shapes.createMany("p1", shapes);
    expect(server.calls).toHaveLength(2);
    expect((server.calls[0]?.body as { shapes: unknown[] }).shapes).toHaveLength(MAX_SHAPES_PER_REQUEST);
    expect((server.calls[1]?.body as { shapes: unknown[] }).shapes).toHaveLength(1);
    expect(written.shapes).toHaveLength(2);
  });

  it("writes nothing for an empty batch", async () => {
    const server = fakeServer({ status: 201, body: {} });
    await expect(client(server).shapes.createMany("p1", [])).resolves.toEqual({ shapes: [], revision: 0 });
    expect(server.calls).toHaveLength(0);
  });

  it("unlocks a locked shape before deleting it, because a locked one refuses", async () => {
    const server = fakeServer(
      { body: { shapes: [{ ...shapeSummary("s1"), locked: true }] } },
      { body: { shape: shapeSummary("s1"), revision: 2 } },
      { body: { deleted: true, id: "s1" } },
    );
    await client(server).shapes.deleteAll("p1");
    expect(server.calls.map((call) => call.method)).toEqual(["GET", "PATCH", "DELETE"]);
    expect(server.calls[1]?.body).toEqual({ locked: false });
  });
});

describe("edges and treatments", () => {
  it("reports only the edges a treatment can act on", async () => {
    const edge = (index: number, filletable: boolean) => ({ index, length: 10, curveType: "line", midpoint: { x: 0, y: 0, z: 0 }, filletable });
    const server = fakeServer({ body: { edges: [edge(0, true), edge(1, false), edge(2, true)] } });
    await expect(client(server).edges.filletableIndexes("p1", "s1")).resolves.toEqual([0, 2]);
  });

  it("omits angle and edges when a fillet does not name them", async () => {
    const server = fakeServer({ body: { shape: shapeSummary("s1"), triangles: 100, revision: 4 } });
    await client(server).treatments.fillet("p1", "s1", 3);
    expect(server.calls[0]?.body).toEqual({ kind: "fillet", amount: 3 });
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/treatments?projectId=p1&shapeId=s1");
  });

  it("passes a chamfer's angle and edge list through", async () => {
    const server = fakeServer({ body: { shape: shapeSummary("s1"), triangles: 100, revision: 4 } });
    await client(server).treatments.chamfer("p1", "s1", 2, { angle: 30, edges: [0, 1] });
    expect(server.calls[0]?.body).toEqual({ kind: "chamfer", amount: 2, angle: 30, edges: [0, 1] });
  });
});

describe("check", () => {
  it("names the missing server configuration rather than echoing a status", async () => {
    const server = fakeServer({ status: 503, body: { error: "needs server-side project storage" } });
    await expect(client(server).check()).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("SKETCHFORGE_PROJECTS_DIR") });
  });

  it("counts the projects when the API is working", async () => {
    const server = fakeServer({ body: { projects: [{ id: "p1", name: "a", shapes: 0, revision: 0, updatedAt: 0, packageBytes: 0 }] } });
    await expect(client(server).check()).resolves.toEqual({ ok: true, projects: 1 });
  });
});
