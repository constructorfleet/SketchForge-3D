/**
 * Runtime-facing inventory for the public REST API. This deliberately does
 * not claim to be OpenAPI: schemas and response details are added as routes
 * migrate, and the parity test prevents public handlers from being omitted.
 */

export type ApiV1Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

export type ApiV1FieldSchema = {
  type: "number" | "integer" | "boolean" | "string" | "object" | "array";
  nullable?: true;
  required?: readonly string[];
  enum?: readonly string[];
  default?: string;
  minimum?: number;
  maximum?: number;
  minimumLength?: number;
  maximumLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  oneOf?: readonly ApiV1FieldSchema[];
  additionalProperties?: boolean | ApiV1FieldSchema;
  description?: string;
  properties?: Readonly<Record<string, ApiV1FieldSchema>>;
  items?: ApiV1FieldSchema;
};

export type ApiV1Operation = {
  operationId: string;
  method: ApiV1Method;
  path: `/api/v1/${string}`;
  auth: "bearer" | "none";
  description?: string;
  /** Populated only for routes whose response set has been verified. */
  responses?: readonly number[];
  responseSchemas?: Readonly<Record<number, ApiV1FieldSchema>>;
  query?: {
    required: readonly string[];
    properties: Readonly<Record<string, { type: "string"; trim?: true; pattern?: string; minLength?: number; maxLength?: number; description?: string }>>;
  };
  response?: {
    required: readonly string[];
    faceFields?: readonly string[];
    faceIdSemantics?: string;
    colorAssignmentKey?: string;
    kind?: "shape-properties";
    fields?: readonly string[];
    provenance?: { source: readonly string[]; precision: readonly string[] };
    schema?: ApiV1FieldSchema;
  };
  requestBody?: ApiV1CreateProjectRequestBody | ApiV1ShapePatchRequestBody | ApiV1MeasureBetweenRequestBody | { contentType: "application/json"; required: true; schema: ApiV1FieldSchema };
};

export type ApiV1CreateProjectRequestBody = {
  contentType: "application/json";
  required: true;
  normalization: readonly ["trim", "truncate:80"];
  schema: { type: "object"; required: readonly ["name"]; properties: { name: { type: "string"; minimumLength: 1; maximumLength: 80 } } };
};

export type ApiV1ShapePatchRequestBody = {
  contentType: "application/json";
  required: true;
  schema?: ApiV1FieldSchema;
  faceColors: {
    type: "object";
    keyKinds: readonly ["stable-face-id", "legacy-numeric-index"];
    keyPattern: string;
    colorPattern: string;
  };
};

export type ApiV1MeasureBetweenRequestBody = {
  contentType: "application/json";
  required: true;
  schema: ApiV1FieldSchema;
};

const operation = (
  method: ApiV1Method,
  route: `/api/v1/${string}`,
  operationId: string,
  responses?: readonly number[],
  requestBody?: ApiV1Operation["requestBody"],
  auth: ApiV1Operation["auth"] = "bearer",
): ApiV1Operation => ({ operationId, method, path: route, auth, ...(responses ? { responses } : {}), ...(requestBody ? { requestBody } : {}) });

const createProjectRequestBody = {
  contentType: "application/json",
  required: true,
  normalization: ["trim", "truncate:80"],
  schema: { type: "object", required: ["name"], properties: { name: { type: "string", minimumLength: 1, maximumLength: 80 } } },
} as const;

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const int = { type: "integer" } as const;
const projectSummary = { type: "object", required: ["id", "name", "shapes", "revision", "updatedAt", "packageBytes"], properties: { id: str, name: str, shapes: int, revision: num, updatedAt: num, packageBytes: int } } as const;
function stepAssemblyNodeSchema(remainingDepth: number): ApiV1FieldSchema {
  return {
    type: "object",
    required: ["name", "children"],
    properties: {
      name: str,
      children: {
        type: "array",
        maxItems: 2000,
        description: "Direct product children; hierarchy depth is capped at 32.",
        ...(remainingDepth > 1
          ? { items: stepAssemblyNodeSchema(remainingDepth - 1) }
          : { maxItems: 0 }),
      },
    },
    additionalProperties: false,
  };
}
const shapeSummary = {
  type: "object",
  required: ["id", "name", "kind", "color", "hole", "locked", "hidden", "x", "z", "elevation", "width", "depth", "rotation", "rotationX", "rotationZ"],
  properties: {
    id: str,
    name: str,
    kind: str,
    requestKind: str,
    sketchOperation: str,
    sketchProfile: {
      type: "object",
      required: ["points", "segments"],
      properties: {
        points: { type: "array", items: { type: "object", additionalProperties: true } },
        segments: { type: "array", items: { type: "object", additionalProperties: true } },
        sweepFrames: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },
    color: str,
    faceIds: { type: "array", items: str },
    faceColors: { type: "object", additionalProperties: str },
    stepAssembly: {
      type: "array",
      description: "Optional STEP product hierarchy metadata. The imported geometry remains a single mesh.",
      items: stepAssemblyNodeSchema(32),
    },
    hole: { type: "boolean" },
    locked: { type: "boolean" },
    hidden: { type: "boolean" },
    x: num,
    z: num,
    elevation: num,
    width: num,
    depth: num,
    height: num,
    rotation: num,
    rotationX: num,
    rotationZ: num,
    groupedCount: int,
    revolve: { type: "object", additionalProperties: true },
    profile: { type: "array", items: { type: "array", minItems: 2, maxItems: 2, items: num } },
  },
} as const;
const errorSchema = { type: "object", required: ["error", "code"], properties: { error: str, code: { type: "string", enum: ["api_disabled", "unauthorized", "storage_unconfigured", "invalid_project_id", "invalid_shape_id", "invalid_body", "invalid_request", "project_not_found", "project_exists", "project_busy", "shape_not_found", "shape_locked", "unsupported_kind", "unsupported_format", "unapplicable_fields", "too_many_shapes", "geometry_failed", "cad_failed", "internal_error"] } }, additionalProperties: true } as const;
const faceError = (...codes: string[]): ApiV1FieldSchema => ({ type: "object", required: ["error", "code"], properties: { error: str, code: { type: "string", enum: codes } }, additionalProperties: false });
const vector3Schema = { type: "object", required: ["x", "y", "z"], properties: { x: num, y: num, z: num }, additionalProperties: false } as const;
const faceItemSchema = {
  type: "object",
  required: ["index", "id", "surfaceType", "area", "centroid", "normal", "facing"],
  properties: {
    index: { type: "integer", minimum: 0, description: "Zero-based index used by shell requests." },
    id: { type: "string", description: "Application-owned face ID; use it as the faceColors key in PATCH /api/v1/shapes." },
    surfaceType: { type: "string", description: "Surface kind reported by the CAD kernel, or unknown when unavailable." },
    area: { type: "number", minimum: 0 },
    centroid: vector3Schema,
    normal: { ...vector3Schema, nullable: true },
    facing: { type: "string", nullable: true, enum: ["top", "bottom", "right", "left", "front", "back"] },
  },
  additionalProperties: false,
} as const;
const faceListSchema = { type: "object", required: ["faces"], properties: { faces: { type: "array", items: faceItemSchema } }, additionalProperties: false } as const;
const projectDetail = { type: "object", required: ["project"], properties: { project: { type: "object", required: ["id", "name", "createdAt", "snapGrid", "workspace", "shapes"], properties: { id: str, name: str, createdAt: num, snapGrid: str, workspace: { type: "object", additionalProperties: true }, shapes: { type: "array", items: shapeSummary } } } } } as const;
const projectList = { type: "object", required: ["projects"], properties: { projects: { type: "array", items: projectSummary } } } as const;
const shapesList = { type: "object", required: ["shapes"], properties: { shapes: { type: "array", items: shapeSummary } } } as const;
const projectQuery = { required: ["projectId"], properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 } } } as const;
const shapeQuery = { required: ["projectId", "shapeId"], properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 }, shapeId: { type: "string", trim: true, minLength: 1 } } } as const;
const json = (schema: ApiV1FieldSchema) => ({ contentType: "application/json" as const, required: true as const, schema });
const commonErrors = [400, 401, 404, 409, 500, 503] as const;
const projectOperations = [
  { ...operation("GET", "/api/v1/projects", "listProjectsOrGetProject", [200, ...commonErrors]), query: { required: [], properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 } } }, responseSchemas: { 200: { type: "object", oneOf: [projectList, projectDetail] }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("POST", "/api/v1/projects", "createProject", [201, ...commonErrors], createProjectRequestBody), responseSchemas: { 201: { type: "object", required: ["project"], properties: { project: projectSummary } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("DELETE", "/api/v1/projects", "deleteProject", [200, ...commonErrors]), query: projectQuery, responseSchemas: { 200: { type: "object", required: ["deleted", "id"], properties: { deleted: { type: "boolean" }, id: str } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
] as const satisfies readonly ApiV1Operation[];

export function validateApiV1Schema(value: unknown, schema: ApiV1FieldSchema): boolean {
  if (schema.oneOf) return schema.oneOf.some((candidate) => validateApiV1Schema(value, candidate));
  if (schema.nullable && value === null) return true;
  if (schema.type === "array") return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && (!schema.items || value.every((item) => validateApiV1Schema(item, schema.items!)));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.required?.some((name) => !(name in object))) return false;
    if (Object.entries(schema.properties ?? {}).some(([name, child]) => name in object && !validateApiV1Schema(object[name], child))) return false;
    if (schema.additionalProperties === false && Object.keys(object).some((name) => !(name in (schema.properties ?? {})))) return false;
    if (typeof schema.additionalProperties === "object" && Object.entries(object).some(([name, child]) => !(name in (schema.properties ?? {})) && !validateApiV1Schema(child, schema.additionalProperties as ApiV1FieldSchema))) return false;
    return true;
  }
  if (schema.type === "string") return typeof value === "string" && (!schema.enum || schema.enum.includes(value)) && (!schema.pattern || new RegExp(schema.pattern).test(value)) && (schema.minimumLength === undefined || value.length >= schema.minimumLength) && (schema.maximumLength === undefined || value.length <= schema.maximumLength);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  return false;
}

export function validateApiV1RequestBody(key: string, value: unknown): boolean {
  const operation = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === key);
  const body = operation?.requestBody;
  if (!body || !value || typeof value !== "object" || Array.isArray(value)) return false;
  if (key === "POST /api/v1/projects") return Boolean(parseCreateProjectRequest(value as Record<string, unknown>));
  if (key === "PATCH /api/v1/shapes") return parseShapePatchRequest(value as Record<string, unknown>).ok;
  if ("schema" in body && body.schema) return validateApiV1Schema(value, body.schema as ApiV1FieldSchema);
  return true;
}

export function parseApiV1Query(key: string, request: Request): { ok: true; values: Record<string, string> } | { ok: false; invalid: string[] } {
  const operation = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === key);
  if (!operation?.query) return { ok: true, values: {} };
  const params = new URL(request.url).searchParams;
  const values: Record<string, string> = {};
  const invalid: string[] = [];
  for (const name of operation.query.required) if (!params.has(name)) invalid.push(name);
  for (const [name, rule] of Object.entries(operation.query.properties)) {
    if (!params.has(name)) continue;
    const raw = params.get(name) ?? "";
    const normalized = rule.trim ? raw.trim() : raw;
    if ((rule.minLength !== undefined && normalized.length < rule.minLength) || (rule.maxLength !== undefined && normalized.length > rule.maxLength) || (rule.pattern && !new RegExp(rule.pattern).test(normalized))) invalid.push(name);
    else values[name] = normalized;
  }
  return invalid.length ? { ok: false, invalid } : { ok: true, values };
}

export function validateApiV1Response(key: string, status: number, body: unknown): boolean {
  const operation = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === key);
  const schema = (operation?.responseSchemas as Readonly<Record<number, ApiV1FieldSchema>> | undefined)?.[status];
  return Boolean(schema && validateApiV1Schema(body, schema));
}

export function withApiV1Contract(key: string, handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      const response = await handler(request);
      const body = await response.clone().json().catch(() => null);
      if (!validateApiV1Response(key, response.status, body)) return Response.json({ error: "The API handler returned a response outside its contract.", code: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
      return response;
    } catch {
      return Response.json({ error: "The request could not be completed.", code: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
const sketchSweepProfileRequest = { type: "object", required: ["points", "segments"], properties: { points: { type: "array", items: { type: "object", additionalProperties: true } }, segments: { type: "array", items: { type: "object", additionalProperties: true } }, sweepFrames: { type: "object", additionalProperties: true } }, additionalProperties: true } as const;
const revolveProfileRequest = { type: "array", items: { type: "array", minItems: 2, maxItems: 2, items: num } } as const;
const shapeRequest = { type: "object", required: ["kind"], properties: { kind: str, profile: { type: "object", oneOf: [sketchSweepProfileRequest, revolveProfileRequest] } }, additionalProperties: true } as const;
const shapeOperations = [
  { ...operation("GET", "/api/v1/shapes", "listShapes", [200, ...commonErrors]), query: projectQuery, responseSchemas: { 200: shapesList, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("POST", "/api/v1/shapes", "createShapes", [201, ...commonErrors, 413, 422]), query: projectQuery, requestBody: json({ type: "object", oneOf: [shapeRequest, { type: "object", required: ["shapes"], properties: { shapes: { type: "array", minItems: 1, maxItems: 200, items: shapeRequest } }, additionalProperties: false }] }), responseSchemas: { 201: { type: "object", required: ["shapes", "revision"], properties: { shapes: { type: "array", items: shapeSummary }, revision: num } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 413: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("PATCH", "/api/v1/shapes", "updateShape", [200, 400, 401, 404, 409, 422, 500, 503]), query: shapeQuery, requestBody: json({ type: "object", additionalProperties: true }), responseSchemas: { 200: { type: "object", required: ["shape", "revision"], properties: { shape: shapeSummary, revision: num } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("DELETE", "/api/v1/shapes", "deleteShape", [200, ...commonErrors]), query: shapeQuery, responseSchemas: { 200: { type: "object", required: ["deleted", "id", "revision"], properties: { deleted: { type: "boolean" }, id: str, revision: num } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
] as const satisfies readonly ApiV1Operation[];

export const API_V1_OPERATIONS = [
  operation("POST", "/api/v1/align", "alignShapes"),
  operation("POST", "/api/v1/booleans", "booleanShapes"),
  operation("POST", "/api/v1/distribute", "distributeShapes"),
  operation("POST", "/api/v1/draft-prism", "draftPrism"),
  operation("GET", "/api/v1/edges", "listEdges"),
  operation("OPTIONS", "/api/v1/edges", "edgeRouteOptions", [204], undefined, "none"),
  operation("POST", "/api/v1/explode", "explodeAssembly"),
  operation("POST", "/api/v1/exports", "exportProject"),
  {
    ...operation("GET", "/api/v1/faces", "listFaces", [200, 400, 401, 404, 422, 500, 503]),
    description: "Lists each face with its shell-request index and stable application-owned ID. Face IDs can be used as faceColors keys in PATCH /api/v1/shapes.",
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120, description: "Whitespace is trimmed before validation. ID starts with a letter or digit and contains only letters, digits, underscores, and hyphens." },
        shapeId: { type: "string", trim: true, minLength: 1, description: "Whitespace is trimmed; the remaining value must not be empty." },
      },
    },
    responseSchemas: {
      200: faceListSchema,
      400: faceError("invalid_project_id", "invalid_shape_id"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      422: faceError("cad_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  operation("OPTIONS", "/api/v1/faces", "faceRouteOptions", [204], undefined, "none"),
  operation("POST", "/api/v1/groups", "groupShapes"),
  operation("DELETE", "/api/v1/groups", "ungroupShape"),
  operation("POST", "/api/v1/imports", "importGeometry"),
  operation("POST", "/api/v1/interference", "analyzeInterference"),
  {
    ...operation("GET", "/api/v1/measurements", "listMeasurements", [200, 400, 401, 404, 409, 422, 500, 503]),
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
        shapeId: { type: "string", trim: true },
      },
    },
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
  },
  {
    ...operation("POST", "/api/v1/measurements", "measureEntities", [200, 400, 401, 404, 409, 422, 500, 503], {
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
    }),
    query: {
      required: ["projectId"],
      properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 } },
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
  },
  operation("POST", "/api/v1/mirrors", "mirrorShapes"),
  operation("POST", "/api/v1/parts", "splitParts"),
  operation("POST", "/api/v1/patterns", "patternShapes"),
  ...projectOperations,
  {
    ...operation("GET", "/api/v1/properties", "getShapeProperties", [200, 400, 401, 404, 409, 500, 503]),
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
        shapeId: { type: "string", trim: true },
      },
    },
    response: {
      required: ["properties"],
      kind: "shape-properties",
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
  },
  operation("OPTIONS", "/api/v1/properties", "propertyRouteOptions", [204], undefined, "none"),
  ...shapeOperations.slice(0, 2),
  { ...shapeOperations[2], requestBody: { ...shapeOperations[2].requestBody!, faceColors: { type: "object", keyKinds: ["stable-face-id", "legacy-numeric-index"], keyPattern: "^(?:[0-9]+|face_[^\\s]+)$", colorPattern: "^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$" } } } as ApiV1Operation,
  shapeOperations[3],
  operation("POST", "/api/v1/shell", "shellShape"),
  operation("GET", "/api/v1/thickness", "estimateThickness"),
  operation("OPTIONS", "/api/v1/thickness", "thicknessRouteOptions", [204], undefined, "none"),
  operation("POST", "/api/v1/treatments", "treatShape"),
] as const satisfies readonly ApiV1Operation[];

export type CreateProjectRequest = { name: string };

/** Validate and normalize the first migrated request schema at runtime. */
export function parseCreateProjectRequest(body: Record<string, unknown>): CreateProjectRequest | null {
  if (typeof body.name !== "string") return null;
  const name = body.name.trim().slice(0, 80);
  return name ? { name } : null;
}

export type ListFacesQuery = { projectId: string; shapeId: string };
export type ListFacesResponse = {
  faces: Array<{
    index: number;
    id: string;
    surfaceType: string;
    area: number;
    centroid: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number } | null;
    facing: "top" | "bottom" | "right" | "left" | "front" | "back" | null;
  }>;
};

/** Apply the same normalization and project-id validation as the GET /faces handler. */
export function parseApiTargetQuery(request: Request):
  | { ok: true; projectId: string; shapeId: string }
  | { ok: false; error: "invalid_project_id" | "invalid_shape_id" } {
  const params = new URL(request.url).searchParams;
  const requestedProject = params.get("projectId")?.trim() ?? "";
  if (!requestedProject || requestedProject.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(requestedProject)) {
    return { ok: false, error: "invalid_project_id" };
  }
  const shapeId = params.get("shapeId")?.trim();
  if (!shapeId) return { ok: false, error: "invalid_shape_id" };
  return { ok: true, projectId: requestedProject, shapeId };
}

function isPoint(value: unknown): value is { x: number; y: number; z: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return [point.x, point.y, point.z].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
}

/** Validate the response shape returned by the engine before it crosses the REST boundary. */
export function parseListFacesResponse(value: unknown): ListFacesResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["faces"]) || !Array.isArray((value as { faces?: unknown }).faces)) return null;
  const faces = (value as { faces: unknown[] }).faces;
  const directions = new Set(["top", "bottom", "right", "left", "front", "back"]);
  for (const face of faces) {
    if (!face || typeof face !== "object" || Array.isArray(face) || !exactKeys(face, ["index", "id", "surfaceType", "area", "centroid", "normal", "facing"])) return null;
    const item = face as Record<string, unknown>;
    if (!Number.isInteger(item.index) || (item.index as number) < 0) return null;
    if (typeof item.id !== "string" || typeof item.surfaceType !== "string") return null;
    if (typeof item.area !== "number" || !Number.isFinite(item.area) || item.area < 0) return null;
    if (!isPoint(item.centroid) || !(item.normal === null || isPoint(item.normal))) return null;
    if (!(item.facing === null || (typeof item.facing === "string" && directions.has(item.facing)))) return null;
  }
  return value as ListFacesResponse;
}

function exactKeys(value: object, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export type ShapePropertiesResponse = {
  properties: {
    volume: number;
    area: number;
    centerOfMass: { x: number; y: number; z: number };
    bbox: { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };
    isValid: boolean;
    provenance: { source: "parametric" | "brep" | "mesh"; precision: "exact" | "tessellated" };
  };
};

/** Reject malformed kernel values before returning them as a public API response. */
export function parseShapePropertiesResponse(value: unknown): ShapePropertiesResponse | null {
  if (!value || typeof value !== "object") return null;
  const properties = (value as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return null;
  const item = properties as Record<string, unknown>;
  const bbox = item.bbox;
  if (typeof item.volume !== "number" || !Number.isFinite(item.volume) || typeof item.area !== "number" || !Number.isFinite(item.area)) return null;
  if (!isPoint(item.centerOfMass) || typeof item.isValid !== "boolean") return null;
  if (!bbox || typeof bbox !== "object") return null;
  const bounds = bbox as Record<string, unknown>;
  if (!["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]))) return null;
  const provenance = item.provenance;
  if (!provenance || typeof provenance !== "object") return null;
  const source = (provenance as Record<string, unknown>).source;
  const precision = (provenance as Record<string, unknown>).precision;
  if (!(source === "parametric" || source === "brep" || source === "mesh")) return null;
  if (!(precision === "exact" || precision === "tessellated")) return null;
  return value as ShapePropertiesResponse;
}

export type MeasurementsResponse = {
  measurements: Array<{
    entity: "edge" | "face";
    index: number;
    geometryType: string;
    length: number | null;
    area: number | null;
    radius: number | null;
    diameter: number | null;
    sweepDegrees: number | null;
    radiusUnavailable: "notCircular" | "ellipseHasNoSingleRadius" | "degenerateCurve" | "notCurved" | "radiusVariesOverSurface" | "radiusNotReportedByKernel" | "degenerateSurface" | null;
  }>;
};

/** Validate every required entry field and nullable measurement value. */
export function parseMeasurementsResponse(value: unknown): MeasurementsResponse | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { measurements?: unknown }).measurements)) return null;
  const unavailableCodes = new Set(["notCircular", "ellipseHasNoSingleRadius", "degenerateCurve", "notCurved", "radiusVariesOverSurface", "radiusNotReportedByKernel", "degenerateSurface"]);
  for (const measurement of (value as { measurements: unknown[] }).measurements) {
    if (!measurement || typeof measurement !== "object") return null;
    const entry = measurement as Record<string, unknown>;
    if (!(entry.entity === "edge" || entry.entity === "face")) return null;
    if (!Number.isInteger(entry.index) || (entry.index as number) < 0 || typeof entry.geometryType !== "string") return null;
    for (const key of ["length", "area", "radius", "diameter", "sweepDegrees"]) {
      const field = entry[key];
      if (!(field === null || (typeof field === "number" && Number.isFinite(field)))) return null;
    }
    if (!(entry.radiusUnavailable === null || (typeof entry.radiusUnavailable === "string" && unavailableCodes.has(entry.radiusUnavailable)))) return null;
  }
  return value as MeasurementsResponse;
}

type ParsedMeasurementEnd = { shapeId: string; entity: "shape" | "edge" | "face"; index?: number };

export type MeasureBetweenRequestResult =
  | { ok: true; from: ParsedMeasurementEnd; to: ParsedMeasurementEnd }
  | { ok: false; side: "from" | "to"; error: string };

/** Apply the route's defaults and validation to both endpoints of a measurement request. */
export function parseMeasureBetweenRequest(body: Record<string, unknown>): MeasureBetweenRequestResult {
  const parseEnd = (value: unknown): ParsedMeasurementEnd | string => {
    if (!value || typeof value !== "object") return "must be an object with a shapeId.";
    const candidate = value as Record<string, unknown>;
    const shapeId = typeof candidate.shapeId === "string" ? candidate.shapeId.trim() : "";
    if (!shapeId) return "needs a shapeId.";
    const requested = candidate.entity === undefined ? "shape" : candidate.entity;
    if (!(requested === "shape" || requested === "edge" || requested === "face")) {
      return `has an entity of ${JSON.stringify(requested)}; it must be one of edge, face, shape.`;
    }
    if (requested === "shape") return { shapeId, entity: requested };
    const index = candidate.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return `needs a whole, non-negative index to name which ${requested} to measure.`;
    }
    return { shapeId, entity: requested, index };
  };

  const from = parseEnd(body.from);
  if (typeof from === "string") return { ok: false, side: "from", error: from };
  const to = parseEnd(body.to);
  if (typeof to === "string") return { ok: false, side: "to", error: to };
  return { ok: true, from, to };
}

export type MeasureBetweenResponse = {
  distance: number;
  angleDegrees: number | null;
  angleUnavailable: "notPlanar" | "degenerateNormal" | null;
};

/** Validate the measured distance and its optional planar-face angle result. */
export function parseMeasureBetweenResponse(value: unknown): MeasureBetweenResponse | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (typeof result.distance !== "number" || !Number.isFinite(result.distance) || result.distance < 0) return null;
  if (!(result.angleDegrees === null || (typeof result.angleDegrees === "number" && Number.isFinite(result.angleDegrees) && result.angleDegrees >= 0 && result.angleDegrees <= 180))) return null;
  if (!(result.angleUnavailable === null || result.angleUnavailable === "notPlanar" || result.angleUnavailable === "degenerateNormal")) return null;
  if ((result.angleDegrees === null) === (result.angleUnavailable === null)) return null;
  return value as MeasureBetweenResponse;
}


export type ShapePatchRequest = Record<string, unknown>;

/** Validate face color syntax while preserving all other engine-supported patch fields. */
export function parseShapePatchRequest(body: Record<string, unknown>):
  | { ok: true; body: ShapePatchRequest }
  | { ok: false; error: "invalid_face_color_key" | "invalid_face_colors" } {
  if (!("faceColors" in body)) return { ok: true, body };
  const faceColors = body.faceColors;
  if (!faceColors || typeof faceColors !== "object" || Array.isArray(faceColors)) {
    return { ok: false, error: "invalid_face_colors" };
  }
  const entries = Object.entries(faceColors);
  if (entries.some(([key]) => !/^\d+$/.test(key) && !/^face_[^\s]+$/.test(key))) {
    return { ok: false, error: "invalid_face_color_key" };
  }
  if (entries.some(([, color]) => typeof color !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color))) {
    return { ok: false, error: "invalid_face_colors" };
  }
  return { ok: true, body };
}
