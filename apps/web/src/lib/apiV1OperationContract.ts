/**
 * Runtime-facing inventory for the public REST API. This deliberately does
 * not claim to be OpenAPI: schemas and response details are added as routes
 * migrate, and the parity test prevents public handlers from being omitted.
 */


export type ApiV1Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

export type ApiV1FieldSchema = {
  type?: "number" | "integer" | "boolean" | "string" | "object" | "array";
  nullable?: true;
  required?: readonly string[];
  enum?: readonly (string | null)[];
  default?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minimumLength?: number;
  maximumLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  oneOf?: readonly ApiV1FieldSchema[];
  anyOf?: readonly ApiV1FieldSchema[];
  not?: ApiV1FieldSchema;
  additionalProperties?: boolean | ApiV1FieldSchema;
  description?: string;
  format?: string;
  properties?: Readonly<Record<string, ApiV1FieldSchema>>;
  patternProperties?: Readonly<Record<string, ApiV1FieldSchema>>;
  items?: ApiV1FieldSchema;
};

export type ApiV1Operation = {
  operationId: string;
  method: ApiV1Method;
  path: `/api/v1/${string}`;
  auth: "bearer" | "none";
  description?: string;
  /** Maximum raw bytes accepted for the request body. */
  maxRequestBytes?: number;
  /** Write routes accept a project revision precondition. */
  ifMatch?: true;
  /** Populated only for routes whose response set has been verified. */
  responses?: readonly number[];
  responseSchemas?: Readonly<Record<number, ApiV1FieldSchema>>;
  binaryResponse?: {
    status: number;
    formatContentTypes: Readonly<Record<string, string>>;
    metadataHeader: string;
    metadataSchema: ApiV1FieldSchema;
  };
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
  requestBody?: ApiV1CreateProjectRequestBody | ApiV1ShapePatchRequestBody | ApiV1MeasureBetweenRequestBody | { contentType?: "application/json"; content?: Readonly<Record<string, ApiV1FieldSchema>>; required: true; schema?: ApiV1FieldSchema };
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

const DEFAULT_JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const operation = (
  method: ApiV1Method,
  route: `/api/v1/${string}`,
  operationId: string,
  responses?: readonly number[],
  requestBody?: ApiV1Operation["requestBody"],
  auth: ApiV1Operation["auth"] = "bearer",
): ApiV1Operation => ({
  operationId, method, path: route, auth,
  ...((method === "PATCH" || method === "DELETE" || (method === "POST" && !["/api/v1/measurements", "/api/v1/measure-between", "/api/v1/interference", "/api/v1/exports", "/api/v1/drawings", "/api/v1/thickness"].includes(route))) ? { ifMatch: true as const } : {}),
  ...(responses ? { responses } : {}), ...(requestBody ? { requestBody, maxRequestBytes: DEFAULT_JSON_BODY_LIMIT_BYTES } : {}),
});

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
      id: str,
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
    sketchSourceId: str,
    draftPrismAngle: num,
    faceDraft: {
      type: "object",
      required: ["sourceFaceId", "angle", "pullDirection", "sourceFaceNormal"],
      properties: {
        sourceFaceId: str,
        angle: num,
        pullDirection: { type: "string", enum: ["x", "y", "z", "-x", "-y", "-z"] },
        sourceFaceNormal: { type: "object", required: ["x", "y", "z"], properties: { x: num, y: num, z: num } },
      },
    },
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
      description: "Optional STEP product hierarchy metadata. Imported geometry remains one mesh until exploded.",
      items: stepAssemblyNodeSchema(32),
    },
    stepComponent: {
      type: "object",
      description: "STEP source occurrence identity and root-to-component ancestry for a selectable exploded solid.",
      required: ["id", "occurrenceId", "path"],
      properties: {
        id: str,
        occurrenceId: str,
        path: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name"],
            properties: { id: str, name: str },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
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
const errorSchema = { type: "object", required: ["error", "code"], properties: { error: str, code: { type: "string", enum: ["api_disabled", "unauthorized", "storage_unconfigured", "invalid_project_id", "invalid_shape_id", "invalid_body", "invalid_request", "project_not_found", "project_exists", "project_busy", "revision_mismatch", "shape_not_found", "shape_locked", "unsupported_kind", "unsupported_format", "unapplicable_fields", "too_many_shapes", "limit_exceeded", "geometry_failed", "cad_failed", "internal_error"] }, revision: num }, additionalProperties: true } as const;
const limitErrorSchema = { type: "object", required: ["error", "code"], properties: { error: str, code: { type: "string", enum: ["limit_exceeded"] }, limit: int, given: int }, additionalProperties: false } as const;
const faceError = (...codes: string[]): ApiV1FieldSchema => {
  const conditionalWriteError = codes.includes("project_busy") || codes.includes("shape_locked");
  return {
    type: "object",
    required: ["error", "code"],
    properties: {
      error: str,
      code: { type: "string", enum: conditionalWriteError ? [...new Set([...codes, "revision_mismatch"])] : codes },
      ...(conditionalWriteError ? { revision: num } : {}),
    },
    additionalProperties: false,
  };
};
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
const edgeItemSchema = {
  type: "object",
  required: ["index", "length", "curveType", "midpoint", "filletable"],
  properties: {
    index: { type: "integer", minimum: 0, description: "Zero-based position used by fillet and chamfer requests." },
    length: { type: "number", minimum: 0 },
    curveType: { type: "string", description: "Curve kind reported by the CAD kernel, or unknown when unavailable." },
    midpoint: vector3Schema,
    filletable: { type: "boolean", description: "Whether the edge has two adjacent faces and can be treated." },
  },
  additionalProperties: false,
} as const;
const edgeListSchema = { type: "object", required: ["edges"], properties: { edges: { type: "array", items: edgeItemSchema } }, additionalProperties: false } as const;
const thicknessSchema = {
  type: "object", required: ["thickness"], additionalProperties: false,
  properties: {
    thickness: {
      type: "object", required: ["minimum", "unit", "method", "samplesPerFace", "facesChecked"], additionalProperties: false,
      properties: {
        minimum: { type: "number", nullable: true, minimum: 0 },
        unit: { type: "string", enum: ["mm"] },
        method: { type: "string", enum: ["sampled-opposing-surface-distance"] },
        samplesPerFace: { type: "integer", minimum: 1 },
        facesChecked: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;
const measurementItemSchema = {
  type: "object",
  required: ["entity", "index", "geometryType", "length", "area", "radius", "diameter", "sweepDegrees", "radiusUnavailable"],
  properties: {
    entity: { type: "string", enum: ["edge", "face"] },
    index: { type: "integer", minimum: 0 },
    geometryType: str,
    length: { type: "number", nullable: true },
    area: { type: "number", nullable: true },
    radius: { type: "number", nullable: true },
    diameter: { type: "number", nullable: true },
    sweepDegrees: { type: "number", nullable: true },
    radiusUnavailable: { type: "string", nullable: true, enum: ["notCircular", "ellipseHasNoSingleRadius", "degenerateCurve", "notCurved", "radiusVariesOverSurface", "radiusNotReportedByKernel", "degenerateSurface"] },
  },
} as const;
const measurementListSchema = { type: "object", required: ["measurements"], properties: { measurements: { type: "array", items: measurementItemSchema } } } as const;
const measurementEndSchema = {
  type: "object",
  oneOf: [
    { type: "object", required: ["shapeId"], properties: { shapeId: { type: "string", pattern: "\\S", description: "Whitespace is trimmed; the remaining value must not be empty." } }, not: { type: "object", required: ["entity"] } },
    { type: "object", required: ["shapeId", "entity"], properties: { shapeId: { type: "string", pattern: "\\S" }, entity: { type: "string", enum: ["shape"] } } },
    { type: "object", required: ["shapeId", "entity", "index"], properties: { shapeId: { type: "string", pattern: "\\S" }, entity: { type: "string", enum: ["edge", "face"] }, index: { type: "integer", minimum: 0, description: "Zero-based edge or face index." } } },
  ],
} as const;
const measurementBetweenResponseSchema = {
  type: "object",
  oneOf: [
    { type: "object", required: ["distance", "angleDegrees", "angleUnavailable"], properties: { distance: { type: "number", minimum: 0 }, angleDegrees: { type: "number", minimum: 0, maximum: 180 }, angleUnavailable: { type: "string", nullable: true, enum: [] } } },
    { type: "object", required: ["distance", "angleDegrees", "angleUnavailable"], properties: { distance: { type: "number", minimum: 0 }, angleDegrees: { type: "number", nullable: true, enum: [null] }, angleUnavailable: { type: "string", enum: ["notPlanar", "degenerateNormal"] } } },
  ],
} as const;
const projectDetail = { type: "object", required: ["project"], properties: { project: { type: "object", required: ["id", "name", "createdAt", "snapGrid", "workspace", "shapes"], properties: { id: str, name: str, createdAt: num, snapGrid: str, workspace: { type: "object", additionalProperties: true }, shapes: { type: "array", items: shapeSummary } } } } } as const;
const projectList = { type: "object", required: ["projects", "nextCursor"], properties: { projects: { type: "array", items: projectSummary }, nextCursor: { type: "string", nullable: true } } } as const;
const shapesList = { type: "object", required: ["shapes", "nextCursor"], properties: { shapes: { type: "array", items: shapeSummary }, nextCursor: { type: "string", nullable: true } } } as const;
const projectQuery = { required: ["projectId"], properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 } } } as const;
const shapeQuery = { required: ["projectId", "shapeId"], properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 }, shapeId: { type: "string", trim: true, minLength: 1 } } } as const;
const json = (schema: ApiV1FieldSchema) => ({ contentType: "application/json" as const, required: true as const, schema });
const commonErrors = [400, 401, 404, 409, 500, 503] as const;
const exportFormats = ["stl", "obj", "3mf", "step", "skf", "zip", "svg", "dxf"] as const;
const exportViews = ["multiview", "front", "back", "top", "bottom", "left", "right", "iso"] as const;
const exportShapeIds = { oneOf: [
  { type: "string", pattern: "\\S", description: "A single non-empty shape ID is accepted as shorthand." },
  { type: "array", uniqueItems: true, items: { type: "string", pattern: "\\S" }, description: "IDs are trimmed and must be distinct after trimming." },
] } as const;
const exportRequestBody = json({
  type: "object",
  required: ["format"],
  properties: {
    format: { type: "string", enum: exportFormats },
    shapeIds: exportShapeIds,
    name: { type: "string", maximumLength: 120, description: "Optional output basename; an empty or omitted value uses the project name." },
    view: { type: "string", enum: exportViews, description: "SVG only; section and view are mutually exclusive." },
    featureAngle: { type: "number", minimum: 0, maximum: 180, description: "SVG projection only: crease angle in degrees for mesh shapes. An edge between two triangles is drawn only where they meet at more than this, besides boundaries and silhouettes. Defaults to 30; exact solids ignore it." },
    section: {
      type: "object",
      required: ["plane", "offset"],
      properties: {
        plane: { type: "string", enum: ["xy", "xz", "yz"] },
        offset: { type: "number", minimum: -100000, maximum: 100000, description: "Finite section-plane coordinate in millimetres." },
      },
      additionalProperties: true,
      description: "SVG or DXF only; section and view are mutually exclusive.",
    },
  },
  additionalProperties: true,
});
const exportResultFields = {
  format: { type: "string", enum: exportFormats },
  filename: str,
  mimeType: str,
  shapeCount: { type: "integer", minimum: 0 },
  exportedCount: { type: "integer", minimum: 0 },
  skipped: { type: "array", items: { type: "object", required: ["name", "kind", "reason"], properties: { name: str, kind: str, reason: str }, additionalProperties: false } },
} as const;
const exportResponseSchema = {
  type: "object",
  required: ["format", "filename", "mimeType", "bytes", "shapeCount", "base64"],
  properties: { ...exportResultFields, bytes: { type: "integer", minimum: 0 }, base64: str },
  additionalProperties: false,
} as const;
const exportMetadataSchema = {
  type: "object",
  required: ["format", "filename", "mimeType", "shapeCount"],
  properties: exportResultFields,
  additionalProperties: false,
} as const;
const exportFormatContentTypes = {
  stl: "model/stl",
  obj: "text/plain",
  "3mf": "model/3mf",
  step: "model/step",
  skf: "application/vnd.sketchforge.project+zip",
  zip: "application/zip",
  svg: "image/svg+xml",
  dxf: "application/dxf",
} as const;
const projectOperations = [
  { ...operation("GET", "/api/v1/projects", "listProjectsOrGetProject", [200, ...commonErrors]), query: { required: [], properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 }, limit: { type: "string", pattern: "^\\d{1,4}$", maxLength: 4 }, cursor: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 128 } } }, responseSchemas: { 200: { type: "object", oneOf: [projectList, projectDetail] }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("POST", "/api/v1/projects", "createProject", [201, ...commonErrors], createProjectRequestBody), responseSchemas: { 201: { type: "object", required: ["project"], properties: { project: projectSummary } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("DELETE", "/api/v1/projects", "deleteProject", [200, ...commonErrors]), query: projectQuery, responseSchemas: { 200: { type: "object", required: ["deleted", "id", "revision"], properties: { deleted: { type: "boolean" }, id: str, revision: num } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
] as const satisfies readonly ApiV1Operation[];

export function validateApiV1Schema(value: unknown, schema: ApiV1FieldSchema): boolean {
  if (schema.oneOf && schema.oneOf.filter((candidate) => validateApiV1Schema(value, candidate)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((candidate) => validateApiV1Schema(value, candidate))) return false;
  if (schema.not && validateApiV1Schema(value, schema.not)) return false;
  if (schema.nullable && value === null) return true;
  if (schema.enum && !schema.enum.includes(value as string | null)) return false;
  if (schema.type === "array") return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && (!schema.uniqueItems || new Set(value).size === value.length) && (!schema.items || value.every((item) => validateApiV1Schema(item, schema.items!)));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.required?.some((name) => !(name in object))) return false;
    if (Object.entries(schema.properties ?? {}).some(([name, child]) => name in object && !validateApiV1Schema(object[name], child))) return false;
    if (Object.entries(object).some(([name, child]) => {
      if (name in (schema.properties ?? {})) return false;
      const matchingPatterns = Object.entries(schema.patternProperties ?? {}).filter(([pattern]) => new RegExp(pattern).test(name));
      if (matchingPatterns.length) return matchingPatterns.some(([, childSchema]) => !validateApiV1Schema(child, childSchema));
      if (schema.additionalProperties === false) return true;
      return typeof schema.additionalProperties === "object" && !validateApiV1Schema(child, schema.additionalProperties);
    })) return false;
    return true;
  }
  if (schema.type === "string") return typeof value === "string" && (!schema.pattern || new RegExp(schema.pattern).test(value)) && (schema.minimumLength === undefined || value.length >= schema.minimumLength) && (schema.maximumLength === undefined || value.length <= schema.maximumLength);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum) && (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) && (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum);
  return schema.type === undefined;
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
  if (schema) return validateApiV1Schema(body, schema);
  if (status === 413 && body && typeof body === "object") return (body as Record<string, unknown>).code === "limit_exceeded" && typeof (body as Record<string, unknown>).error === "string";
  return false;
}

function isValidBinaryApiV1Response(key: string, request: Request, response: Response): boolean {
  const operation = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === key);
  const contract = operation?.binaryResponse;
  if (!contract || response.status !== contract.status || new URL(request.url).searchParams.get("download") !== "1") return false;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (!contentType || !Object.values(contract.formatContentTypes).includes(contentType)) return false;
  const encodedMetadata = response.headers.get(contract.metadataHeader);
  if (!encodedMetadata) return false;
  try {
    const metadata = JSON.parse(decodeURIComponent(encodedMetadata));
    const fields = metadata as Record<string, unknown>;
    const expectedContentType = typeof fields.format === "string"
      ? (contract.formatContentTypes as Readonly<Record<string, string>>)[fields.format]
      : undefined;
    return validateApiV1Schema(metadata, contract.metadataSchema)
      && fields.mimeType === contentType
      && expectedContentType === contentType;
  } catch {
    return false;
  }
}

export function withApiV1Contract(key: string, handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      const response = await handler(request);
      const operation = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === key);
      if (operation?.binaryResponse && response.status === operation.binaryResponse.status && new URL(request.url).searchParams.get("download") === "1") {
        if (!isValidBinaryApiV1Response(key, request, response)) return Response.json({ error: "The API handler returned a response outside its contract.", code: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
        return response;
      }
      const body = await response.clone().json().catch(() => null);
      if (!validateApiV1Response(key, response.status, body)) return Response.json({ error: "The API handler returned a response outside its contract.", code: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
      const revision = body && typeof body === "object"
        ? (typeof (body as { revision?: unknown }).revision === "number"
          ? (body as { revision: number }).revision
          : typeof (body as { project?: { revision?: unknown } }).project?.revision === "number"
            ? (body as { project: { revision: number } }).project.revision
            : undefined)
        : undefined;
      if (operation?.ifMatch && response.status >= 200 && response.status < 300 && revision !== undefined) {
        response.headers.set("ETag", `"${revision}"`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "ProjectRevisionMismatchError" && "currentRevision" in error && typeof error.currentRevision === "number") {
        return Response.json(
          { error: "The project changed since the supplied revision.", code: "revision_mismatch", revision: error.currentRevision },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json({ error: "The request could not be completed.", code: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
const sketchSweepProfileRequest = { type: "object", required: ["points", "segments"], properties: { points: { type: "array", items: { type: "object", additionalProperties: true } }, segments: { type: "array", items: { type: "object", additionalProperties: true } }, sweepFrames: { type: "object", additionalProperties: true } }, additionalProperties: true } as const;
const revolveProfileRequest = { type: "array", items: { type: "array", minItems: 2, maxItems: 2, items: num } } as const;
const shapeRequest = { type: "object", required: ["kind"], properties: { kind: str, profile: { oneOf: [sketchSweepProfileRequest, revolveProfileRequest] } }, additionalProperties: true } as const;
const shapeOperations = [
  { ...operation("GET", "/api/v1/shapes", "listShapes", [200, ...commonErrors]), query: { ...projectQuery, properties: { ...projectQuery.properties, limit: { type: "string", pattern: "^\\d{1,4}$", maxLength: 4 }, cursor: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 128 } } }, responseSchemas: { 200: shapesList, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("POST", "/api/v1/shapes", "createShapes", [201, ...commonErrors, 413, 422]), query: projectQuery, requestBody: json({ type: "object", oneOf: [shapeRequest, { type: "object", required: ["shapes"], properties: { shapes: { type: "array", minItems: 1, maxItems: 200, items: shapeRequest } }, additionalProperties: false }] }), responseSchemas: { 201: { type: "object", required: ["shapes", "revision"], properties: { shapes: { type: "array", items: shapeSummary }, revision: num } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 413: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("PATCH", "/api/v1/shapes", "updateShape", [200, 400, 401, 404, 409, 422, 500, 503]), query: shapeQuery, requestBody: json({ type: "object", properties: { faceColors: { type: "object", patternProperties: { "^(?:[0-9]+|face_[^\\s]+)$": { type: "string", pattern: "^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$" } }, additionalProperties: false } }, additionalProperties: true }), responseSchemas: { 200: { type: "object", required: ["shape", "revision"], properties: { shape: shapeSummary, revision: num } }, 400: faceError("invalid_project_id", "invalid_shape_id", "invalid_body", "invalid_request"), 401: faceError("unauthorized"), 404: faceError("api_disabled", "project_not_found", "shape_not_found"), 409: faceError("project_busy", "shape_locked"), 422: { type: "object", required: ["error", "code"], properties: { error: str, code: { type: "string", enum: ["unapplicable_fields", "geometry_failed", "cad_failed"] }, fields: { type: "array", items: str } }, additionalProperties: true }, 500: faceError("geometry_failed", "cad_failed", "internal_error"), 503: faceError("storage_unconfigured") } },
  { ...operation("DELETE", "/api/v1/shapes", "deleteShape", [200, ...commonErrors]), query: shapeQuery, responseSchemas: { 200: { type: "object", required: ["deleted", "id", "revision"], properties: { deleted: { type: "boolean" }, id: str, revision: num } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema, 503: errorSchema } },
] as const satisfies readonly ApiV1Operation[];

const arrangementErrors = { 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema } as const;
const patternRequest = {
  type: "object",
  required: ["ids"],
  properties: {
    ids: { oneOf: [{ type: "string", pattern: "\\S" }, { type: "array", minItems: 1, items: { type: "string", pattern: "\\S" }, uniqueItems: true }], description: "A shape ID or non-empty list of IDs; surrounding whitespace is trimmed and duplicate IDs after trimming are rejected." },
    kind: { type: "string", enum: ["linear", "circular"], default: "linear" },
    count: { type: "integer", nullable: true, minimum: 2, maximum: 200, default: 4 },
    stepX: { ...num, default: 0 },
    stepZ: { ...num, default: 0 },
    centerX: { ...num, default: 0 },
    centerZ: { ...num, default: 0 },
    sweepAngle: { ...num, default: 360 },
    rotateCopies: { type: "boolean", default: true, description: "For circular patterns, rotate each copy to follow the ring; defaults to true." },
  },
} as const;
const patternResponse = {
  type: "object", required: ["created", "kind", "shapes", "revision"],
  properties: { created: { type: "integer", minimum: 0 }, kind: { type: "string", enum: ["linear", "circular"] }, shapes: { type: "array", items: shapeSummary }, revision: num },
} as const;
const patternErrors = {
  400: faceError("invalid_project_id", "invalid_body", "invalid_request"),
  401: faceError("unauthorized"),
  404: faceError("api_disabled", "project_not_found", "shape_not_found"),
  409: faceError("project_busy"),
  413: limitErrorSchema,
  500: faceError("internal_error"),
  503: faceError("storage_unconfigured"),
} as const;
const patternOperation = {
  ...operation("POST", "/api/v1/patterns", "patternShapes", [201, 400, 401, 404, 409, 413, 500, 503], json(patternRequest)),
  description: "Create linear or circular copies of selected shapes.",
  query: projectQuery,
  responseSchemas: { 201: patternResponse, ...patternErrors },
};
const featureErrors = { 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema } as const;
const changedShapeResponse = { type: "object", required: ["shape", "triangles", "revision"], properties: { shape: shapeSummary, triangles: { type: "integer", minimum: 0 }, revision: num } } as const;
const featureOperations = [
  { ...operation("POST", "/api/v1/booleans", "booleanShapes", [201, 400, 401, 404, 409, 422, 500, 503], json({ type: "object", required: ["solidIds", "holeIds"], properties: { solidIds: { oneOf: [{ type: "string", pattern: "\\S" }, { type: "array", minItems: 1, items: { type: "string", pattern: "\\S" } }] }, holeIds: { oneOf: [{ type: "string", pattern: "\\S" }, { type: "array", minItems: 1, items: { type: "string", pattern: "\\S" } }] } }, additionalProperties: true })), description: "Subtract one or more cutter shapes, including helical thread meshes, from solids and persist exact geometry. Kernel geometry failures return 422 geometry_failed.", query: projectQuery, responseSchemas: { 201: changedShapeResponse, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema } },
  { ...operation("POST", "/api/v1/treatments", "treatShape", [200, 400, 401, 404, 409, 422, 500, 503], json({ type: "object", required: ["kind", "amount"], properties: { kind: { type: "string", enum: ["fillet", "chamfer"] }, amount: { type: "number", exclusiveMinimum: 0 }, angle: num, edges: { oneOf: [{ type: "string", enum: ["all"] }, { type: "array", nullable: true, items: num }] } }, additionalProperties: true })), description: "Apply a fillet or chamfer to all edges or selected edge indexes.", query: shapeQuery, responseSchemas: { 200: changedShapeResponse, ...featureErrors } },
  { ...operation("POST", "/api/v1/shell", "shellShape", [200, 400, 401, 404, 409, 422, 500, 503], json({ type: "object", required: ["thickness"], properties: { thickness: { type: "number", exclusiveMinimum: 0 }, openFaces: { oneOf: [{ type: "string", nullable: true }, { type: "number" }, { type: "array", items: { oneOf: [{ type: "string" }, num] } }] } }, additionalProperties: true })), description: "Hollow a shape to a specified wall thickness, optionally leaving selected faces open.", query: shapeQuery, responseSchemas: { 200: changedShapeResponse, ...featureErrors } },
  { ...operation("POST", "/api/v1/draft-prism", "draftPrism", [200, 400, 401, 404, 409, 422, 500, 503], json({ type: "object", required: ["angle"], properties: { angle: { oneOf: [{ type: "number", exclusiveMinimum: 0, maximum: 45 }, { type: "number", minimum: -45, exclusiveMaximum: 0 }] } }, additionalProperties: true })), description: "Draft an extruded shape along its vertical axis by an angle between -45 and 45 degrees, excluding zero.", query: shapeQuery, responseSchemas: { 200: changedShapeResponse, ...featureErrors } },
] as const satisfies readonly ApiV1Operation[];
const arrangementIds = {
  oneOf: [
    { type: "string", pattern: "\\S", description: "One non-empty shape ID." },
    { type: "array", minItems: 1, items: { type: "string", pattern: "\\S" }, description: "Distinct non-empty shape IDs; surrounding whitespace is trimmed." },
  ],
} as const;
const alignRequest = {
  type: "object",
  required: ["ids", "axis", "target"],
  properties: {
    ids: arrangementIds,
    axis: { type: "string", enum: ["x", "y", "z"] },
    target: { type: "string", enum: ["min", "center", "max"] },
    anchorId: { type: "string", description: "Optional reference shape ID; empty or whitespace is treated as omitted." },
  },
  additionalProperties: true,
} as const;
const distributeRequest = {
  type: "object",
  required: ["ids"],
  properties: {
    ids: arrangementIds,
    axis: { type: "string", enum: ["x", "z"], description: "Omit to choose the axis along which the shapes are already most spread." },
    spacing: { type: "string", enum: ["gaps", "centers"], default: "gaps" },
  },
  additionalProperties: true,
} as const;
const arrangementShapes = { type: "array", items: shapeSummary } as const;
const alignResponse = {
  type: "object", required: ["moved", "axis", "target", "anchorId", "shapes", "revision"],
  properties: {
    moved: { type: "integer", minimum: 0 },
    axis: { type: "string", enum: ["x", "y", "z"] },
    target: { type: "string", enum: ["min", "center", "max"] },
    anchorId: { type: "string", nullable: true },
    shapes: arrangementShapes,
    revision: num,
  },
} as const;
const distributeResponse = {
  type: "object", required: ["moved", "axis", "spacing", "shapes", "revision"],
  properties: {
    moved: { type: "integer", minimum: 0 },
    axis: { type: "string", enum: ["x", "z"] },
    spacing: { type: "string", enum: ["gaps", "centers"] },
    shapes: arrangementShapes,
    revision: num,
  },
} as const;
const arrangementOperations = [
  {
    ...operation("POST", "/api/v1/align", "alignShapes", [200, 400, 401, 404, 409, 422, 500, 503], json(alignRequest)),
    query: projectQuery,
    description: "Align selected shapes by a shared minimum, centre, or maximum coordinate.",
    responseSchemas: { 200: alignResponse, ...arrangementErrors },
  },
  {
    ...operation("POST", "/api/v1/distribute", "distributeShapes", [200, 400, 401, 404, 409, 422, 500, 503], json(distributeRequest)),
    query: projectQuery,
    description: "Evenly space three or more selected shapes while keeping the outermost shapes fixed.",
    responseSchemas: { 200: distributeResponse, ...arrangementErrors },
  },
] as const satisfies readonly ApiV1Operation[];

const API_V1_OPERATIONS_BASE: readonly ApiV1Operation[] = [
  ...featureOperations.slice(0, 1),
  ...arrangementOperations.slice(0, 1),
  ...arrangementOperations.slice(1),
  ...featureOperations.slice(3, 4),
  {
    ...operation("GET", "/api/v1/edges", "listEdges", [200, 400, 401, 404, 422, 500, 503]),
    description: "Lists the shape's edges in the index order used by fillet and chamfer requests; indexes can change when topology changes.",
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120, description: "Whitespace is trimmed before validation. ID starts with a letter or digit and contains only letters, digits, underscores, and hyphens." },
        shapeId: { type: "string", trim: true, minLength: 1, description: "Whitespace is trimmed; the remaining value must not be empty." },
      },
    },
    responseSchemas: {
      200: edgeListSchema,
      400: faceError("invalid_project_id", "invalid_shape_id"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      422: faceError("cad_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  operation("OPTIONS", "/api/v1/edges", "edgeRouteOptions", [204], undefined, "none"),
  {
    ...operation("POST", "/api/v1/explode", "explodeAssembly", [200, 400, 401, 404, 409, 422, 500, 503]),
    description: "Explode an imported STEP assembly into editable product groups and exact component solids.",
    query: shapeQuery,
    responseSchemas: {
      200: { type: "object", required: ["shapes", "revision"], properties: { shapes: { type: "array", items: shapeSummary }, revision: num }, additionalProperties: false },
      400: faceError("invalid_project_id", "invalid_shape_id"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      409: faceError("project_busy", "shape_locked"),
      422: faceError("cad_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  {
    ...operation("POST", "/api/v1/exports", "exportProject", [200, 400, 401, 404, 413, 422, 500, 503], exportRequestBody),
    description: "Export project geometry as JSON/base64, or return the raw artifact when download=1. Binary downloads carry result metadata in the X-SketchForge-Metadata response header. Section size caps return 413 limit_exceeded; geometry failures return 422.",
    query: {
      required: ["projectId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
        download: { type: "string", description: "Set download=1 to return raw artifact bytes; omitted or any other value returns JSON with base64 content." },
      },
    },
    responseSchemas: {
      200: exportResponseSchema,
      400: faceError("invalid_project_id", "invalid_body", "unsupported_format", "invalid_request"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      413: limitErrorSchema,
      422: faceError("geometry_failed"),
      500: faceError("internal_error"),
      503: faceError("storage_unconfigured"),
    },
    binaryResponse: { status: 200, formatContentTypes: exportFormatContentTypes, metadataHeader: "X-SketchForge-Metadata", metadataSchema: exportMetadataSchema },
  },
  {
    ...operation("GET", "/api/v1/faces", "listFaces", [200, 400, 401, 404, 422, 500, 503]),
    description: "Lists each face with its shell-request index and stable application-owned ID. Use topology=exact to list analytic faces on supported plain full-turn sketch revolves without changing the default mesh listing. Face IDs can be used as faceColors keys in PATCH /api/v1/shapes.",
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120, description: "Whitespace is trimmed before validation. ID starts with a letter or digit and contains only letters, digits, underscores, and hyphens." },
        shapeId: { type: "string", trim: true, minLength: 1, description: "Whitespace is trimmed; the remaining value must not be empty." },
        topology: { type: "string", pattern: "^(mesh|exact)$", description: "Optional. Use exact to list analytic B-rep faces on a supported plain full-turn sketch revolve; the default mesh listing keeps its existing indexes." },
      },
    },
    responseSchemas: {
      200: faceListSchema,
      400: faceError("invalid_project_id", "invalid_shape_id", "invalid_request"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      422: faceError("cad_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  operation("OPTIONS", "/api/v1/faces", "faceRouteOptions", [204], undefined, "none"),
  {
    ...operation("POST", "/api/v1/groups", "groupShapes", [201, 400, 401, 404, 409, 422, 500, 503], json({
      type: "object", required: ["ids"], properties: { ids: { oneOf: [
        { type: "string", pattern: "\\S", description: "A single ID is accepted as shorthand, though grouping requires at least two shapes." },
        { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", pattern: "\\S" }, description: "IDs are trimmed and must be distinct after trimming." },
      ] } },
    })),
    description: "Groups at least two distinct shapes; members marked hole, including helical thread meshes, are subtracted using the same semantics as the editor. Kernel geometry failures return 422 geometry_failed.",
    query: projectQuery,
    responseSchemas: {
      201: { type: "object", required: ["shape", "revision"], properties: { shape: shapeSummary, revision: num }, additionalProperties: false },
      400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema,
    },
  },
  {
    ...operation("DELETE", "/api/v1/groups", "ungroupShape", [200, 400, 401, 404, 409, 422, 500, 503]),
    description: "Ungroups a group and returns its children with the group's current transforms applied.",
    query: shapeQuery,
    responseSchemas: {
      200: { type: "object", required: ["shapes", "revision"], properties: { shapes: { type: "array", items: shapeSummary }, revision: num }, additionalProperties: false },
      400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema,
    },
  },
  {
    ...operation("POST", "/api/v1/imports", "importGeometry", [201, 400, 401, 404, 409, 413, 415, 422, 500, 503], {
      required: true,
      content: {
        "application/json": {
          type: "object",
          required: ["fileName"],
          anyOf: [
            { type: "object", required: ["data"] },
            { type: "object", required: ["contents"] },
          ],
          properties: {
            fileName: { type: "string", minimumLength: 1, pattern: "\\S", description: "File name is trimmed, selects the importer, and names the stored asset." },
            data: { type: "string", minimumLength: 1, description: "Base64-encoded file bytes. Takes precedence over contents when both are sent." },
            contents: { type: "string", minimumLength: 1, description: "Alias for data; used when data is absent." },
            mediaType: str,
          },
          additionalProperties: true,
        },
        "multipart/form-data": {
          type: "object",
          required: ["file"],
          properties: {
            file: { type: "string", format: "binary", description: "The uploaded model file." },
            fileName: { type: "string", minimumLength: 1, pattern: "\\S", description: "Optional trimmed importer name override; defaults to the uploaded file name." },
          },
          additionalProperties: true,
        },
      },
    }),
    description: "Imports an STL, OBJ, or SVG file from base64 JSON or multipart form data, stores the source asset, and returns the imported mesh summary. Requests and decoded files are size-limited and return 413 limit_exceeded when over the supported limit.",
    query: projectQuery,
    responseSchemas: {
      201: { type: "object", required: ["shape", "triangles", "revision"], properties: { shape: shapeSummary, triangles: int, revision: num }, additionalProperties: false },
      400: faceError("invalid_project_id", "invalid_body", "invalid_request"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found"),
      409: faceError("project_busy"),
      413: limitErrorSchema,
      415: faceError("unsupported_format"),
      422: faceError("geometry_failed"),
      500: faceError("internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  {
    ...operation("POST", "/api/v1/interference", "analyzeInterference", [200, 400, 401, 404, 409, 413, 422, 500, 503], json({
      type: "object",
      properties: {
        ids: { oneOf: [
          { type: "string", pattern: "\\S", description: "Whitespace is trimmed; IDs must be unique after trimming." },
          { type: "array", minItems: 1, items: { type: "string", pattern: "\\S" }, description: "IDs are trimmed and must be unique after trimming." },
        ] },
        clearance: { type: "number", minimum: 0, description: "Maximum exact surface gap in millimetres; defaults to zero." },
      },
      additionalProperties: true,
    })),
    description: "Reports exact gaps and overlap volumes for visible, non-cutter shapes, subject to 128-shape and 512-candidate limits. Exceeding either cap returns 413 limit_exceeded.",
    query: projectQuery,
    responseSchemas: {
      200: {
        type: "object", required: ["shapesChecked", "candidatePairsChecked", "clearance", "method", "pairs"], additionalProperties: false,
        properties: {
          shapesChecked: { type: "integer", minimum: 0 },
          candidatePairsChecked: { type: "integer", minimum: 0 },
          clearance: { type: "number", minimum: 0 },
          method: { type: "string", enum: ["OCCT exact distance and common volume; AABB candidate prefilter"] },
          pairs: {
            type: "array", items: {
              type: "object", required: ["a", "b", "gap", "overlapVolume", "precision"], additionalProperties: false,
              properties: {
                a: { type: "object", required: ["id", "name"], properties: { id: str, name: str }, additionalProperties: false },
                b: { type: "object", required: ["id", "name"], properties: { id: str, name: str }, additionalProperties: false },
                gap: { type: "number", minimum: 0 },
                overlapVolume: { type: "number", minimum: 0 },
                precision: { type: "string", enum: ["exact", "tessellated"] },
              },
            },
          },
        },
      },
      400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema,
      413: limitErrorSchema, 422: errorSchema, 500: errorSchema, 503: errorSchema,
    },
  },
  {
    ...operation("GET", "/api/v1/measurements", "listMeasurements", [200, 400, 401, 404, 409, 500, 503]),
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120, description: "Whitespace is trimmed before validation. ID starts with a letter or digit and contains only letters, digits, underscores, and hyphens." },
        shapeId: { type: "string", trim: true, minLength: 1, description: "Whitespace is trimmed; the remaining value must not be empty." },
      },
    },
    responseSchemas: {
      200: measurementListSchema,
      400: faceError("invalid_project_id", "invalid_shape_id"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      409: faceError("project_busy"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
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
          from: measurementEndSchema,
          to: measurementEndSchema,
        },
      },
    }),
    query: {
      required: ["projectId"],
      properties: { projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 } },
    },
    responseSchemas: {
      200: measurementBetweenResponseSchema,
      400: faceError("invalid_project_id", "invalid_body", "invalid_request"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      409: faceError("project_busy"),
      422: faceError("cad_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  {
    ...operation("POST", "/api/v1/mirrors", "mirrorShapes", [200, 400, 401, 404, 409, 422, 500, 503], json({
      type: "object",
      required: ["ids", "axis"],
      properties: {
        ids: { oneOf: [
          { type: "string", pattern: "\\S", description: "A single shape ID; whitespace is trimmed before lookup." },
          { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "\\S" }, description: "Distinct shape IDs; whitespace is trimmed before lookup." },
        ] },
        axis: { type: "string", enum: ["x", "y", "z"], description: "Principal plane normal to this coordinate axis." },
      },
      additionalProperties: true,
    })),
    description: "Mirrors selected shapes across the principal plane through the midpoint of their combined bounds.",
    query: projectQuery,
    responseSchemas: {
      200: {
        type: "object", required: ["moved", "axis", "shapes", "revision"], additionalProperties: false,
        properties: {
          moved: { type: "integer", minimum: 0 },
          axis: { type: "string", enum: ["x", "y", "z"] },
          shapes: { type: "array", items: shapeSummary },
          revision: num,
        },
      },
      400: errorSchema,
      401: errorSchema,
      404: errorSchema,
      409: errorSchema,
      422: errorSchema,
      500: errorSchema,
      503: errorSchema,
    },
  },
  {
    ...operation("POST", "/api/v1/parts", "splitParts", [200, 400, 401, 404, 409, 422, 500, 503]),
    description: "Split a shape into its separate bodies or restore a plain group to its member shapes.",
    query: shapeQuery,
    responseSchemas: {
      200: { type: "object", required: ["shapes", "revision"], properties: { shapes: { type: "array", items: shapeSummary }, revision: num }, additionalProperties: false },
      400: faceError("invalid_project_id", "invalid_shape_id"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      409: faceError("project_busy", "shape_locked"),
      422: faceError("invalid_request", "geometry_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  patternOperation,
  ...projectOperations,
  {
    ...operation("GET", "/api/v1/properties", "getShapeProperties", [200, 400, 401, 404, 422, 500, 503]),
    description: "Returns exact mass properties for the positioned shape and identifies whether the measurements came from exact CAD geometry or tessellated mesh geometry.",
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120, description: "Whitespace is trimmed before validation. ID starts with a letter or digit and contains only letters, digits, underscores, and hyphens." },
        shapeId: { type: "string", trim: true, minLength: 1, description: "Whitespace is trimmed; the remaining value must not be empty." },
      },
    },
    responseSchemas: {
      200: {
        type: "object", required: ["properties"], additionalProperties: false,
        properties: {
          properties: {
            type: "object", required: ["volume", "area", "centerOfMass", "bbox", "isValid", "provenance"], additionalProperties: false,
            properties: {
              volume: num,
              area: num,
              centerOfMass: vector3Schema,
              bbox: { type: "object", required: ["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"], properties: { xmin: num, ymin: num, zmin: num, xmax: num, ymax: num, zmax: num }, additionalProperties: false },
              isValid: { type: "boolean" },
              provenance: { type: "object", required: ["source", "precision"], properties: { source: { type: "string", enum: ["parametric", "brep", "mesh"] }, precision: { type: "string", enum: ["exact", "tessellated"] } }, additionalProperties: false },
            },
          },
        },
      },
      400: faceError("invalid_project_id", "invalid_shape_id"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      422: faceError("cad_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  operation("OPTIONS", "/api/v1/properties", "propertyRouteOptions", [204], undefined, "none"),
  ...shapeOperations.slice(0, 2),
  { ...shapeOperations[2], requestBody: { ...shapeOperations[2].requestBody!, faceColors: { type: "object", keyKinds: ["stable-face-id", "legacy-numeric-index"], keyPattern: "^(?:[0-9]+|face_[^\\s]+)$", colorPattern: "^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$" } } } as ApiV1Operation,
  shapeOperations[3],
  ...featureOperations.slice(2, 3),
  {
    ...operation("GET", "/api/v1/thickness", "estimateThickness", [200, 400, 401, 404, 413, 422, 500, 503]),
    description: "Estimates minimum wall thickness by sampling opposing surface pairs; this is not a certified minimum-thickness result.",
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
        shapeId: { type: "string", trim: true, minLength: 1 },
      },
    },
    responseSchemas: {
      200: thicknessSchema,
      400: faceError("invalid_project_id", "invalid_shape_id"),
      401: faceError("unauthorized"),
      404: faceError("api_disabled", "project_not_found", "shape_not_found"),
      413: limitErrorSchema,
      422: faceError("geometry_failed"),
      500: faceError("cad_failed", "internal_error"),
      503: faceError("storage_unconfigured"),
    },
  },
  operation("OPTIONS", "/api/v1/thickness", "thicknessRouteOptions", [204], undefined, "none"),
  ...featureOperations.slice(1, 2),
] as const satisfies readonly ApiV1Operation[];

export const API_V1_OPERATIONS: readonly ApiV1Operation[] = API_V1_OPERATIONS_BASE.map((item): ApiV1Operation => item.requestBody
  ? {
    ...item,
    maxRequestBytes: item.operationId === "importGeometry" ? 64 * 1024 * 1024 : DEFAULT_JSON_BODY_LIMIT_BYTES,
    responses: [...new Set([...(item.responses ?? []), 413])].sort((a, b) => a - b),
    responseSchemas: { 413: errorSchema, ...item.responseSchemas },
  }
  : item);

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
export type ListEdgesResponse = {
  edges: Array<{
    index: number;
    length: number;
    curveType: string;
    midpoint: { x: number; y: number; z: number };
    filletable: boolean;
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
  return exactKeys(point, ["x", "y", "z"])
    && [point.x, point.y, point.z].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
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

/** Validate the ordered CAD edges before they cross the REST boundary. */
export function parseListEdgesResponse(value: unknown): ListEdgesResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["edges"]) || !Array.isArray((value as { edges?: unknown }).edges)) return null;
  const edges = (value as { edges: unknown[] }).edges;
  for (const edge of edges) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge) || !exactKeys(edge, ["index", "length", "curveType", "midpoint", "filletable"])) return null;
    const item = edge as Record<string, unknown>;
    if (!Number.isInteger(item.index) || (item.index as number) < 0) return null;
    if (typeof item.length !== "number" || !Number.isFinite(item.length) || item.length < 0) return null;
    if (typeof item.curveType !== "string" || typeof item.filletable !== "boolean" || !isPoint(item.midpoint)) return null;
  }
  return value as ListEdgesResponse;
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
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["properties"])) return null;
  const properties = (value as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !exactKeys(properties, ["volume", "area", "centerOfMass", "bbox", "isValid", "provenance"])) return null;
  const item = properties as Record<string, unknown>;
  const bbox = item.bbox;
  if (typeof item.volume !== "number" || !Number.isFinite(item.volume) || typeof item.area !== "number" || !Number.isFinite(item.area)) return null;
  if (!isPoint(item.centerOfMass) || typeof item.isValid !== "boolean") return null;
  if (!bbox || typeof bbox !== "object" || Array.isArray(bbox) || !exactKeys(bbox, ["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"])) return null;
  const bounds = bbox as Record<string, unknown>;
  if (!["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]))) return null;
  const provenance = item.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance) || !exactKeys(provenance, ["source", "precision"])) return null;
  const source = (provenance as Record<string, unknown>).source;
  const precision = (provenance as Record<string, unknown>).precision;
  if (!(source === "parametric" || source === "brep" || source === "mesh")) return null;
  if (!(precision === "exact" || precision === "tessellated")) return null;
  return value as ShapePropertiesResponse;
}

export type ThicknessResponse = {
  thickness: {
    minimum: number | null;
    unit: "mm";
    method: "sampled-opposing-surface-distance";
    samplesPerFace: number;
    facesChecked: number;
  };
};

/** Reject malformed wall-thickness results before they cross the REST boundary. */
export function parseThicknessResponse(value: unknown): ThicknessResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["thickness"])) return null;
  const thickness = (value as { thickness?: unknown }).thickness;
  if (!thickness || typeof thickness !== "object" || Array.isArray(thickness) || !exactKeys(thickness, ["minimum", "unit", "method", "samplesPerFace", "facesChecked"])) return null;
  const result = thickness as Record<string, unknown>;
  if (!(result.minimum === null || (typeof result.minimum === "number" && Number.isFinite(result.minimum) && result.minimum >= 0))) return null;
  if (result.unit !== "mm" || result.method !== "sampled-opposing-surface-distance") return null;
  if (!Number.isInteger(result.samplesPerFace) || (result.samplesPerFace as number) < 1) return null;
  if (!Number.isInteger(result.facesChecked) || (result.facesChecked as number) < 0) return null;
  return value as ThicknessResponse;
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
