import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { POST as createShapes } from "@/app/api/v1/shapes/route";
import { POST as exportProject } from "@/app/api/v1/exports/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

const TOKEN = "test-token-value";
let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

async function makeProject() {
  const response = await createProject(authorized("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Export fixture" }),
  }));
  const payload = await response.json() as { project: { id: string } };
  const created = await createShapes(authorized(`/api/v1/shapes?projectId=${payload.project.id}`, {
    method: "POST",
    body: JSON.stringify({ shapes: [{ kind: "box", name: "Plate", width: 20, depth: 10, height: 4 }] }),
  }));
  expect(created.status).toBe(201);
  return payload.project.id;
}

describe("REST API v1 project exports", () => {
  beforeEach(async () => {
    previousRoot = process.env[SERVER_PROJECTS_ENV];
    previousToken = process.env[API_TOKEN_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-exports-"));
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

  it("exports a project mesh in binary STL form", async () => {
    const projectId = await makeProject();
    const response = await exportProject(authorized(`/api/v1/exports?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ format: "stl" }),
    }));

    expect(response.status).toBe(200);
    const artifact = await response.json() as {
      format: string; filename: string; mimeType: string; bytes: number; shapeCount: number; base64: string;
    };
    expect(artifact).toMatchObject({
      format: "stl",
      filename: "Export fixture.stl",
      mimeType: "model/stl",
      shapeCount: 1,
    });
    const bytes = Buffer.from(artifact.base64, "base64");
    expect(bytes.byteLength).toBe(artifact.bytes);
    expect(bytes.byteLength).toBeGreaterThan(84);
    expect(bytes.readUInt32LE(80)).toBeGreaterThan(0);
  });

  it("returns raw artifact bytes and metadata headers for file downloads", async () => {
    const projectId = await makeProject();
    const response = await exportProject(authorized(`/api/v1/exports?projectId=${projectId}&download=1`, {
      method: "POST",
      body: JSON.stringify({ format: "stl" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("model/stl");
    expect(response.headers.get("content-disposition")).toContain("Export%20fixture.stl");
    const metadata = JSON.parse(decodeURIComponent(response.headers.get("x-sketchforge-metadata") ?? "{}"));
    expect(metadata).toMatchObject({ format: "stl", filename: "Export fixture.stl", shapeCount: 1 });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(84);
    expect(new DataView(bytes.buffer).getUint32(80, true)).toBeGreaterThan(0);
  });

  it.each(["obj", "3mf", "skf", "zip"] as const)("exports the %s artifact", async (format) => {
    const projectId = await makeProject();
    const response = await exportProject(authorized(`/api/v1/exports?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ format }),
    }));

    expect(response.status).toBe(200);
    const artifact = await response.json() as { bytes: number; base64: string; filename: string; shapeCount: number };
    const bytes = Buffer.from(artifact.base64, "base64");
    expect(bytes.byteLength).toBe(artifact.bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(artifact.filename).toMatch(new RegExp(`\\.${format}$`));
    expect(artifact.shapeCount).toBeGreaterThan(0);
    if (format === "3mf" || format === "zip") {
      const entries = Object.keys(unzipSync(bytes));
      if (format === "3mf") expect(entries).toContain("3D/3dmodel.model");
      else expect(entries.some((entry) => entry.endsWith(".stl"))).toBe(true);
    }
  });

  it("exports exact box geometry to STEP", async () => {
    const projectId = await makeProject();
    const response = await exportProject(authorized(`/api/v1/exports?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ format: "step" }),
    }));

    expect(response.status).toBe(200);
    const artifact = await response.json() as { exportedCount: number; bytes: number; base64: string };
    expect(artifact.exportedCount).toBe(1);
    expect(Buffer.from(artifact.base64, "base64").byteLength).toBe(artifact.bytes);
  }, 90_000);

  it("rejects an unsupported format before building geometry", async () => {
    const projectId = await makeProject();
    const response = await exportProject(authorized(`/api/v1/exports?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ format: "gcode" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "unsupported_format" });
  });
});
