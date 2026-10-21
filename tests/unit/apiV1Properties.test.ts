import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { POST as createShapes } from "@/app/api/v1/shapes/route";
import { GET as properties, OPTIONS } from "@/app/api/v1/properties/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

const TOKEN = "properties-test-token";
let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

async function project() {
  const response = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Properties" }) }));
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function addShape(projectId: string) {
  const response = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, {
    method: "POST",
    body: JSON.stringify({ kind: "box", width: 4, depth: 5, height: 6, x: 10, name: "Plate" }),
  }));
  const payload = (await response.json()) as { shapes: Array<{ id: string }> };
  expect(response.status, JSON.stringify(payload)).toBe(201);
  return payload.shapes[0].id;
}

describe("REST API v1 shape properties", () => {
  beforeEach(async () => {
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-properties-"));
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

  it("returns exact shape properties and geometry provenance", async () => {
    const projectId = await project();
    const shapeId = await addShape(projectId);
    const response = await properties(authorized(`/api/v1/properties?projectId=${projectId}&shapeId=${shapeId}`));
    const payload = (await response.json()) as { properties?: { volume: number; area: number; provenance: { source: string; precision: string } } };

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.properties?.volume).toBeCloseTo(120);
    expect(payload.properties?.area).toBeCloseTo(148);
    expect(payload.properties?.provenance).toEqual({ source: "parametric", precision: "exact" });
  });

  it("requires projectId and shapeId", async () => {
    expect((await properties(authorized("/api/v1/properties?shapeId=shape"))).status).toBe(400);
    expect((await properties(authorized("/api/v1/properties?projectId=project"))).status).toBe(400);
  });

  it("registers GET and OPTIONS so static export does not prerender the route", async () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, OPTIONS");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
