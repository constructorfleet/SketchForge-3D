import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";

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

describe("REST API v1 operation contract", () => {
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

  it("records read-only OPTIONS handlers as unauthenticated 204 responses", () => {
    for (const route of ["edges", "faces", "properties", "thickness"]) {
      expect(API_V1_OPERATIONS.find(({ method, path: routePath }) => method === "OPTIONS" && routePath === `/api/v1/${route}`))
        .toMatchObject({ auth: "none", responses: [204] });
    }
  });
});
