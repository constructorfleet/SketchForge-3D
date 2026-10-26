import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SketchForgeClient } from "../client.js";
import { fakeServer, type FakeServer, type StubResponse } from "../testing.js";
import {
  EXPORT_VIEWS,
  MAX_SHAPES_PER_REQUEST,
  PROJECT_EXPORT_FORMATS,
  MEASUREMENT_ANGLE_UNAVAILABLE_CODES,
  MEASUREMENT_RADIUS_UNAVAILABLE_CODES,
  type MeasurementAngleUnavailableCode,
  type MeasurementPair,
  type MeasurementRadiusUnavailableCode,
  type MeasurementSummary,
  type ShapeRequest,
  type ShapeSummary,
  type SketchFaceDraft,
  type SketchSweepProfile,
} from "../types.js";
import { base64ToBytes } from "./exports.js";
import { meshBytesToBase64 } from "./imports.js";
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

describe("retained face draft patches", () => {
  it("sends a selected source face, angle, and signed pull axis", async () => {
    const draft: SketchFaceDraft = { sourceFaceId: "face_shape_1", angle: 5, pullDirection: "-z" };
    const server = fakeServer({ status: 200, body: { shape: { ...shapeSummary("s1"), faceDraft: draft }, revision: 2 } });

    await client(server).shapes.update("p1", "sketch/s1", { faceDraft: draft });

    expect(server.calls[0]?.body).toEqual({ faceDraft: draft });
  });
});

describe("projects", () => {
  it("recognizes the new and legacy limit error codes", async () => {
    const current = fakeServer({ status: 413, body: { error: "limit reached", code: "limit_exceeded" } });
    await expect(client(current).projects.list()).rejects.toMatchObject({ isLimitExceeded: true });
    const legacy = fakeServer({ status: 413, body: { error: "too many shapes", code: "too_many_shapes" } });
    await expect(client(legacy).projects.list()).rejects.toMatchObject({ isLimitExceeded: true });
  });

  it("unwraps the list", async () => {
    const server = fakeServer({ body: { projects: [{ id: "p1", name: "Plate", shapes: 2, revision: 1, updatedAt: 0, packageBytes: 0 }] } });
    await expect(client(server).projects.list()).resolves.toHaveLength(1);
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/projects");
  });

  it("returns a project page and forwards its cursor", async () => {
    const server = fakeServer({ body: { projects: [], nextCursor: "Mg" } });
    await expect(client(server).projects.listPage({ limit: 2, cursor: "MQ" })).resolves.toEqual({ items: [], nextCursor: "Mg" });
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/projects?limit=2&cursor=MQ");
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
  it("returns a shape page and forwards its cursor", async () => {
    const server = fakeServer({ body: { shapes: [], nextCursor: null } });
    await expect(client(server).shapes.listPage("p1", { limit: 25, cursor: "MQ" })).resolves.toEqual({ items: [], nextCursor: null });
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/shapes?projectId=p1&limit=25&cursor=MQ");
  });

  it("keeps STEP component ancestry in summaries without echoing it into patches", () => {
    const stepAssembly = [{ id: "step-node:0", name: "MainAssembly", children: [{ id: "step-occurrence:8", name: "Sensors", children: [{ id: "step-occurrence:12", name: "SensorLeft", children: [] }] }] }];
    const stepComponent = {
      id: "step-occurrence:12/solid-1",
      occurrenceId: "step-occurrence:12",
      path: [
        { id: "step-node:0", name: "MainAssembly" },
        { id: "step-occurrence:8", name: "Sensors" },
        { id: "step-occurrence:12", name: "SensorLeft" },
      ],
    };
    const summary: ShapeSummary = { ...shapeSummary("s1"), stepAssembly, stepComponent };
    expect(shapePatchFromSummary(summary)).not.toHaveProperty("stepAssembly");
    expect(shapePatchFromSummary(summary)).not.toHaveProperty("stepComponent");
  });

  it("returns the created shape rather than the envelope", async () => {
    const server = fakeServer({ status: 201, body: { shapes: [shapeSummary("s1")], revision: 3 } });
    await expect(client(server).shapes.create("p1", { kind: "box", width: 10 })).resolves.toMatchObject({ id: "s1" });
    expect(server.calls[0]?.body).toEqual({ kind: "box", width: 10 });
  });

  it("sends a closed section and open spine as a retained sketch sweep", async () => {
    const profile = {
      points: [
        { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
        { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
        { id: "p0", x: 0, z: 0 }, { id: "p1", x: 10, z: 0 },
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
        { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
        { id: "spine", startId: "p0", endId: "p1" },
      ],
    };
    const request: ShapeRequest = { kind: "sketchSweep", profile };
    const server = fakeServer({ status: 201, body: { shapes: [{ ...shapeSummary("s1"), sketchOperation: "sweep", sketchSourceId: "sketch/s1", sketchProfile: profile }], revision: 4 } });
    await expect(client(server).shapes.create("p1", request)).resolves.toMatchObject({ sketchOperation: "sweep", sketchSourceId: "sketch/s1", sketchProfile: profile });
    expect(server.calls[0]?.body).toEqual(request);
  });

  it("updates a sweep profile through the public shapes client", async () => {
    const profile: SketchSweepProfile = {
      points: [
        { id: "a", x: -2, z: -1, sweepRole: "section" }, { id: "b", x: 2, z: -1, sweepRole: "section" },
        { id: "c", x: 2, z: 1, sweepRole: "section" }, { id: "d", x: -2, z: 1, sweepRole: "section" },
        { id: "p0", x: 0, z: 0, sweepRole: "spine" }, { id: "p1", x: 10, z: 0, sweepRole: "spine" },
      ],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
        { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
        { id: "spine", startId: "p0", endId: "p1" },
      ],
    };
    const server = fakeServer({ body: { shape: { ...shapeSummary("s1"), sketchProfile: profile }, revision: 5 } });
    await client(server).shapes.update("p1", "s1", { sketchProfile: profile });
    expect(server.calls[0]?.method).toBe("PATCH");
    expect(server.calls[0]?.body).toEqual({ sketchProfile: profile });
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
    id: `face_${index}`,
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

describe("draft prisms", () => {
  it("sends a draft angle to the shape operation", async () => {
    const server = fakeServer({ body: { shape: shapeSummary("s1"), triangles: 24, revision: 5 } });
    await client(server).draftPrism.apply("p1", "s1", 5);
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/draft-prism?projectId=p1&shapeId=s1");
    expect(server.calls[0]?.body).toEqual({ angle: 5 });
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

describe("shape properties", () => {
  it("returns exact properties and preserves mesh provenance", async () => {
    const properties = {
      volume: 120, area: 148, centerOfMass: { x: 12, y: 3, z: -4 },
      bbox: { xmin: 10, ymin: 0, zmin: -6, xmax: 14, ymax: 6, zmax: -2 },
      isValid: true, provenance: { source: "mesh" as const, precision: "tessellated" as const },
    };
    const server = fakeServer({ body: { properties } });
    await expect(client(server).properties.get("p1", "s1")).resolves.toEqual(properties);
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/properties?projectId=p1&shapeId=s1");
  });

  it("binds the project id through a handle", async () => {
    const server = fakeServer({ body: { properties: {} } });
    await client(server).project("p9").propertiesOf("s1");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/properties?projectId=p9&shapeId=s1");
  });
});

describe("STEP assembly explosion", () => {
  it("sends the target shape to the project replacement endpoint", async () => {
    const server = fakeServer({ body: { shapes: [{ id: "part-1" }, { id: "part-2" }], revision: 8 } });
    await expect(client(server).project("p9").explodeStepAssembly("assembly"))
      .resolves.toMatchObject({ shapes: [{ id: "part-1" }, { id: "part-2" }], revision: 8 });
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/explode?projectId=p9&shapeId=assembly");
  });
});


describe("interference", () => {
  it("sends the project, selected ids and clearance to the exact endpoint", async () => {
    const report = { shapesChecked: 2, candidatePairsChecked: 1, clearance: 0.5, method: "OCCT exact distance and common volume; AABB candidate prefilter" as const, pairs: [] };
    const server = fakeServer({ body: report });
    await expect(client(server).project("p9").interferenceReport({ ids: ["a", "b"], clearance: 0.5 })).resolves.toEqual(report);
    expect(server.calls[0]?.method).toBe("POST");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/interference?projectId=p9");
    expect(server.calls[0]?.body).toEqual({ ids: ["a", "b"], clearance: 0.5 });
  });
});

describe("section drawings", () => {
  it("requests a named plane and decodes the returned SVG", async () => {
    const svg = '<svg data-plane="xy"><path d="M0 0L1 1"/></svg>';
    const base64 = btoa(svg);
    const server = fakeServer({ body: { filename: "Plate.svg", mimeType: "image/svg+xml", bytes: svg.length, shapeCount: 1, base64 } });

    await expect(client(server).project("p1").sectionDrawing({ plane: "xy", offset: 2, shapeIds: ["s1"] }))
      .resolves.toMatchObject({ filename: "Plate.svg", shapeCount: 1, svg });
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/exports?projectId=p1");
    expect(server.calls[0]?.body).toEqual({ format: "svg", section: { plane: "xy", offset: 2 }, shapeIds: ["s1"] });
  });

  it("requests and decodes section contours as DXF", async () => {
    const dxf = "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n";
    const server = fakeServer({ body: { filename: "Plate.dxf", mimeType: "application/dxf", bytes: dxf.length, shapeCount: 1, base64: btoa(dxf) } });
    await expect(client(server).project("p1").sectionDxf({ plane: "xy", offset: 2 })).resolves.toMatchObject({ filename: "Plate.dxf", dxf });
    expect(server.calls[0]?.body).toMatchObject({ format: "dxf", section: { plane: "xy", offset: 2 } });
  });
});

describe("exports", () => {
  // Not valid UTF-8, so a decode that went through text would change them.
  const artifactBytes = Uint8Array.from([0, 255, 128, 10, 13, 0x89, 0x50]);
  const artifactBase64 = Buffer.from(artifactBytes).toString("base64");
  const exported = (format: string) => ({
    format, filename: `Plate.${format}`, mimeType: "application/octet-stream", bytes: artifactBytes.length, shapeCount: 2, base64: artifactBase64,
  });

  it("names the same formats and views the API contract does", () => {
    const contract = JSON.parse(readFileSync(new URL("../../../../docs/openapi-v1.json", import.meta.url), "utf8"));
    const body = contract.paths["/api/v1/exports"].post.requestBody.content["application/json"].schema.properties;
    expect([...PROJECT_EXPORT_FORMATS]).toEqual(body.format.enum);
    expect([...EXPORT_VIEWS]).toEqual(body.view.enum);
  });

  it.each(PROJECT_EXPORT_FORMATS)("sends a %s export to the project and returns its exact bytes", async (format) => {
    const server = fakeServer({ body: exported(format) });

    const artifact = await client(server).exports.export("p1", { format, shapeIds: ["a", "b"], name: "Plate" });

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.method).toBe("POST");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/exports?projectId=p1");
    expect(server.calls[0]?.body).toEqual({ format, shapeIds: ["a", "b"], name: "Plate" });
    expect(artifact).toEqual({
      format, filename: `Plate.${format}`, mimeType: "application/octet-stream", bytes: artifactBytes.length, shapeCount: 2, data: artifactBytes,
    });
    expect(artifact.data).toBeInstanceOf(Uint8Array);
  });

  it("sends only the format when nothing else is named", async () => {
    const server = fakeServer({ body: exported("stl") });
    await client(server).exports.export("p1", { format: "stl" });
    expect(server.calls[0]?.body).toEqual({ format: "stl" });
  });

  it("sends a projected view with an SVG", async () => {
    const server = fakeServer({ body: exported("svg") });
    await client(server).exports.export("p1", { format: "svg", view: "top" });
    expect(server.calls[0]?.body).toEqual({ format: "svg", view: "top" });
  });

  it("sends a mesh feature angle with an SVG projection", async () => {
    const server = fakeServer({ body: exported("svg") });
    await client(server).exports.export("p1", { format: "svg", view: "top", featureAngle: 22 });
    expect(server.calls[0]?.body).toEqual({ format: "svg", view: "top", featureAngle: 22 });
  });

  it.each(["svg", "dxf"] as const)("sends a section plane with %s", async (format) => {
    const server = fakeServer({ body: exported(format) });
    await client(server).exports.export("p1", { format, section: { plane: "xz", offset: -4 } });
    expect(server.calls[0]?.body).toEqual({ format, section: { plane: "xz", offset: -4 } });
  });

  it("keeps STEP's exported count and skipped shapes, and leaves them off when absent", async () => {
    const skipped = [{ name: "Mesh", kind: "mesh", reason: "No exact solid." }];
    const server = fakeServer({ body: { ...exported("step"), exportedCount: 1, skipped } }, { body: exported("step") });

    await expect(client(server).exports.export("p1", { format: "step" })).resolves.toMatchObject({ exportedCount: 1, skipped });
    const plain = await client(server).exports.export("p1", { format: "step" });
    expect(plain).not.toHaveProperty("exportedCount");
    expect(plain).not.toHaveProperty("skipped");
  });

  it.each(PROJECT_EXPORT_FORMATS.filter((format) => format !== "svg"))("refuses a view on %s before sending anything", async (format) => {
    const server = fakeServer({ body: exported(format) });
    await expect(client(server).exports.export("p1", { format, view: "top" })).rejects.toThrow(/view only applies to the svg format/);
    expect(server.calls).toHaveLength(0);
  });

  it.each(PROJECT_EXPORT_FORMATS.filter((format) => format !== "svg"))("refuses a feature angle on %s before sending anything", async (format) => {
    const server = fakeServer({ body: exported(format) });
    await expect(client(server).exports.export("p1", { format, featureAngle: 22 })).rejects.toThrow(/featureAngle only applies to svg projection drawings/);
    expect(server.calls).toHaveLength(0);
  });

  it.each(PROJECT_EXPORT_FORMATS.filter((format) => format !== "svg" && format !== "dxf"))("refuses a section on %s before sending anything", async (format) => {
    const server = fakeServer({ body: exported(format) });
    await expect(client(server).exports.export("p1", { format, section: { plane: "xy", offset: 0 } })).rejects.toThrow(/section only applies to svg and dxf/);
    expect(server.calls).toHaveLength(0);
  });

  it("refuses a view and a section together, and a format the server does not produce", async () => {
    const server = fakeServer({ body: exported("svg") });
    await expect(client(server).exports.export("p1", { format: "svg", view: "top", section: { plane: "xy", offset: 0 } }))
      .rejects.toThrow(/section and view cannot be used together/);
    await expect(client(server).exports.export("p1", { format: "svg", section: { plane: "xy", offset: 0 }, featureAngle: 22 }))
      .rejects.toThrow(/featureAngle only applies to svg projection drawings/);
    await expect(client(server).exports.export("p1", { format: "gltf" as never })).rejects.toThrow(/format must be one of: stl, obj, 3mf, step, skf, zip, svg, dxf/);
    expect(server.calls).toHaveLength(0);
  });

  it("decodes an artifact the same way with or without node's Buffer", () => {
    // Every byte value, so a decode that went through text or dropped the
    // high bit cannot match.
    const bytes = new Uint8Array(1024).map((_, index) => index % 256);
    const encoded = Buffer.from(bytes).toString("base64");
    expect(base64ToBytes(encoded)).toEqual(bytes);

    const global = globalThis as { Buffer?: unknown };
    const saved = global.Buffer;
    delete global.Buffer;
    try {
      expect(base64ToBytes(encoded)).toEqual(bytes);
    } finally {
      global.Buffer = saved;
    }
  });

  it("binds the project id through a handle", async () => {
    const server = fakeServer({ body: exported("3mf") });
    await expect(client(server).project("p9").export({ format: "3mf" })).resolves.toMatchObject({ format: "3mf", data: artifactBytes });
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/exports?projectId=p9");
    expect(server.calls[0]?.body).toEqual({ format: "3mf" });
  });
});

describe("booleans, groups and parts", () => {
  it("names the solids and the cutters in the body, with only the project in the query", async () => {
    const server = fakeServer({ status: 201, body: { shape: shapeSummary("cut"), triangles: 412, revision: 7 } });

    const result = await client(server).booleans.cut("p1", { solidIds: ["plate"], holeIds: ["h1", "h2"] });

    expect(server.calls[0]?.method).toBe("POST");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/booleans?projectId=p1");
    expect(server.calls[0]?.body).toEqual({ solidIds: ["plate"], holeIds: ["h1", "h2"] });
    expect(result).toEqual({ shape: shapeSummary("cut"), triangles: 412, revision: 7 });
  });

  it("groups by ids in the body", async () => {
    const server = fakeServer({ status: 201, body: { shape: shapeSummary("g"), revision: 3 } });

    const result = await client(server).groups.group("p1", ["a", "b"]);

    expect(server.calls[0]?.method).toBe("POST");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/groups?projectId=p1");
    expect(server.calls[0]?.body).toEqual({ ids: ["a", "b"] });
    expect(result).toEqual({ shape: shapeSummary("g"), revision: 3 });
  });

  it("ungroups by DELETE with the group in the query and no body", async () => {
    const server = fakeServer({ body: { shapes: [shapeSummary("a"), shapeSummary("b")], revision: 4 } });

    const result = await client(server).groups.ungroup("p1", "g");

    expect(server.calls[0]?.method).toBe("DELETE");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/groups?projectId=p1&shapeId=g");
    expect(server.calls[0]?.body).toBeUndefined();
    expect(result).toEqual({ shapes: [shapeSummary("a"), shapeSummary("b")], revision: 4 });
  });

  it("separates by POST with the shape in the query and no body", async () => {
    const server = fakeServer({ body: { shapes: [shapeSummary("left"), shapeSummary("right")], revision: 5 } });

    const result = await client(server).parts.separate("p1", "bar");

    expect(server.calls[0]?.method).toBe("POST");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/parts?projectId=p1&shapeId=bar");
    expect(server.calls[0]?.body).toBeUndefined();
    expect(result).toEqual({ shapes: [shapeSummary("left"), shapeSummary("right")], revision: 5 });
  });

  it("retries each of the four when the project lock is busy, because each one writes", async () => {
    const busy = { status: 409, body: { error: "Project is busy.", code: "project_busy" } };
    const calls: Array<[string, (c: SketchForgeClient) => Promise<unknown>, StubResponse]> = [
      ["cut", (c) => c.booleans.cut("p1", { solidIds: ["a"], holeIds: ["b"] }), { status: 201, body: { shape: shapeSummary("a"), triangles: 1, revision: 2 } }],
      ["group", (c) => c.groups.group("p1", ["a", "b"]), { status: 201, body: { shape: shapeSummary("g"), revision: 2 } }],
      ["ungroup", (c) => c.groups.ungroup("p1", "g"), { body: { shapes: [], revision: 2 } }],
      ["separate", (c) => c.parts.separate("p1", "a"), { body: { shapes: [], revision: 2 } }],
    ];
    for (const [name, call, ok] of calls) {
      const server = fakeServer(busy, ok);
      await expect(call(client(server)), name).resolves.toBeDefined();
      expect(server.calls, name).toHaveLength(2);
    }
  });

  it("binds the project id through a handle, the way the Python handle does", async () => {
    const server = fakeServer({ status: 201, body: { shape: shapeSummary("x"), triangles: 1, revision: 1 } });
    const project = client(server).project("p9");

    await project.cut({ solidIds: ["plate"], holeIds: ["h"] });
    await project.group(["a", "b"]);
    await project.ungroup("g");
    await project.separate("s");

    expect(server.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://localhost:3100/api/v1/booleans?projectId=p9",
      "POST http://localhost:3100/api/v1/groups?projectId=p9",
      "DELETE http://localhost:3100/api/v1/groups?projectId=p9&shapeId=g",
      "POST http://localhost:3100/api/v1/parts?projectId=p9&shapeId=s",
    ]);
    expect(server.calls.map((call) => call.body)).toEqual([{ solidIds: ["plate"], holeIds: ["h"] }, { ids: ["a", "b"] }, undefined, undefined]);
  });
});

describe("wall thickness", () => {
  it("estimates through a handle, as the README documents", async () => {
    const thickness = { minimum: 2, unit: "mm", method: "sampled-opposing-surface-distance", samplesPerFace: 4, facesChecked: 6 };
    const server = fakeServer({ body: { thickness } });
    await expect(client(server).project("p9").estimateWallThickness("s1")).resolves.toEqual(thickness);
    expect(server.calls[0]?.method).toBe("GET");
    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/thickness?projectId=p9&shapeId=s1");
  });
});

describe("exact baked mirrors", () => {
  it("sends a required selection and axis to the BREP mirror route", async () => {
    const server = fakeServer({ body: { moved: 2, axis: "x", shapes: [], revision: 4 } });

    const result = await client(server).mirrors.bake("p1", ["a", "b"], "x");

    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/mirrors?projectId=p1");
    expect(server.calls[0]?.body).toEqual({ ids: ["a", "b"], axis: "x" });
    expect(result.moved).toBe(2);
  });
});

describe("align, distribute and patterns", () => {
  it("sends the axis and target, and leaves an absent anchor out", async () => {
    const server = fakeServer({ body: { moved: 2, axis: "y", target: "max", anchorId: null, shapes: [], revision: 1 } });

    await client(server).align.tops("p1", ["a", "b"]);

    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/align?projectId=p1");
    // An anchor sent as null would be a different request from one not sent:
    // the server reads an absent anchor as "use the whole selection's box".
    expect(server.calls[0]?.body).toEqual({ ids: ["a", "b"], axis: "y", target: "max" });
  });

  it("carries an anchor through when there is one", async () => {
    const server = fakeServer({ body: { moved: 1, axis: "x", target: "center", anchorId: "a", shapes: [], revision: 1 } });

    await client(server).align.centers("p1", ["a", "b"], "x", "a");

    expect(server.calls[0]?.body).toEqual({ ids: ["a", "b"], axis: "x", target: "center", anchorId: "a" });
  });

  it("leaves the axis out so the server picks the row the shapes are already in", async () => {
    const server = fakeServer({ body: { moved: 1, axis: "z", spacing: "centers", shapes: [], revision: 1 } });

    const result = await client(server).distribute.pitch("p1", ["a", "b", "c"]);

    expect(server.calls[0]?.body).toEqual({ ids: ["a", "b", "c"], spacing: "centers" });
    expect(result.axis).toBe("z");
  });

  it("sends a row's pitch and a ring's centre under the server's own names", async () => {
    const server = fakeServer({ body: { created: 3, kind: "linear", shapes: [], revision: 1 } });
    const api = client(server);

    await api.patterns.row("p1", ["boss"], 4, 25);
    expect(server.calls[0]?.body).toEqual({ ids: ["boss"], kind: "linear", count: 4, stepX: 25 });

    await api.patterns.ring("p1", ["hole"], 6, { x: 0, z: 12 }, { rotateCopies: false });
    expect(server.calls[1]?.body).toEqual({
      ids: ["hole"],
      kind: "circular",
      count: 6,
      centerX: 0,
      centerZ: 12,
      rotateCopies: false,
    });
  });

  it("keeps rotateCopies: false, which an omit-if-falsy would have dropped", async () => {
    // The server's default is `true`, so dropping an explicit `false` would
    // turn every vane the wrong way and look like the request worked.
    const server = fakeServer({ body: { created: 1, kind: "circular", shapes: [], revision: 1 } });

    await client(server).patterns.apply("p1", { ids: ["v"], kind: "circular", count: 2, rotateCopies: false });

    expect(server.calls[0]?.body).toMatchObject({ rotateCopies: false });
  });

  it("keeps a zero step and a zero centre, which the server reads as meaningful", async () => {
    const server = fakeServer({ body: { created: 1, kind: "linear", shapes: [], revision: 1 } });

    await client(server).patterns.apply("p1", { ids: ["b"], kind: "linear", count: 3, stepX: 0, stepZ: 14 });

    // `stepX: 0` is a row that runs purely along Z, not an absent field.
    expect(server.calls[0]?.body).toMatchObject({ stepX: 0, stepZ: 14 });
  });
});

describe("imports", () => {
  it("sends the bytes as base64 under the file name that chooses the importer", async () => {
    const server = fakeServer({ body: { shape: shapeSummary("m1"), triangles: 12, revision: 1 } });
    const bytes = new Uint8Array([115, 111, 108, 105, 100]);

    await client(server).imports.apply("p1", { fileName: "plate.stl", bytes });

    expect(server.calls[0]?.url).toBe("http://localhost:3100/api/v1/imports?projectId=p1");
    expect(server.calls[0]?.body).toEqual({ fileName: "plate.stl", data: "c29saWQ=" });
  });

  it("encodes a whole model file the same way with or without node's Buffer", () => {
    // Longer than the 0x8000 chunk the browser-side branch works in, and
    // longer than the argument limit `String.fromCharCode(...bytes)` hits --
    // which is a stack overflow rather than a wrong answer, so a model file is
    // exactly the input that finds it. Not every byte value is the same byte:
    // a buffer of one repeated character would encode identically however the
    // chunking went wrong.
    const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, index) => index % 251);
    const expected = Buffer.from(bytes).toString("base64");

    expect(meshBytesToBase64(bytes)).toBe(expected);

    // And the `btoa` branch a browser-hosted caller takes. Exercised on the
    // encoder rather than through a request, because the test server's own
    // `Response` needs `Buffer` too.
    const global = globalThis as { Buffer?: unknown };
    const saved = global.Buffer;
    delete global.Buffer;
    try {
      expect(meshBytesToBase64(bytes)).toBe(expected);
    } finally {
      global.Buffer = saved;
    }
  });

  it("says which file names the server will even try", () => {
    const api = client(fakeServer({ body: {} }));
    expect(api.imports.readable("bracket.STL")).toBe(true);
    expect(api.imports.readable("logo.svg")).toBe(true);
    expect(api.imports.readable("part.step")).toBe(false);
    expect(api.imports.readable("notes")).toBe(false);
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

describe("exact topology face listings", () => {
  it("passes topology through resource and bound handle while preserving the default", async () => {
    const server = fakeServer({ body: { faces: [] } });
    const api = client(server);
    await api.faces.list("p1", "s1", { topology: "exact" });
    await api.project("p1").faces("s1", { topology: "exact" });
    await api.faces.list("p1", "s1");
    expect(server.calls.map((call) => call.url)).toEqual([
      "http://localhost:3100/api/v1/faces?projectId=p1&shapeId=s1&topology=exact",
      "http://localhost:3100/api/v1/faces?projectId=p1&shapeId=s1&topology=exact",
      "http://localhost:3100/api/v1/faces?projectId=p1&shapeId=s1",
    ]);
  });
});
