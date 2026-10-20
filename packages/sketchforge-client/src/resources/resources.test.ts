import { describe, expect, it } from "vitest";
import { SketchForgeClient } from "../client.js";
import { fakeServer, type FakeServer } from "../testing.js";
import {
  MAX_SHAPES_PER_REQUEST,
  MEASUREMENT_ANGLE_UNAVAILABLE_CODES,
  MEASUREMENT_RADIUS_UNAVAILABLE_CODES,
  type MeasurementAngleUnavailableCode,
  type MeasurementPair,
  type MeasurementRadiusUnavailableCode,
  type MeasurementSummary,
  type ShapeRequest,
  type ShapeSummary,
} from "../types.js";
import { chunk, shapePatchFromSummary } from "./shapes.js";

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

describe("faces and shell", () => {
  const face = (index: number, facing: string | null) => ({
    index,
    surfaceType: "plane",
    area: 400,
    centroid: { x: 0, y: index, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    facing,
  });

  it("reports the faces pointing a given way, and only the named ones", async () => {
    const server = fakeServer({ body: { faces: [face(0, "top"), face(1, null), face(2, "bottom")] } });
    await expect(client(server).faces.facing("p1", "s1", "top")).resolves.toEqual([0]);
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/faces?projectId=p1&shapeId=s1");
  });

  it("omits openFaces entirely for a sealed hollow", async () => {
    const server = fakeServer({ body: { shape: shapeSummary("s1"), triangles: 24, revision: 5 } });
    await client(server).shell.hollow("p1", "s1", 2);
    // An empty list is not the same request as no list: the server reads a
    // missing one as "seal it", and sending `[]` would say the same thing by
    // accident rather than on purpose.
    expect(server.calls[0]?.body).toEqual({ thickness: 2 });
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/shell?projectId=p1&shapeId=s1");
  });

  it("opens the top by default for a tray, and takes indexes as well as names", async () => {
    const server = fakeServer({ body: { shape: shapeSummary("s1"), triangles: 28, revision: 6 } });
    await client(server).shell.tray("p1", "s1", 2);
    expect(server.calls[0]?.body).toEqual({ thickness: 2, openFaces: ["top"] });

    await client(server).shell.apply("p1", "s1", { thickness: 1.5, openFaces: ["top", 4] });
    expect(server.calls[1]?.body).toEqual({ thickness: 1.5, openFaces: ["top", 4] });
  });
});

describe("measurements", () => {
  const measurement = (overrides: Partial<MeasurementSummary>): MeasurementSummary => ({
    entity: "edge",
    index: 0,
    geometryType: "line",
    length: 10,
    area: null,
    radius: null,
    diameter: null,
    sweepDegrees: null,
    radiusUnavailable: "notCircular",
    ...overrides,
  });

  it("unwraps the listing and keeps what does not apply as null", async () => {
    const server = fakeServer({
      body: {
        measurements: [
          measurement({}),
          measurement({ entity: "face", index: 1, geometryType: "cylinder", length: null, area: 50, radius: 4, diameter: 8, radiusUnavailable: null }),
        ],
      },
    });
    const measurements = await client(server).measurements.list("p1", "s1");
    expect(server.calls[0]?.method).toBe("GET");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/measurements?projectId=p1&shapeId=s1");
    expect(measurements[0]).toMatchObject({ entity: "edge", length: 10, area: null, radiusUnavailable: "notCircular" });
    expect(measurements[1]).toMatchObject({ entity: "face", length: null, area: 50, diameter: 8 });
  });

  it("reports only the entries that carry a radius", async () => {
    const server = fakeServer({
      body: {
        measurements: [
          measurement({ index: 0 }),
          measurement({ index: 1, geometryType: "circle", radius: 3, diameter: 6, sweepDegrees: 360, radiusUnavailable: null }),
          measurement({ entity: "face", index: 2, geometryType: "plane", length: null, area: 400, radiusUnavailable: "notCurved" }),
        ],
      },
    });
    // A radius of 0 would read as a measurement, so the absence of one is the
    // null and not the number; filtering on it is what picks out the bores.
    await expect(client(server).measurements.withRadius("p1", "s1")).resolves.toMatchObject([{ index: 1, radius: 3 }]);
  });

  it("sends both ends of a between request, with no shapeId in the query", async () => {
    const server = fakeServer({ body: { distance: 12.5, angleDegrees: 90, angleUnavailable: null } });
    const pair = await client(server).measurements.between("p1", { shapeId: "s1", entity: "face", index: 2 }, { shapeId: "s2", entity: "face", index: 0 });
    expect(server.calls[0]?.method).toBe("POST");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/measurements?projectId=p1");
    expect(server.calls[0]?.body).toEqual({
      from: { shapeId: "s1", entity: "face", index: 2 },
      to: { shapeId: "s2", entity: "face", index: 0 },
    });
    expect(pair).toEqual({ distance: 12.5, angleDegrees: 90, angleUnavailable: null });
  });

  it("omits entity and index for a whole-shape end, which the server refuses an index with", async () => {
    // Typed as the pair rather than left loose, so the reason codes this field
    // accepts are checked here as well as carried through.
    const apart: MeasurementPair = { distance: 60, angleDegrees: null, angleUnavailable: "notPlanar" };
    const server = fakeServer({ body: apart });
    const pair = await client(server).measurements.between("p1", { shapeId: "s1" }, { shapeId: "s2" });
    expect(server.calls[0]?.body).toEqual({ from: { shapeId: "s1" }, to: { shapeId: "s2" } });
    expect(pair).toEqual(apart);
  });

  it("binds the project id through a handle", async () => {
    const server = fakeServer({ body: { measurements: [measurement({})] } });
    await client(server).project("p9").measurements("s1");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/measurements?projectId=p9&shapeId=s1");
  });

  it("names the two reason sets the server actually draws each field from", () => {
    // The server keeps one union for both, but the derivations are disjoint: a
    // radius is never missing because a face was not planar. Typing each field
    // to its own half is only right while these lists stay as they are.
    expect(MEASUREMENT_RADIUS_UNAVAILABLE_CODES).toEqual([
      "notCircular",
      "ellipseHasNoSingleRadius",
      "degenerateCurve",
      "notCurved",
      "radiusVariesOverSurface",
      "radiusNotReportedByKernel",
      "degenerateSurface",
    ]);
    expect(MEASUREMENT_ANGLE_UNAVAILABLE_CODES).toEqual(["notPlanar", "degenerateNormal"]);
    const overlap = MEASUREMENT_RADIUS_UNAVAILABLE_CODES.filter((code) =>
      (MEASUREMENT_ANGLE_UNAVAILABLE_CODES as readonly string[]).includes(code),
    );
    expect(overlap).toEqual([]);

    // Which set each field draws from, pinned at the type level: a field
    // widened to accept both sets still accepts every value a test could
    // assign it, so only tsc can tell that it was widened.
    type Exactly<Narrow, Wide> = [Narrow] extends [Wide] ? ([Wide] extends [Narrow] ? true : never) : never;
    const radiusFieldIsExact: Exactly<MeasurementSummary["radiusUnavailable"], MeasurementRadiusUnavailableCode | null> = true;
    const angleFieldIsExact: Exactly<MeasurementPair["angleUnavailable"], MeasurementAngleUnavailableCode | null> = true;
    expect([radiusFieldIsExact, angleFieldIsExact]).toEqual([true, true]);
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

describe("shapePatchFromSummary", () => {
  it("carries every parameter through, so a change to one keeps the rest", () => {
    const summary: ShapeSummary = { ...shapeSummary("s1"), kind: "cylinder", requestKind: "cylinder", sides: 12, bevel: 2 };
    expect(shapePatchFromSummary(summary, { sides: 6 })).toMatchObject({ sides: 6, bevel: 2, width: 1, name: "s1" });
  });

  it("drops what describes the shape rather than setting anything on it", () => {
    const summary: ShapeSummary = { ...shapeSummary("s1"), requestKind: "box", sketchOperation: "revolve", groupedCount: 2 };
    const patch = shapePatchFromSummary(summary);
    expect(patch).not.toHaveProperty("id");
    expect(patch).not.toHaveProperty("kind");
    expect(patch).not.toHaveProperty("requestKind");
    expect(patch).not.toHaveProperty("sketchOperation");
    expect(patch).not.toHaveProperty("groupedCount");
  });

  it("keeps a sweep nested where the server accepts it", () => {
    const revolve = { startAngle: 0, sweepAngle: 360, sides: 64, quality: 6, pitch: 1.25, turns: 4, coreRadius: 3 };
    const summary: ShapeSummary = { ...shapeSummary("s1"), kind: "mesh", requestKind: "revolve", revolve, profile: [[3, 0], [4, 1], [3, 2]] };
    expect(shapePatchFromSummary(summary, { revolve: { ...revolve, pitch: 2 } })).toMatchObject({
      revolve: { pitch: 2, turns: 4 },
      profile: [[3, 0], [4, 1], [3, 2]],
    });
  });
});
