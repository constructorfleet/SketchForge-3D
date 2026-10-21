import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { API_V1_OPERATIONS, type ApiV1Operation } from "@/lib/apiV1OperationContract";

const routeRoot = path.resolve("apps/web/src/app/api/v1");

function sourceOperations() {
  const found: string[] = [];
  const visit = (directory: string, segments: string[]) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, [...segments, entry.name]);
        continue;
      }
      if (entry.name !== "route.ts") continue;
      const source = readFileSync(fullPath, "utf8");
      const route = `/api/v1/${segments.join("/")}`;
      const methods = /export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|OPTIONS)\s*\(|export\s+const\s+(GET|POST|PATCH|PUT|DELETE|OPTIONS)\s*=/g;
      for (const match of source.matchAll(methods)) found.push(`${match[1] ?? match[2]} ${route}`);
    }
  };
  visit(routeRoot, []);
  return found.sort();
}

type CreateProjectBody = Extract<NonNullable<ApiV1Operation["requestBody"]>, { normalization: readonly ["trim", "truncate:80"] }>;

describe("REST API v1 operation contract", () => {
  it("keeps create-project normalization and schema required in the contract type", () => {
    expectTypeOf<CreateProjectBody["normalization"]>().toEqualTypeOf<readonly ["trim", "truncate:80"]>();
    expectTypeOf<CreateProjectBody["schema"]>().toEqualTypeOf<{
      type: "object";
      required: readonly ["name"];
      name: { type: "string"; minLength: 1; maxLength: 80 };
    }>();
  });

  it("registers every public route method exactly once", () => {
    const registered = API_V1_OPERATIONS.map(({ method, path: route }) => `${method} ${route}`).sort();
    expect(registered).toEqual(sourceOperations());
    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set(API_V1_OPERATIONS.map(({ operationId }) => operationId)).size).toBe(registered.length);
  });

  it("declares the operation ID and response statuses for project creation", () => {
    expect(API_V1_OPERATIONS.find(({ method, path: route }) => method === "POST" && route === "/api/v1/projects"))
      .toMatchObject({
        operationId: "createProject",
        auth: "bearer",
        responses: [201, 400, 401, 404, 409, 503],
        requestBody: {
          contentType: "application/json",
          required: true,
          normalization: ["trim", "truncate:80"],
          schema: { type: "object", required: ["name"], name: { type: "string", minLength: 1, maxLength: 80 } },
        },
      });
  });

  it("validates project creation with the contract's required name constraints", async () => {
    const { parseCreateProjectRequest } = await import("@/lib/apiV1OperationContract");
    expect(parseCreateProjectRequest({ name: "  Bracket  " })).toEqual({ name: "Bracket" });
    expect(parseCreateProjectRequest({ name: " " })).toBeNull();
    expect(parseCreateProjectRequest({ name: 4 })).toBeNull();
    expect(parseCreateProjectRequest({ name: "x".repeat(90) })?.name).toHaveLength(80);
  });

  it("declares and parses the verified GET /faces query and response contract", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/faces");
    expect(operation).toMatchObject({
      operationId: "listFaces",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 500, 503],
      query: { required: ["projectId", "shapeId"] },
      response: { required: ["faces"], faceFields: ["index", "id", "surfaceType", "area", "centroid", "normal", "facing"], faceIdSemantics: "stable identity for a face while its identity is preserved by the model", colorAssignmentKey: "face id in PATCH /api/v1/shapes faceColors" },
    });
    expect(contract.parseApiTargetQuery(new Request("https://example.test/api/v1/faces?projectId= part_1 &shapeId= solid ")))
      .toEqual({ ok: true, projectId: "part_1", shapeId: "solid" });
    expect(contract.parseApiTargetQuery(new Request("https://example.test/api/v1/properties?projectId=../bad&shapeId=x")))
      .toEqual({ ok: false, error: "invalid_project_id" });
    expect(contract.parseApiTargetQuery(new Request("https://example.test/api/v1/properties?projectId=p")))
      .toEqual({ ok: false, error: "invalid_shape_id" });
    expect(contract.parseListFacesResponse({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: 1, centroid: { x: 0, y: 0, z: 0 }, normal: null, facing: null }] }))
      .toEqual({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: 1, centroid: { x: 0, y: 0, z: 0 }, normal: null, facing: null }] });
    expect(contract.parseListFacesResponse({ faces: [{ index: "0" }] })).toBeNull();
  });

  it("declares and validates GET /properties against the complete mass-properties response", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/properties");
    expect(operation).toMatchObject({
      operationId: "getShapeProperties",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 500, 503],
      query: { required: ["projectId", "shapeId"] },
      response: {
        kind: "shape-properties",
        required: ["properties"],
        fields: ["volume", "area", "centerOfMass", "bbox", "isValid", "provenance"],
        provenance: { source: ["parametric", "brep", "mesh"], precision: ["exact", "tessellated"] },
        schema: {
          type: "object",
          required: ["volume", "area", "centerOfMass", "bbox", "isValid", "provenance"],
          properties: {
            volume: { type: "number" },
            area: { type: "number" },
            centerOfMass: { type: "object", required: ["x", "y", "z"], properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
            bbox: { type: "object", required: ["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"], properties: { xmin: { type: "number" }, ymin: { type: "number" }, zmin: { type: "number" }, xmax: { type: "number" }, ymax: { type: "number" }, zmax: { type: "number" } } },
            isValid: { type: "boolean" },
            provenance: { type: "object", required: ["source", "precision"], properties: { source: { type: "string", enum: ["parametric", "brep", "mesh"] }, precision: { type: "string", enum: ["exact", "tessellated"] } } },
          },
        },
      },
    });
    const properties = {
      volume: 120,
      area: 148,
      centerOfMass: { x: 10, y: 3, z: 0 },
      bbox: { xmin: 8, ymin: 0, zmin: -2.5, xmax: 12, ymax: 6, zmax: 2.5 },
      isValid: true,
      provenance: { source: "parametric", precision: "exact" },
    };
    expect(contract.parseShapePropertiesResponse({ properties })).toEqual({ properties });
    expect(contract.parseShapePropertiesResponse({ properties: { ...properties, area: "148" } })).toBeNull();
    expect(contract.parseShapePropertiesResponse({ properties: { ...properties, centerOfMass: { x: 0, y: Number.NaN, z: 0 } } })).toBeNull();
    expect(contract.parseShapePropertiesResponse({ properties: { ...properties, bbox: { ...properties.bbox, xmax: Infinity } } })).toBeNull();
    expect(contract.parseShapePropertiesResponse({ properties: { ...properties, provenance: { source: "step", precision: "exact" } } })).toBeNull();
  });

  it("declares and validates GET /measurements against every edge and face result", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/measurements");
    expect(operation).toMatchObject({
      operationId: "listMeasurements",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 422, 500, 503],
      query: { required: ["projectId", "shapeId"] },
      response: {
        required: ["measurements"],
        schema: {
          type: "object",
          required: ["measurements"],
          properties: {
            measurements: {
              type: "array",
              items: {
                type: "object",
                required: ["entity", "index", "geometryType", "length", "area", "radius", "diameter", "sweepDegrees", "radiusUnavailable"],
                properties: {
                  entity: { type: "string", enum: ["edge", "face"] },
                  index: { type: "integer" },
                  geometryType: { type: "string" },
                  length: { type: "number", nullable: true },
                  area: { type: "number", nullable: true },
                  radius: { type: "number", nullable: true },
                  diameter: { type: "number", nullable: true },
                  sweepDegrees: { type: "number", nullable: true },
                  radiusUnavailable: { type: "string", nullable: true, enum: ["notCircular", "ellipseHasNoSingleRadius", "degenerateCurve", "notCurved", "radiusVariesOverSurface", "radiusNotReportedByKernel", "degenerateSurface"] },
                },
              },
            },
          },
        },
      },
    });
    const measurements = [
      { entity: "edge", index: 0, geometryType: "circle", length: 2, area: null, radius: 1, diameter: 2, sweepDegrees: 360, radiusUnavailable: null },
      { entity: "face", index: 0, geometryType: "plane", length: null, area: 6, radius: null, diameter: null, sweepDegrees: null, radiusUnavailable: "notCurved" },
    ];
    expect(contract.parseMeasurementsResponse({ measurements })).toEqual({ measurements });
    expect(contract.parseMeasurementsResponse({ measurements: [{ ...measurements[0], entity: "vertex" }] })).toBeNull();
    expect(contract.parseMeasurementsResponse({ measurements: [{ ...measurements[1], radiusUnavailable: "unknown" }] })).toBeNull();
    expect(contract.parseMeasurementsResponse({ measurements: [{ ...measurements[0], area: "6" }] })).toBeNull();
  });

  it("declares and validates POST /measurements between-entity requests and results", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "POST" && route === "/api/v1/measurements");
    expect(operation).toMatchObject({
      operationId: "measureEntities",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 422, 500, 503],
      query: { required: ["projectId"] },
      requestBody: {
        contentType: "application/json",
        required: true,
        schema: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "object", required: ["shapeId"], properties: { shapeId: { type: "string" }, entity: { type: "string", enum: ["edge", "face", "shape"], default: "shape" }, index: { type: "integer", minimum: 0, description: "Required when entity is edge or face." } } },
            to: { type: "object", required: ["shapeId"], properties: { shapeId: { type: "string" }, entity: { type: "string", enum: ["edge", "face", "shape"], default: "shape" }, index: { type: "integer", minimum: 0, description: "Required when entity is edge or face." } } },
          },
        },
      },
      response: {
        required: ["distance", "angleDegrees", "angleUnavailable"],
        schema: {
          type: "object",
          required: ["distance", "angleDegrees", "angleUnavailable"],
          properties: {
            distance: { type: "number" },
            angleDegrees: { type: "number", nullable: true },
            angleUnavailable: { type: "string", nullable: true, enum: ["notPlanar", "degenerateNormal"] },
          },
        },
      },
    });
    expect(contract.parseMeasureBetweenRequest({ from: { shapeId: " block-a " }, to: { shapeId: "block-b", entity: "face", index: 2 } }))
      .toEqual({ ok: true, from: { shapeId: "block-a", entity: "shape" }, to: { shapeId: "block-b", entity: "face", index: 2 } });
    expect(contract.parseMeasureBetweenRequest({ from: { shapeId: "a", entity: "edge" }, to: { shapeId: "b" } }))
      .toMatchObject({ ok: false, side: "from" });
    expect(contract.parseMeasureBetweenRequest({ from: { shapeId: "a", entity: "vertex", index: 0 }, to: { shapeId: "b" } }))
      .toMatchObject({ ok: false, side: "from" });
    expect(contract.parseMeasureBetweenResponse({ distance: 12, angleDegrees: null, angleUnavailable: "notPlanar" }))
      .toEqual({ distance: 12, angleDegrees: null, angleUnavailable: "notPlanar" });
    expect(contract.parseMeasureBetweenResponse({ distance: Number.NaN, angleDegrees: null, angleUnavailable: "notPlanar" })).toBeNull();
    expect(contract.parseMeasureBetweenResponse({ distance: 12, angleDegrees: 90, angleUnavailable: "degenerateNormal" })).toBeNull();
  });

  it("declares and validates PATCH /shapes faceColors using stable IDs and legacy numeric keys", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "PATCH" && route === "/api/v1/shapes");
    expect(operation).toMatchObject({
      operationId: "updateShape",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 422, 500, 503],
      query: { required: ["projectId", "shapeId"] },
      requestBody: {
        contentType: "application/json",
        required: true,
        faceColors: { keyKinds: ["stable-face-id", "legacy-numeric-index"], colorPattern: "^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$" },
      },
    });
    expect(contract.parseShapePatchRequest({ faceColors: { face_abc123: "#12aBcF", "0": "#12aBcF80" } }))
      .toEqual({ ok: true, body: { faceColors: { face_abc123: "#12aBcF", "0": "#12aBcF80" } } });
    expect(contract.parseShapePatchRequest({ name: "Updated", faceColors: { "0": "#12aBcF" } }))
      .toEqual({ ok: true, body: { name: "Updated", faceColors: { "0": "#12aBcF" } } });
    expect(contract.parseShapePatchRequest({ faceColors: { other_key: "#12aBcF" } })).toEqual({ ok: false, error: "invalid_face_color_key" });
    expect(contract.parseShapePatchRequest({ faceColors: { "face_bad id": "#12aBcF" } })).toEqual({ ok: false, error: "invalid_face_color_key" });
    expect(contract.parseShapePatchRequest({ faceColors: { face_abc123: "red" } })).toEqual({ ok: false, error: "invalid_face_colors" });
    expect(contract.parseShapePatchRequest({ faceColors: [] })).toEqual({ ok: false, error: "invalid_face_colors" });
  });

  it("records read-only OPTIONS handlers as unauthenticated 204 responses", () => {
    for (const route of ["edges", "faces", "properties", "thickness"]) {
      expect(API_V1_OPERATIONS.find(({ method, path: routePath }) => method === "OPTIONS" && routePath === `/api/v1/${route}`))
        .toMatchObject({ auth: "none", responses: [204] });
    }
  });
});
