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
  operation("GET", "/api/v1/faces", "listFaces"),
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
