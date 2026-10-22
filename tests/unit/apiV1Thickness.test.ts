import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as thickness } from "@/app/api/v1/thickness/route";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { POST as createShapes } from "@/app/api/v1/shapes/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const TOKEN = "thickness-contract-test-token";
let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

async function createFixture() {
  const projectResponse = await createProject(authorized("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Thickness" }),
  }));
  const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id;
  const shapeResponse = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, {
    method: "POST",
    body: JSON.stringify({ kind: "box", width: 20, depth: 12, height: 8, name: "Block" }),
  }));
  const shapeId = ((await shapeResponse.json()) as { shapes: Array<{ id: string }> }).shapes[0]!.id;
  return { projectId, shapeId };
}

describe("REST API v1 thickness", () => {
  beforeEach(async () => {
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-thickness-"));
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

  it("returns the current sampled thickness result covered by the OpenAPI contract", async () => {
    const { projectId, shapeId } = await createFixture();
    const response = await thickness(authorized(`/api/v1/thickness?projectId=${projectId}&shapeId=${shapeId}`));
    const payload = await response.json() as { thickness?: { minimum: number | null; unit: string; method: string; samplesPerFace: number; facesChecked: number }; code?: string };

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.thickness).toMatchObject({ minimum: 8, unit: "mm", method: "sampled-opposing-surface-distance", samplesPerFace: 25, facesChecked: 6 });
  }, CAD_TEST_TIMEOUT_MS);

  it("requires a valid project id and a non-empty shape id", async () => {
    expect((await thickness(authorized("/api/v1/thickness?shapeId=shape"))).status).toBe(400);
    expect((await thickness(authorized("/api/v1/thickness?projectId=project&shapeId=%20"))).status).toBe(400);
  });
});
