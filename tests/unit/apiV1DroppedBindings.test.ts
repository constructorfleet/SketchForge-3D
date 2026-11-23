import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { POST as groupShapes } from "@/app/api/v1/groups/route";
import { POST as createParameter } from "@/app/api/v1/parameters/route";
import { PATCH as patchConstraint } from "@/app/api/v1/sketch-constraints/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { API_V1_OPERATIONS, validateApiV1Response } from "@/lib/apiV1OperationContract";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { directoryProjectStore } from "@/lib/engine/projectStore";

const TOKEN = "test-token-value";

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

type Json = Record<string, any>;

async function call(handler: (request: Request) => Promise<Response>, url: string, method: string, body?: Json) {
  const response = await handler(new Request(`http://localhost${url}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { status: response.status, body: await response.json() as Json };
}

/** A 2 x 2 rectangle with corner `a` fixed and both sides dimensioned. */
const rectangle = (width = 2) => ({
  points: [{ id: "a", x: -1, z: -1 }, { id: "b", x: width - 1, z: -1 }, { id: "c", x: width - 1, z: 1 }, { id: "d", x: -1, z: 1 }],
  segments: [{ id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" }, { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" }],
  constraints: [
    { id: "fix-a", kind: "fixed", pointId: "a", xMm: -1, zMm: -1 },
    { id: "h-ab", kind: "horizontal", segmentId: "ab" },
    { id: "v-bc", kind: "vertical", segmentId: "bc" },
    { id: "h-cd", kind: "horizontal", segmentId: "cd" },
    { id: "v-da", kind: "vertical", segmentId: "da" },
    { id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: width },
    { id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 },
  ],
});

beforeEach(async () => {
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-dropped-bindings-"));
  previousRoot = process.env[SERVER_PROJECTS_ENV];
  previousToken = process.env[API_TOKEN_ENV];
  process.env[SERVER_PROJECTS_ENV] = projectsRoot;
  process.env[API_TOKEN_ENV] = TOKEN;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env[SERVER_PROJECTS_ENV];
  else process.env[SERVER_PROJECTS_ENV] = previousRoot;
  if (previousToken === undefined) delete process.env[API_TOKEN_ENV];
  else process.env[API_TOKEN_ENV] = previousToken;
  await fs.rm(projectsRoot, { recursive: true, force: true });
});

describe("PATCH /api/v1/shapes on a nested sketch source (#654)", () => {
  it("names the group whose size binding the refit dropped", async () => {
    const projectId = (await call(createProject, "/api/v1/projects", "POST", { name: "Dropped" })).body.project.id as string;
    const created = await call(createShapes, `/api/v1/shapes?projectId=${projectId}`, "POST", {
      shapes: [{ kind: "box", width: 2, depth: 2, height: 3 }, { kind: "box", width: 2, depth: 2, height: 3, x: -10 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const ids = (created.body.shapes as Json[]).map((shape) => shape.id as string);
    const store = directoryProjectStore(projectsRoot);
    const current = (await store.read(projectId))!;
    await store.write(projectId, current, current.shapes.map((shape, index) => (index === 0 ? {
      ...shape, sketchOperation: "extrude" as const, sketchProfile: rectangle(), sketchSourceId: "sketch/dropped",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    } as typeof shape : shape)));
    const grouped = await call(groupShapes, `/api/v1/groups?projectId=${projectId}`, "POST", { ids });
    expect(grouped.status, JSON.stringify(grouped.body)).toBe(201);
    const groupId = grouped.body.shape.id as string;
    for (const parameter of [{ name: "w", expression: "2" }, { name: "gw", expression: "12" }]) {
      expect((await call(createParameter, `/api/v1/parameters?projectId=${projectId}`, "POST", { ...parameter, dimension: "length" })).status).toBe(201);
    }
    expect((await call(patchConstraint, `/api/v1/sketch-constraints?projectId=${projectId}&shapeId=sketch%2Fdropped&constraintId=width`, "PATCH", { expression: "w" })).status).toBe(200);
    // As a project written before the refusal existed could hold it.
    const bound = (await store.read(projectId))!;
    await store.write(projectId, bound, [{ ...bound.shapes[0]!, expressions: { width: "gw" } }]);

    const changed = await call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=sketch%2Fdropped`, "PATCH", { sketchProfile: rectangle(4) });

    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.droppedBindings).toEqual([{ shapeId: groupId, fields: ["width"] }]);
    expect(validateApiV1Response("PATCH /api/v1/shapes", 200, changed.body)).toBe(true);
    // Declared in the contract, so the OpenAPI reference documents it.
    const patch = API_V1_OPERATIONS.find((operation) => `${operation.method} ${operation.path}` === "PATCH /api/v1/shapes")!;
    const reply = (patch.responseSchemas as Record<number, { properties: Record<string, unknown> }>)[200]!;
    expect(reply.properties.droppedBindings).toMatchObject({ type: "array", items: { required: ["shapeId", "fields"] } });

    // Re-sending the profile now changes nothing, so nothing is reported.
    const resent = await call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=sketch%2Fdropped`, "PATCH", { sketchProfile: rectangle(4) });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(resent.body).not.toHaveProperty("droppedBindings");

    const renamed = await call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=${groupId}`, "PATCH", { name: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).not.toHaveProperty("droppedBindings");
  });
});
