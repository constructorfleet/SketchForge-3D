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
  it("declares nested STEP product hierarchy in project shape summaries", () => {
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/shapes");
    expect((operation?.responseSchemas as Record<number, unknown> | undefined)?.[200]).toMatchObject({
      properties: {
        shapes: {
          items: {
            properties: {
              stepAssembly: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "children"],
                  properties: { name: { type: "string" }, children: { type: "array" } },
                },
              },
            },
          },
        },
      },
    });
  });

  it("keeps create-project normalization and schema required in the contract type", () => {
    expectTypeOf<CreateProjectBody["normalization"]>().toEqualTypeOf<readonly ["trim", "truncate:80"]>();
    expectTypeOf<CreateProjectBody["schema"]>().toEqualTypeOf<{
      type: "object";
      required: readonly ["name"];
      properties: { name: { type: "string"; minimumLength: 1; maximumLength: 80 } };
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
        responses: [201, 400, 401, 404, 409, 500, 503],
        requestBody: {
          contentType: "application/json",
          required: true,
          normalization: ["trim", "truncate:80"],
          schema: { type: "object", required: ["name"], properties: { name: { type: "string", minimumLength: 1, maximumLength: 80 } } },
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

  it("declares schemas and runtime validators for all project and shape CRUD operations", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const keys = ["GET /api/v1/projects", "POST /api/v1/projects", "DELETE /api/v1/projects", "GET /api/v1/shapes", "POST /api/v1/shapes", "PATCH /api/v1/shapes", "DELETE /api/v1/shapes"];
    for (const key of keys) {
      const item = API_V1_OPERATIONS.find((candidate) => `${candidate.method} ${candidate.path}` === key)!;
      expect(item.auth).toBe("bearer");
      expect(item.responses?.length).toBeGreaterThan(1);
      expect(item.responseSchemas).toBeDefined();
      for (const status of item.responses ?? []) expect((item.responseSchemas as Record<number, unknown> | undefined)?.[status]).toBeDefined();
      expect(contract.validateApiV1Response(key, 401, { error: "Unauthorized", code: "unauthorized" })).toBe(true);
      expect(contract.validateApiV1Response(key, 401, { error: "Unauthorized" })).toBe(false);
      expect(contract.validateApiV1Response(key, 418, {})).toBe(false);
    }
    expect(contract.validateApiV1RequestBody("POST /api/v1/shapes", { kind: "box" })).toBe(true);
    expect(contract.validateApiV1RequestBody("POST /api/v1/shapes", { width: 2 })).toBe(false);
    expect(contract.validateApiV1Response("GET /api/v1/projects", 200, { projects: [] })).toBe(true);
    expect(contract.validateApiV1Response("GET /api/v1/projects", 200, { projects: "many" })).toBe(false);
    expect(contract.parseApiV1Query("PATCH /api/v1/shapes", new Request("https://example.test/api/v1/shapes?projectId=../bad&shapeId=a"))).toMatchObject({ ok: false, invalid: ["projectId"] });
    expect(contract.parseApiV1Query("PATCH /api/v1/shapes", new Request("https://example.test/api/v1/shapes?projectId=p&shapeId=%20"))).toMatchObject({ ok: false, invalid: ["shapeId"] });
  });

  it("converts unexpected exceptions and malformed response bodies into internal_error", async () => {
    const { withApiV1Contract } = await import("@/lib/apiV1OperationContract");
    const request = new Request("https://example.test/api/v1/projects");
    const malformed = withApiV1Contract("GET /api/v1/projects", async () => Response.json({ projects: "bad" }));
    const thrown = withApiV1Contract("GET /api/v1/projects", async () => { throw new Error("private detail"); });
    for (const response of [await malformed(request), await thrown(request)]) {
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "internal_error" });
    }
  });

  it("declares the GET /faces query, exact response schema, and reachable statuses", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/faces");
    expect(operation).toMatchObject({
      operationId: "listFaces",
      auth: "bearer",
      responses: [200, 400, 401, 404, 422, 500, 503],
      query: {
        required: ["projectId", "shapeId"],
        properties: {
          projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
          shapeId: { type: "string", trim: true, minLength: 1 },
        },
      },
      responseSchemas: {
        200: {
          type: "object", required: ["faces"], additionalProperties: false,
          properties: {
            faces: {
              type: "array",
              items: {
                type: "object",
                required: ["index", "id", "surfaceType", "area", "centroid", "normal", "facing"],
                additionalProperties: false,
                properties: {
                  index: { type: "integer", minimum: 0 },
                  id: { type: "string" },
                  surfaceType: { type: "string" },
                  area: { type: "number", minimum: 0 },
                  centroid: { type: "object", required: ["x", "y", "z"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
                  normal: { type: "object", nullable: true, required: ["x", "y", "z"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
                  facing: { type: "string", nullable: true, enum: ["top", "bottom", "right", "left", "front", "back"] },
                },
              },
            },
          },
        },
      },
    });
    expect(operation?.responseSchemas).toMatchObject({
      400: { type: "object", properties: { code: { enum: ["invalid_project_id", "invalid_shape_id"] } } },
      401: { type: "object", properties: { code: { enum: ["unauthorized"] } } },
      404: { type: "object", properties: { code: { enum: ["api_disabled", "project_not_found", "shape_not_found"] } } },
      422: { type: "object", properties: { code: { enum: ["cad_failed"] } } },
      500: { type: "object", properties: { code: { enum: ["cad_failed", "internal_error"] } } },
      503: { type: "object", properties: { code: { enum: ["storage_unconfigured"] } } },
    });
    expect(contract.parseApiTargetQuery(new Request("https://example.test/api/v1/faces?projectId= part_1 &shapeId= solid ")))
      .toEqual({ ok: true, projectId: "part_1", shapeId: "solid" });
    expect(contract.parseApiV1Query("GET /api/v1/faces", new Request("https://example.test/api/v1/faces?projectId=%20part_1%20&shapeId=%20solid%20")))
      .toEqual({ ok: true, values: { projectId: "part_1", shapeId: "solid" } });
    for (const query of [
      "projectId=../bad&shapeId=solid",
      `projectId=${"p".repeat(121)}&shapeId=solid`,
      "projectId=part_1&shapeId=%20",
    ]) {
      expect(contract.parseApiV1Query("GET /api/v1/faces", new Request(`https://example.test/api/v1/faces?${query}`)).ok).toBe(false);
    }
    for (const [status, code] of [
      [400, "invalid_shape_id"], [401, "unauthorized"], [404, "shape_not_found"],
      [422, "cad_failed"], [500, "internal_error"], [503, "storage_unconfigured"],
    ] as const) {
      expect(contract.validateApiV1Response("GET /api/v1/faces", status, { error: "request failed", code })).toBe(true);
    }
    expect(contract.validateApiV1Response("GET /api/v1/faces", 409, { error: "busy", code: "project_busy" })).toBe(false);
    expect(contract.parseApiTargetQuery(new Request("https://example.test/api/v1/properties?projectId=../bad&shapeId=x")))
      .toEqual({ ok: false, error: "invalid_project_id" });
    expect(contract.parseApiTargetQuery(new Request("https://example.test/api/v1/properties?projectId=p")))
      .toEqual({ ok: false, error: "invalid_shape_id" });
    expect(contract.parseListFacesResponse({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: 1, centroid: { x: 0, y: 0, z: 0 }, normal: null, facing: null }] }))
      .toEqual({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: 1, centroid: { x: 0, y: 0, z: 0 }, normal: null, facing: null }] });
    expect(contract.parseListFacesResponse({ faces: [{ index: "0" }] })).toBeNull();
    expect(contract.parseListFacesResponse({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: 1, centroid: { x: 0, y: 0, z: 0 }, normal: null, facing: null, unexpected: true }] })).toBeNull();
    expect(contract.parseListFacesResponse({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: 1, centroid: { x: 0, y: 0, z: 0 }, normal: [0, 1, 0], facing: null }] })).toBeNull();
    expect(contract.parseListFacesResponse({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: 1, centroid: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, facing: "top" }] })).not.toBeNull();
    expect(contract.parseListFacesResponse({ faces: [{ index: 0, id: "face-id", surfaceType: "plane", area: -1, centroid: { x: 0, y: 0, z: 0 }, normal: null, facing: null }] })).toBeNull();
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
            distance: { type: "number", minimum: 0 },
            angleDegrees: { type: "number", nullable: true, minimum: 0, maximum: 180 },
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
