/**
 * Runtime-facing inventory for the public REST API. This deliberately does
 * not claim to be OpenAPI: schemas and response details are added as routes
 * migrate, and the parity test prevents public handlers from being omitted.
 */

export type ApiV1Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

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
    faceFields: readonly string[];
    faceIdSemantics?: string;
    colorAssignmentKey?: string;
  };
  requestBody?: {
    contentType: "application/json";
    required: true;
    normalization: readonly ["trim", "truncate:80"];
    schema: { type: "object"; required: readonly ["name"]; name: { type: "string"; minLength: 1; maxLength: 80 } };
  };
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
  operation("GET", "/api/v1/measurements", "listMeasurements"),
  operation("POST", "/api/v1/measurements", "measureEntities"),
  operation("POST", "/api/v1/mirrors", "mirrorShapes"),
  operation("POST", "/api/v1/parts", "splitParts"),
  operation("POST", "/api/v1/patterns", "patternShapes"),
  operation("GET", "/api/v1/projects", "listProjectsOrGetProject"),
  operation("POST", "/api/v1/projects", "createProject", [201, 400, 401, 404, 409, 503], createProjectRequestBody),
  operation("DELETE", "/api/v1/projects", "deleteProject"),
  operation("GET", "/api/v1/properties", "getShapeProperties"),
  operation("OPTIONS", "/api/v1/properties", "propertyRouteOptions", [204], undefined, "none"),
  operation("GET", "/api/v1/shapes", "listShapes"),
  operation("POST", "/api/v1/shapes", "createShapes"),
  operation("PATCH", "/api/v1/shapes", "updateShape"),
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
export function parseListFacesQuery(request: Request):
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
