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
  it("contracts interference normalization, bounded errors, and exact or tessellated reports", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const key = "POST /api/v1/interference";
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => `${method} ${route}` === key);
    expect(operation).toMatchObject({
      operationId: "analyzeInterference",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 422, 500, 503],
      requestBody: { contentType: "application/json", required: true },
    });
    expect(contract.validateApiV1RequestBody(key, { ids: ["post-a", "post-b"], clearance: 0.4 })).toBe(true);
    expect(contract.validateApiV1RequestBody(key, { ids: [], clearance: 0.4 })).toBe(false);
    expect(contract.validateApiV1RequestBody(key, { ids: ["post-a"], clearance: -0.1 })).toBe(false);
    expect(contract.validateApiV1RequestBody(key, { ids: ["post-a"], clearance: Number.POSITIVE_INFINITY })).toBe(false);

    const report = {
      shapesChecked: 2,
      candidatePairsChecked: 1,
      clearance: 0.4,
      method: "OCCT exact distance and common volume; AABB candidate prefilter",
      pairs: [{
        a: { id: "post-a", name: "Post A" },
        b: { id: "post-b", name: "Post B" },
        gap: 0.25,
        overlapVolume: 0,
        precision: "exact",
      }],
    };
    expect(contract.validateApiV1Response(key, 200, report)).toBe(true);
    expect(contract.validateApiV1Response(key, 200, { ...report, pairs: [{ ...report.pairs[0], precision: "approximate" }] })).toBe(false);
    expect(contract.validateApiV1Response(key, 200, { ...report, pairs: [{ a: { id: "a" }, b: { id: "b" }, gap: 1, overlapVolume: 0, precision: "tessellated" }] })).toBe(false);
    expect(contract.validateApiV1Response(key, 400, { error: "Invalid request", code: "invalid_request" })).toBe(true);
    expect(contract.validateApiV1Response(key, 422, { error: "Too many candidates", code: "invalid_request", limit: 512, atLeast: 513 })).toBe(true);
    expect(contract.validateApiV1Response(key, 500, { error: "CAD failure", code: "cad_failed" })).toBe(true);
    expect(contract.validateApiV1Response(key, 418, {})).toBe(false);
  });

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
                  properties: { id: { type: "string" }, name: { type: "string" }, children: { type: "array" } },
                },
              },
              stepComponent: {
                type: "object",
                required: ["id", "occurrenceId", "path"],
                properties: { id: { type: "string" }, occurrenceId: { type: "string" }, path: { type: "array" } },
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

  it("applies JSON Schema oneOf as exactly one matching alternative", async () => {
    const { validateApiV1Schema } = await import("@/lib/apiV1OperationContract");
    expect(validateApiV1Schema({ value: 1 }, { type: "object", oneOf: [{ type: "object" }, { type: "object", required: ["value"] }] })).toBe(false);
  });

  it("models the group route's scalar ID shorthand and tolerated extension fields", async () => {
    const { validateApiV1RequestBody } = await import("@/lib/apiV1OperationContract");
    expect(validateApiV1RequestBody("POST /api/v1/groups", { ids: "shape-a" })).toBe(true);
    expect(validateApiV1RequestBody("POST /api/v1/groups", { ids: ["shape-a", "shape-b"], clientTag: "batch-7" })).toBe(true);
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

  it("contracts alignment and distribution request and response behavior", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const align = API_V1_OPERATIONS.find(({ method, path: route }) => method === "POST" && route === "/api/v1/align");
    const distribute = API_V1_OPERATIONS.find(({ method, path: route }) => method === "POST" && route === "/api/v1/distribute");
    expect(align).toMatchObject({
      operationId: "alignShapes",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 422, 500, 503],
      requestBody: { contentType: "application/json", required: true },
    });
    expect(distribute).toMatchObject({
      operationId: "distributeShapes",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 422, 500, 503],
      requestBody: { contentType: "application/json", required: true },
    });
    const alignBody = { ids: ["left", "right"], axis: "y", target: "max", anchorId: "right" };
    const distributeBody = { ids: ["left", "middle", "right"], axis: "x", spacing: "centers" };
    expect(contract.validateApiV1RequestBody("POST /api/v1/align", alignBody)).toBe(true);
    expect(contract.validateApiV1RequestBody("POST /api/v1/align", { ids: ["a", "b"], axis: "q", target: "max" })).toBe(false);
    expect(contract.validateApiV1RequestBody("POST /api/v1/distribute", distributeBody)).toBe(true);
    expect(contract.validateApiV1RequestBody("POST /api/v1/distribute", { ids: ["a", "b", "c"], axis: "y" })).toBe(false);
    expect(contract.validateApiV1RequestBody("POST /api/v1/distribute", { ids: ["a", "b", "c"], spacing: "centres" })).toBe(false);

    const aligned = { moved: 1, axis: "y", target: "max", anchorId: "right", shapes: [], revision: 12 };
    const distributed = { moved: 1, axis: "x", spacing: "centers", shapes: [], revision: 13 };
    expect(contract.validateApiV1Response("POST /api/v1/align", 200, aligned)).toBe(true);
    expect(contract.validateApiV1Response("POST /api/v1/align", 200, { ...aligned, moved: -1 })).toBe(false);
    expect(contract.validateApiV1Response("POST /api/v1/distribute", 200, distributed)).toBe(true);
    expect(contract.validateApiV1Response("POST /api/v1/distribute", 200, { ...distributed, spacing: "equal" })).toBe(false);
    for (const key of ["POST /api/v1/align", "POST /api/v1/distribute"]) {
      for (const status of [400, 401, 404, 409, 422, 500, 503]) {
        expect(contract.validateApiV1Response(key, status, { error: "failure", code: "invalid_request" })).toBe(true);
      }
      expect(contract.validateApiV1Response(key, 418, { error: "failure", code: "invalid_request" })).toBe(false);
    }
  });

  it("contracts boolean, treatment, shell, and draft-prism runtime behavior", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const keys = ["POST /api/v1/booleans", "POST /api/v1/treatments", "POST /api/v1/shell", "POST /api/v1/draft-prism"];
    for (const key of keys) {
      const item = API_V1_OPERATIONS.find(({ method, path: route }) => `${method} ${route}` === key)!;
      expect(item.requestBody).toBeDefined();
      expect(item.responses).toContain(400);
      expect(item.responses).toContain(422);
      expect(item.responseSchemas).toBeDefined();
      const responses = item.responseSchemas as Record<number, unknown>;
      for (const status of item.responses ?? []) expect(responses[status]).toBeDefined();
      expect(responses[200] ?? responses[201]).toMatchObject({
        type: "object", required: ["shape", "triangles", "revision"],
      });
    }
    expect(contract.validateApiV1RequestBody(keys[0], { solidIds: ["base"], holeIds: ["cutter"] })).toBe(true);
    expect(contract.validateApiV1RequestBody(keys[0], { solidIds: [], holeIds: ["cutter"] })).toBe(false);
    expect(contract.validateApiV1RequestBody(keys[1], { kind: "fillet", amount: 1, edges: "all" })).toBe(true);
    expect(contract.validateApiV1RequestBody(keys[1], { kind: "fillet", amount: 0 })).toBe(false);
    expect(contract.validateApiV1RequestBody(keys[2], { thickness: 2, openFaces: ["top", 3] })).toBe(true);
    expect(contract.validateApiV1RequestBody(keys[2], { thickness: 0 })).toBe(false);
    expect(contract.validateApiV1RequestBody(keys[3], { angle: 5 })).toBe(true);
    expect(contract.validateApiV1RequestBody(keys[3], { angle: 0 })).toBe(false);
    const success = { shape: { id: "out", name: "out", kind: "brep", color: "#ffffff", hole: false, locked: false, hidden: false, x: 0, z: 0, elevation: 0, width: 1, depth: 1, rotation: 0, rotationX: 0, rotationZ: 0 }, triangles: 0, revision: 3 };
    expect(contract.validateApiV1Response(keys[0], 201, success)).toBe(true);
    expect(contract.validateApiV1Response(keys[1], 200, success)).toBe(true);
    expect(contract.validateApiV1Response(keys[2], 200, { ...success, triangles: -1 })).toBe(false);
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
          topology: { type: "string", pattern: "^(mesh|exact)$" },
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
      400: { type: "object", properties: { code: { enum: ["invalid_project_id", "invalid_shape_id", "invalid_request"] } } },
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

  it("declares and validates GET /edges against the ordered CAD edge listing", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/edges");
    expect(operation).toMatchObject({
      operationId: "listEdges",
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
          type: "object", required: ["edges"], additionalProperties: false,
          properties: {
            edges: {
              type: "array",
              items: {
                type: "object", required: ["index", "length", "curveType", "midpoint", "filletable"], additionalProperties: false,
                properties: {
                  index: { type: "integer", minimum: 0 },
                  length: { type: "number", minimum: 0 },
                  curveType: { type: "string" },
                  midpoint: { type: "object", required: ["x", "y", "z"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
                  filletable: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    });
    expect(operation?.responseSchemas).toMatchObject({
      400: { properties: { code: { enum: ["invalid_project_id", "invalid_shape_id"] } } },
      401: { properties: { code: { enum: ["unauthorized"] } } },
      404: { properties: { code: { enum: ["api_disabled", "project_not_found", "shape_not_found"] } } },
      422: { properties: { code: { enum: ["cad_failed"] } } },
      500: { properties: { code: { enum: ["cad_failed", "internal_error"] } } },
      503: { properties: { code: { enum: ["storage_unconfigured"] } } },
    });
    const response = { edges: [{ index: 0, length: 4, curveType: "line", midpoint: { x: 0, y: 0, z: 0 }, filletable: true }] };
    expect(contract.validateApiV1Response("GET /api/v1/edges", 200, response)).toBe(true);
    expect(contract.validateApiV1Response("GET /api/v1/edges", 200, { edges: [{ ...response.edges[0], filletable: "yes" }] })).toBe(false);
    expect(contract.parseListEdgesResponse(response)).toEqual(response);
    expect(contract.parseListEdgesResponse({ edges: [{ ...response.edges[0], length: Number.NaN }] })).toBeNull();
    expect(contract.parseListEdgesResponse({ edges: [{ ...response.edges[0], midpoint: { x: 0, y: 0, z: 0, w: 1 } }] })).toBeNull();
    expect(contract.parseListEdgesResponse({ edges: [{ ...response.edges[0], unexpected: true }] })).toBeNull();
    expect(contract.parseApiV1Query("GET /api/v1/edges", new Request("https://example.test/api/v1/edges?projectId=%20part_1%20&shapeId=%20solid%20")))
      .toEqual({ ok: true, values: { projectId: "part_1", shapeId: "solid" } });
    expect(contract.validateApiV1Response("GET /api/v1/edges", 409, { error: "busy", code: "project_busy" })).toBe(false);
  });

  it("declares and validates GET /thickness against the sampled wall estimate", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/thickness");
    expect(operation).toMatchObject({
      operationId: "estimateThickness",
      auth: "bearer",
      responses: [200, 400, 401, 404, 413, 422, 500, 503],
      query: { required: ["projectId", "shapeId"] },
    });
    const result = { thickness: { minimum: 2, unit: "mm", method: "sampled-opposing-surface-distance", samplesPerFace: 25, facesChecked: 6 } };
    expect(contract.validateApiV1Response("GET /api/v1/thickness", 200, result)).toBe(true);
    expect(contract.validateApiV1Response("GET /api/v1/thickness", 200, { thickness: { ...result.thickness, minimum: "thin" } })).toBe(false);
    expect(contract.validateApiV1Response("GET /api/v1/thickness", 200, { thickness: { ...result.thickness, minimum: null } })).toBe(true);
    expect(contract.parseThicknessResponse(result)).toEqual(result);
    expect(contract.parseThicknessResponse({ thickness: { ...result.thickness, minimum: Number.POSITIVE_INFINITY } })).toBeNull();
    expect(contract.parseThicknessResponse({ thickness: { ...result.thickness, facesChecked: 1.5 } })).toBeNull();
    expect(contract.parseThicknessResponse({ thickness: { ...result.thickness, extra: true } })).toBeNull();
    expect(contract.validateApiV1Response("GET /api/v1/thickness", 413, { error: "too many faces", code: "geometry_failed" })).toBe(true);
    expect(contract.validateApiV1Response("GET /api/v1/thickness", 409, { error: "busy", code: "project_busy" })).toBe(false);
  });

  it("declares and validates GET /properties against the complete mass-properties response", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/properties");
    expect(operation).toMatchObject({
      operationId: "getShapeProperties",
      auth: "bearer",
      responses: [200, 400, 401, 404, 422, 500, 503],
      query: { required: ["projectId", "shapeId"] },
      responseSchemas: {
        200: {
          type: "object", required: ["properties"], additionalProperties: false,
          properties: {
            properties: {
              type: "object", required: ["volume", "area", "centerOfMass", "bbox", "isValid", "provenance"], additionalProperties: false,
              properties: {
                volume: { type: "number" },
                area: { type: "number" },
                centerOfMass: { type: "object", required: ["x", "y", "z"], additionalProperties: false, properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
                bbox: { type: "object", required: ["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"], additionalProperties: false, properties: { xmin: { type: "number" }, ymin: { type: "number" }, zmin: { type: "number" }, xmax: { type: "number" }, ymax: { type: "number" }, zmax: { type: "number" } } },
                isValid: { type: "boolean" },
                provenance: { type: "object", required: ["source", "precision"], additionalProperties: false, properties: { source: { type: "string", enum: ["parametric", "brep", "mesh"] }, precision: { type: "string", enum: ["exact", "tessellated"] } } },
              },
            },
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
    expect(contract.parseShapePropertiesResponse({ properties: { ...properties, extra: true } })).toBeNull();
    expect(contract.parseShapePropertiesResponse({ properties: { ...properties, bbox: { ...properties.bbox, extra: 1 } } })).toBeNull();
    expect(contract.parseShapePropertiesResponse({ properties: { ...properties, provenance: { ...properties.provenance, extra: true } } })).toBeNull();
    expect(contract.validateApiV1Response("GET /api/v1/properties", 200, { properties })).toBe(true);
    expect(contract.validateApiV1Response("GET /api/v1/properties", 409, { error: "busy", code: "project_busy" })).toBe(false);
    expect(contract.validateApiV1Response("GET /api/v1/properties", 422, { error: "invalid geometry", code: "cad_failed" })).toBe(true);
  });

  it("declares and validates GET /measurements against every edge and face result", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "GET" && route === "/api/v1/measurements");
    expect(operation).toMatchObject({
      operationId: "listMeasurements",
      auth: "bearer",
      responses: [200, 400, 401, 404, 409, 500, 503],
      query: { required: ["projectId", "shapeId"] },
      responseSchemas: { 200: { type: "object", required: ["measurements"] } },
    });
    const measurements = [
      { entity: "edge", index: 0, geometryType: "circle", length: 2, area: null, radius: 1, diameter: 2, sweepDegrees: 360, radiusUnavailable: null },
      { entity: "face", index: 0, geometryType: "plane", length: null, area: 6, radius: null, diameter: null, sweepDegrees: null, radiusUnavailable: "notCurved" },
    ];
    expect(contract.parseMeasurementsResponse({ measurements })).toEqual({ measurements });
    expect(contract.validateApiV1Response("GET /api/v1/measurements", 200, { measurements })).toBe(true);
    expect(contract.validateApiV1Response("GET /api/v1/measurements", 200, { measurements: [{ ...measurements[0], radius: "1" }] })).toBe(false);
    expect(contract.parseMeasurementsResponse({ measurements: [{ ...measurements[0], entity: "vertex" }] })).toBeNull();
    expect(contract.parseMeasurementsResponse({ measurements: [{ ...measurements[1], radiusUnavailable: "unknown" }] })).toBeNull();
    expect(contract.parseMeasurementsResponse({ measurements: [{ ...measurements[0], area: "6" }] })).toBeNull();
  });

  it("declares and validates POST /measurements between-entity requests and results", async () => {
    const contract = await import("@/lib/apiV1OperationContract");
    const operation = API_V1_OPERATIONS.find(({ method, path: route }) => method === "POST" && route === "/api/v1/measurements");
    if (!operation) throw new Error("POST /api/v1/measurements must be registered");
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
          properties: { from: { type: "object", oneOf: expect.any(Array) }, to: { type: "object", oneOf: expect.any(Array) } },
        },
      },
      responseSchemas: { 200: { type: "object", oneOf: expect.any(Array) } },
    });
    expect(contract.parseMeasureBetweenRequest({ from: { shapeId: " block-a " }, to: { shapeId: "block-b", entity: "face", index: 2 } }))
      .toEqual({ ok: true, from: { shapeId: "block-a", entity: "shape" }, to: { shapeId: "block-b", entity: "face", index: 2 } });
    expect(contract.parseMeasureBetweenRequest({ from: { shapeId: "a", entity: "edge" }, to: { shapeId: "b" } }))
      .toMatchObject({ ok: false, side: "from" });
    expect(contract.parseMeasureBetweenRequest({ from: { shapeId: "a", entity: "vertex", index: 0 }, to: { shapeId: "b" } }))
      .toMatchObject({ ok: false, side: "from" });
    const bodySchema = operation.requestBody && "schema" in operation.requestBody ? operation.requestBody.schema : undefined;
    expect(bodySchema).toBeDefined();
    expect(contract.validateApiV1Schema({ from: { shapeId: "a" }, to: { shapeId: "b", entity: "face", index: 0 } }, bodySchema!)).toBe(true);
    expect(contract.validateApiV1Schema({ from: { shapeId: "a", entity: "edge" }, to: { shapeId: "b" } }, bodySchema!)).toBe(false);
    expect(contract.parseMeasureBetweenResponse({ distance: 12, angleDegrees: null, angleUnavailable: "notPlanar" }))
      .toEqual({ distance: 12, angleDegrees: null, angleUnavailable: "notPlanar" });
    expect(contract.validateApiV1Response("POST /api/v1/measurements", 200, { distance: 12, angleDegrees: null, angleUnavailable: "notPlanar" })).toBe(true);
    expect(contract.validateApiV1Response("POST /api/v1/measurements", 200, { distance: 12, angleDegrees: 90, angleUnavailable: "degenerateNormal" })).toBe(false);
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
