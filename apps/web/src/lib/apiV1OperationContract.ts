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
  description?: string;
  properties?: Readonly<Record<string, ApiV1FieldSchema>>;
  items?: ApiV1FieldSchema;
};

export type ApiV1Operation = {
  operationId: string;
  method: ApiV1Method;
  path: `/api/v1/${string}`;
  auth: "bearer" | "none";
  /** Populated only for routes whose response set has been verified. */
  responses?: readonly number[];
  query?: {
    required: readonly string[];
    properties: Readonly<Record<string, { type: "string"; trim?: true; pattern?: string; maxLength?: number }>>;
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
  requestBody?: ApiV1CreateProjectRequestBody | ApiV1ShapePatchRequestBody | ApiV1MeasureBetweenRequestBody;
};

export type ApiV1CreateProjectRequestBody = {
  contentType: "application/json";
  required: true;
  normalization: readonly ["trim", "truncate:80"];
  schema: { type: "object"; required: readonly ["name"]; name: { type: "string"; minLength: 1; maxLength: 80 } };
};

export type ApiV1ShapePatchRequestBody = {
  contentType: "application/json";
  required: true;
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
  schema: { type: "object", required: ["name"], name: { type: "string", minLength: 1, maxLength: 80 } },
} as const;

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
    ...operation("GET", "/api/v1/faces", "listFaces", [200, 400, 401, 404, 409, 500, 503]),
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
        shapeId: { type: "string", trim: true },
      },
    },
    response: {
      required: ["faces"],
      faceFields: ["index", "id", "surfaceType", "area", "centroid", "normal", "facing"],
      faceIdSemantics: "stable identity for a face while its identity is preserved by the model",
      colorAssignmentKey: "face id in PATCH /api/v1/shapes faceColors",
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
          distance: { type: "number" },
          angleDegrees: { type: "number", nullable: true },
          angleUnavailable: { type: "string", nullable: true, enum: ["notPlanar", "degenerateNormal"] },
        },
      },
    },
  },
  operation("POST", "/api/v1/mirrors", "mirrorShapes"),
  operation("POST", "/api/v1/parts", "splitParts"),
  operation("POST", "/api/v1/patterns", "patternShapes"),
  operation("GET", "/api/v1/projects", "listProjectsOrGetProject"),
  operation("POST", "/api/v1/projects", "createProject", [201, 400, 401, 404, 409, 503], createProjectRequestBody),
  operation("DELETE", "/api/v1/projects", "deleteProject"),
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
  operation("GET", "/api/v1/shapes", "listShapes"),
  operation("POST", "/api/v1/shapes", "createShapes"),
  {
    ...operation("PATCH", "/api/v1/shapes", "updateShape", [200, 400, 401, 404, 409, 422, 500, 503]),
    query: {
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", trim: true, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
        shapeId: { type: "string", trim: true },
      },
    },
    requestBody: {
      contentType: "application/json",
      required: true,
      faceColors: {
        type: "object",
        keyKinds: ["stable-face-id", "legacy-numeric-index"],
        keyPattern: "^(?:[0-9]+|face_[^\\s]+)$",
        colorPattern: "^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$",
      },
    },
  },
  operation("DELETE", "/api/v1/shapes", "deleteShape"),
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
  if (!value || typeof value !== "object" || !Array.isArray((value as { faces?: unknown }).faces)) return null;
  const faces = (value as { faces: unknown[] }).faces;
  const directions = new Set(["top", "bottom", "right", "left", "front", "back"]);
  for (const face of faces) {
    if (!face || typeof face !== "object") return null;
    const item = face as Record<string, unknown>;
    if (!Number.isInteger(item.index) || (item.index as number) < 0) return null;
    if (typeof item.id !== "string" || typeof item.surfaceType !== "string") return null;
    if (typeof item.area !== "number" || !Number.isFinite(item.area)) return null;
    if (!isPoint(item.centroid) || !(item.normal === null || isPoint(item.normal))) return null;
    if (!(item.facing === null || (typeof item.facing === "string" && directions.has(item.facing)))) return null;
  }
  return value as ListFacesResponse;
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
