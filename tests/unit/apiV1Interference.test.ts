import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { POST as createShapes } from "@/app/api/v1/shapes/route";
import { POST as interference } from "@/app/api/v1/interference/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

const TOKEN = "interference-test-token";
let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

async function setupProject() {
  const created = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Interference" }) }));
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  const shapes = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, {
    method: "POST",
    body: JSON.stringify({ shapes: [
      { id: "a", name: "A", kind: "box", width: 2, depth: 2, height: 2 },
      { id: "b", name: "B", kind: "box", width: 2, depth: 2, height: 2, x: 3 },
    ] }),
  }));
  expect(shapes.status).toBe(201);
  const payload = await shapes.json() as { shapes: Array<{ id: string }> };
  return { projectId, ids: payload.shapes.map(({ id }) => id) };
}

describe("REST API v1 interference", () => {
  beforeEach(async () => {
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-interference-"));
    previousRoot = process.env[SERVER_PROJECTS_ENV];
    previousToken = process.env[API_TOKEN_ENV];
    process.env[SERVER_PROJECTS_ENV] = projectsRoot;
    process.env[API_TOKEN_ENV] = TOKEN;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env[SERVER_PROJECTS_ENV]; else process.env[SERVER_PROJECTS_ENV] = previousRoot;
    if (previousToken === undefined) delete process.env[API_TOKEN_ENV]; else process.env[API_TOKEN_ENV] = previousToken;
    await fs.rm(projectsRoot, { recursive: true, force: true });
  });

  it("reports exact gap and overlap fields", async () => {
    const { projectId, ids } = await setupProject();
    const response = await interference(authorized(`/api/v1/interference?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ clearance: 1 }) }));
    const payload = await response.json() as { pairs?: Array<{ gap: number; overlapVolume: number }> };
    expect(response.status).toBe(200);
    expect(payload.pairs).toEqual([{ a: { id: ids[0], name: "A" }, b: { id: ids[1], name: "B" }, gap: 1, overlapVolume: 0, precision: "exact" }]);
  });

  it("trims non-empty IDs and rejects duplicate IDs after normalization", async () => {
    const { projectId, ids } = await setupProject();
    const response = await interference(authorized(`/api/v1/interference?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ ids: [` ${ids[0]} `, ids[1]], clearance: 1 }),
    }));
    const payload = await response.json() as { shapesChecked?: number; pairs?: unknown[] };
    expect(response.status).toBe(200);
    expect(payload.shapesChecked).toBe(2);
    expect(payload.pairs).toHaveLength(1);
    const duplicate = await interference(authorized(`/api/v1/interference?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ ids: [` ${ids[0]} `, ids[0]], clearance: 1 }),
    }));
    expect(duplicate.status).toBe(400);
  });

  it("rejects empty IDs and non-finite or negative clearance", async () => {
    const { projectId } = await setupProject();
    const emptyIds = await interference(authorized(`/api/v1/interference?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [] }) }));
    const negative = await interference(authorized(`/api/v1/interference?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ clearance: -1 }) }));
    const nonFinite = await interference(authorized(`/api/v1/interference?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ clearance: null }) }));
    expect([emptyIds.status, negative.status, nonFinite.status]).toEqual([400, 400, 400]);
  });

  it("rejects negative clearance and missing project id", async () => {
    expect((await interference(authorized("/api/v1/interference?projectId=p", { method: "POST", body: JSON.stringify({ clearance: -1 }) }))).status).toBe(400);
    expect((await interference(authorized("/api/v1/interference", { method: "POST", body: JSON.stringify({}) }))).status).toBe(400);
  });

  it("returns a limit error when more than 128 shapes are selected", async () => {
    const created = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Large scene" }) }));
    const projectId = ((await created.json()) as { project: { id: string } }).project.id;
    const added = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: Array.from({ length: 129 }, (_, index) => ({ kind: "box", width: 1, depth: 1, height: 1, x: index * 2 })) }),
    }));
    const ids = ((await added.json()) as { shapes: Array<{ id: string }> }).shapes.map((shape) => shape.id);
    const response = await interference(authorized(`/api/v1/interference?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids }) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "limit_exceeded", limit: 128, given: 129 });
  });
});
