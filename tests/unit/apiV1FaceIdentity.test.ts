import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { POST as createShapes, GET as listShapes, PATCH as updateShape } from "@/app/api/v1/shapes/route";
import { GET as listFaces } from "@/app/api/v1/faces/route";
import { POST as treatShape } from "@/app/api/v1/treatments/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { validateApiV1Response } from "@/lib/apiV1OperationContract";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const TOKEN = "face-identity-test-token";
const RED = "#ff0000";

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
  const response = await createProject(authorized("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Face identity" }),
  }));
  const payload = await response.json() as { project: { id: string } };
  return payload.project.id;
}

async function shape(projectId: string) {
  const response = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, {
    method: "POST",
    body: JSON.stringify({ kind: "box", width: 40, depth: 25, height: 10, name: "Plate" }),
  }));
  const payload = await response.json() as { shapes: Array<{ id: string }> };
  expect(response.status).toBe(201);
  return payload.shapes[0]!.id;
}

function faces(projectId: string, shapeId: string) {
  return listFaces(authorized(`/api/v1/faces?projectId=${projectId}&shapeId=${shapeId}`));
}

describe("REST API v1 stable face identity", () => {
  beforeEach(async () => {
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-face-id-"));
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

  it("keeps colors on faces that survive a fillet, using public face IDs", async () => {
    const projectId = await project();
    const shapeId = await shape(projectId);

    const initialFacesResponse = await faces(projectId, shapeId);
    const initialFacesBody = await initialFacesResponse.clone().json();
    expect(validateApiV1Response("GET /api/v1/faces", initialFacesResponse.status, initialFacesBody)).toBe(true);
    const listed = initialFacesBody as {
      faces: Array<{ id?: string; index: number }>;
    };
    expect(listed.faces).toHaveLength(6);
    expect(listed.faces.every((face) => typeof face.id === "string" && face.id.length > 0)).toBe(true);
    expect(new Set(listed.faces.map((face) => face.id)).size).toBe(6);

    const colorMap = Object.fromEntries(listed.faces.map((face) => [face.id!, RED]));
    const changed = await updateShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "PATCH",
      body: JSON.stringify({ faceColors: colorMap }),
    }));
    expect(changed.status).toBe(200);

    const treated = await treatShape(authorized(`/api/v1/treatments?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "POST",
      body: JSON.stringify({ kind: "fillet", amount: 1, edges: [0] }),
    }));
    expect(treated.status).toBe(200);

    const after = await (await faces(projectId, shapeId)).json() as {
      faces: Array<{ id?: string; index: number }>;
    };
    const saved = await (await listShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as {
      shapes: Array<{ id: string; faceColors?: Record<string, string> }>;
    };
    const colored = saved.shapes.find((entry) => entry.id === shapeId)?.faceColors ?? {};

    expect(Object.keys(colored).length).toBeGreaterThan(0);
    expect(Object.entries(colored).every(([id, color]) => after.faces.some((face) => face.id === id) && color === RED)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a uniquely matchable face ID and its color after a box dimension edit", async () => {
    const projectId = await project();
    const shapeId = await shape(projectId);
    const before = await (await faces(projectId, shapeId)).json() as {
      faces: Array<{ id?: string; normal: { x: number; y: number; z: number } | null }>;
    };
    const topFace = before.faces.find((face) => face.normal?.y === 1);
    expect(topFace?.id).toBeTruthy();

    const painted = await updateShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "PATCH",
      body: JSON.stringify({ faceColors: { [topFace!.id!]: RED } }),
    }));
    expect(painted.status).toBe(200);

    const resized = await updateShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "PATCH",
      body: JSON.stringify({ width: 60 }),
    }));
    expect(resized.status).toBe(200);

    const after = await (await faces(projectId, shapeId)).json() as {
      faces: Array<{ id?: string; normal: { x: number; y: number; z: number } | null }>;
    };
    const saved = await (await listShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as {
      shapes: Array<{ id: string; faceIds?: string[]; faceColors?: Record<string, string> }>;
    };
    const edited = saved.shapes.find((entry) => entry.id === shapeId)!;

    expect(after.faces.some((face) => face.id === topFace!.id)).toBe(true);
    expect(edited.faceColors).toEqual({ [topFace!.id!]: RED });
    expect(edited.faceIds).toContain(topFace!.id);
  }, CAD_TEST_TIMEOUT_MS);

  it("returns contract-valid errors for missing or invalid target query values", async () => {
    for (const [url, expectedCode] of [
      ["/api/v1/faces?shapeId=shape", "invalid_project_id"],
      ["/api/v1/faces?projectId=project&shapeId=%20%20", "invalid_shape_id"],
    ] as const) {
      const response = await listFaces(authorized(url));
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.code).toBe(expectedCode);
      expect(validateApiV1Response("GET /api/v1/faces", response.status, body)).toBe(true);
    }
  });

  it("migrates legacy numeric face colors to IDs before a fillet", async () => {
    const projectId = await project();
    const shapeId = await shape(projectId);
    const changed = await updateShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "PATCH",
      body: JSON.stringify({ faceColors: { 0: RED } }),
    }));
    expect(changed.status).toBe(200);

    const treated = await treatShape(authorized(`/api/v1/treatments?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "POST",
      body: JSON.stringify({ kind: "fillet", amount: 1, edges: [0] }),
    }));
    expect(treated.status).toBe(200);

    const after = await (await faces(projectId, shapeId)).json() as {
      faces: Array<{ id?: string; index: number }>;
    };
    const saved = await (await listShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as {
      shapes: Array<{ id: string; faceColors?: Record<string, string> }>;
    };
    const colored = saved.shapes.find((entry) => entry.id === shapeId)?.faceColors ?? {};

    expect(Object.keys(colored).length).toBeGreaterThan(0);
    expect(Object.entries(colored).every(([id, color]) => after.faces.some((face) => face.id === id) && color === RED)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);
});
