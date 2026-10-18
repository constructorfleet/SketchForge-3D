import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getProjects, POST as createProject } from "@/app/api/v1/projects/route";
import { DELETE as deleteProject, GET as getProject } from "@/app/api/v1/projects/[projectId]/route";
import { GET as getShapes, POST as createShapes } from "@/app/api/v1/projects/[projectId]/shapes/route";
import { DELETE as deleteShape, PATCH as patchShape } from "@/app/api/v1/projects/[projectId]/shapes/[shapeId]/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { readProjectDocument, writeProjectDocument } from "@/lib/serverProjectDocument";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

const TOKEN = "test-token-value";

/**
 * One triangle as a binary STL.
 *
 * Reading a project back re-parses an import's source file, so this has to be
 * a file the STL loader accepts -- which also proves that parse runs on the
 * server, with no browser.
 */
function binaryStlTriangle() {
  const buffer = new ArrayBuffer(84 + 50);
  const view = new DataView(buffer);
  view.setUint32(80, 1, true);
  const vertices = [0, 0, 0, 10, 0, 0, 0, 10, 0];
  view.setFloat32(84, 0, true);
  view.setFloat32(88, 0, true);
  view.setFloat32(92, 1, true);
  vertices.forEach((value, index) => view.setFloat32(96 + index * 4, value, true));
  return new Uint8Array(buffer);
}

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

function projectParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function shapeParams(projectId: string, shapeId: string) {
  return { params: Promise.resolve({ projectId, shapeId }) };
}

async function makeProject(name = "Bracket") {
  const response = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name }) }));
  const payload = await response.json() as { project: { id: string } };
  return payload.project.id;
}

async function addShape(projectId: string, shape: Record<string, unknown>) {
  const response = await createShapes(
    authorized(`/api/v1/projects/${projectId}/shapes`, { method: "POST", body: JSON.stringify(shape) }),
    projectParams(projectId),
  );
  return { status: response.status, payload: await response.json() as { shapes?: Array<{ id: string; kind: string }>; error?: string } };
}

describe("REST API v1", () => {
  beforeEach(async () => {
    previousRoot = process.env[SERVER_PROJECTS_ENV];
    previousToken = process.env[API_TOKEN_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-"));
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

  it("is not there at all until a token is configured", async () => {
    delete process.env[API_TOKEN_ENV];

    const response = await getProjects(new Request("http://localhost/api/v1/projects"));

    expect(response.status).toBe(404);
  });

  it("refuses a request with no token, a wrong token, and the wrong scheme", async () => {
    const attempts: HeadersInit[] = [{}, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: `Basic ${TOKEN}` }];
    for (const headers of attempts) {
      const response = await getProjects(new Request("http://localhost/api/v1/projects", { headers }));
      expect(response.status).toBe(401);
    }
  });

  it("needs server-side project storage to have somewhere to write", async () => {
    delete process.env[SERVER_PROJECTS_ENV];

    const response = await getProjects(authorized("/api/v1/projects"));

    expect(response.status).toBe(503);
  });

  it("creates a project and lists it", async () => {
    const projectId = await makeProject("Bracket");

    const payload = await (await getProjects(authorized("/api/v1/projects"))).json() as { projects: Array<{ id: string; name: string; shapes: number }> };

    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]).toMatchObject({ id: projectId, name: "Bracket", shapes: 0 });
  });

  it("requires a name to create a project", async () => {
    const response = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "   " }) }));
    expect(response.status).toBe(400);
  });

  it("adds a shape and reads it back with the dimensions it asked for", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, { kind: "cylinder", width: 8, height: 30, sides: 6, x: 12, name: "Post" });
    expect(created.status).toBe(201);

    const payload = await (await getShapes(authorized(`/api/v1/projects/${projectId}/shapes`), projectParams(projectId))).json() as {
      shapes: Array<{ name: string; kind: string; sides?: number; width: number; height: number; x: number }>;
    };

    expect(payload.shapes).toHaveLength(1);
    expect(payload.shapes[0]).toMatchObject({ name: "Post", kind: "cylinder", sides: 6, width: 8, height: 30, x: 12 });
  });

  it("adds a batch of shapes in one write", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, {
      shapes: [
        { kind: "cube", size: 10, name: "A" },
        { kind: "cube", size: 10, x: 20, name: "B" },
        { kind: "cube", size: 10, x: 40, name: "C" },
      ],
    });

    expect(created.status).toBe(201);
    expect(created.payload.shapes).toHaveLength(3);
    const listing = await (await getShapes(authorized(`/api/v1/projects/${projectId}/shapes`), projectParams(projectId))).json() as { shapes: Array<{ name: string }> };
    expect(listing.shapes.map((shape) => shape.name)).toEqual(["A", "B", "C"]);
  });

  it("reports a kind it cannot build without saying it worked", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, { kind: "sketch", width: 10 });

    expect(created.status).toBe(422);
    expect(created.payload.error).toContain("unsupported kind");
    const listing = await (await getShapes(authorized(`/api/v1/projects/${projectId}/shapes`), projectParams(projectId))).json() as { shapes: unknown[] };
    expect(listing.shapes).toEqual([]);
  });

  it("changes one shape and leaves the others alone", async () => {
    const projectId = await makeProject();
    await addShape(projectId, { shapes: [{ kind: "cube", size: 10, name: "A" }, { kind: "cube", size: 10, name: "B" }] });
    const before = await (await getShapes(authorized(`/api/v1/projects/${projectId}/shapes`), projectParams(projectId))).json() as { shapes: Array<{ id: string; name: string }> };
    const target = before.shapes[0];

    const response = await patchShape(
      authorized(`/api/v1/projects/${projectId}/shapes/${target.id}`, { method: "PATCH", body: JSON.stringify({ height: 42, name: "Taller" }) }),
      shapeParams(projectId, target.id),
    );

    expect(response.status).toBe(200);
    const after = await (await getShapes(authorized(`/api/v1/projects/${projectId}/shapes`), projectParams(projectId))).json() as {
      shapes: Array<{ id: string; name: string; height: number }>;
    };
    expect(after.shapes.find((shape) => shape.id === target.id)).toMatchObject({ name: "Taller", height: 42 });
    expect(after.shapes.find((shape) => shape.id !== target.id)).toMatchObject({ name: "B", height: 10 });
  });

  it("deletes a shape", async () => {
    const projectId = await makeProject();
    const created = await addShape(projectId, { kind: "cube", size: 10 });
    const shapeId = created.payload.shapes![0].id;

    const response = await deleteShape(
      authorized(`/api/v1/projects/${projectId}/shapes/${shapeId}`, { method: "DELETE" }),
      shapeParams(projectId, shapeId),
    );

    expect(response.status).toBe(200);
    const listing = await (await getShapes(authorized(`/api/v1/projects/${projectId}/shapes`), projectParams(projectId))).json() as { shapes: unknown[] };
    expect(listing.shapes).toEqual([]);
  });

  it("will not change or delete a locked shape by accident", async () => {
    const projectId = await makeProject();
    const created = await addShape(projectId, { kind: "cube", size: 10 });
    const shapeId = created.payload.shapes![0].id;
    await patchShape(
      authorized(`/api/v1/projects/${projectId}/shapes/${shapeId}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }),
      shapeParams(projectId, shapeId),
    );

    const blockedPatch = await patchShape(
      authorized(`/api/v1/projects/${projectId}/shapes/${shapeId}`, { method: "PATCH", body: JSON.stringify({ height: 99 }) }),
      shapeParams(projectId, shapeId),
    );
    const blockedDelete = await deleteShape(
      authorized(`/api/v1/projects/${projectId}/shapes/${shapeId}`, { method: "DELETE" }),
      shapeParams(projectId, shapeId),
    );

    expect(blockedPatch.status).toBe(409);
    expect(blockedDelete.status).toBe(409);
  });

  it("unlocks a shape when asked to, so a lock is not a dead end", async () => {
    const projectId = await makeProject();
    const created = await addShape(projectId, { kind: "cube", size: 10 });
    const shapeId = created.payload.shapes![0].id;
    await patchShape(
      authorized(`/api/v1/projects/${projectId}/shapes/${shapeId}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }),
      shapeParams(projectId, shapeId),
    );

    const response = await patchShape(
      authorized(`/api/v1/projects/${projectId}/shapes/${shapeId}`, { method: "PATCH", body: JSON.stringify({ locked: false }) }),
      shapeParams(projectId, shapeId),
    );

    expect(response.status).toBe(200);
  });

  it("reports a project, shape, and project id that are not there", async () => {
    const projectId = await makeProject();

    expect((await getProject(authorized("/api/v1/projects/project-missing"), projectParams("project-missing"))).status).toBe(404);
    expect((await getShapes(authorized("/api/v1/projects/..%2Fescaped/shapes"), projectParams("../escaped"))).status).toBe(400);
    expect((await deleteShape(
      authorized(`/api/v1/projects/${projectId}/shapes/shape-missing`, { method: "DELETE" }),
      shapeParams(projectId, "shape-missing"),
    )).status).toBe(404);
  });

  it("advances the project revision so an open dashboard reloads it", async () => {
    const projectId = await makeProject();
    const before = await (await getProjects(authorized("/api/v1/projects"))).json() as { projects: Array<{ revision: number }> };

    await addShape(projectId, { kind: "cube", size: 10 });

    const after = await (await getProjects(authorized("/api/v1/projects"))).json() as { projects: Array<{ revision: number; shapes: number }> };
    expect(after.projects[0].revision).toBeGreaterThan(before.projects[0].revision);
    expect(after.projects[0].shapes).toBe(1);
  });

  it("keeps the project's own settings in the package across a shape write", async () => {
    // The settings live in the .skf as well as the sidecar, and the editor
    // reads them from the package -- so this has to assert on the package.
    const projectId = await makeProject();
    await addShape(projectId, { kind: "cube", size: 10 });
    const first = await readProjectDocument(projectsRoot, projectId);
    await writeProjectDocument(projectsRoot, projectId, { ...first!, snapGrid: "5.0 mm", placementElevation: 7 }, first!.shapes);

    await addShape(projectId, { kind: "cube", size: 10, x: 30 });

    const document = await readProjectDocument(projectsRoot, projectId);
    expect(document?.snapGrid).toBe("5.0 mm");
    expect(document?.placementElevation).toBe(7);
    expect(document?.shapes).toHaveLength(2);
  });

  it("keeps the dashboard's own metadata fields across a shape write", async () => {
    const projectId = await makeProject();
    const sidecarPath = path.join(projectsRoot, `${projectId}.json`);
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(sidecarPath, JSON.stringify({ ...sidecar, accent: "amber" }, null, 2));

    await addShape(projectId, { kind: "cube", size: 10 });

    const stored = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as Record<string, unknown>;
    expect(stored.accent).toBe("amber");
  });

  it("keeps an imported model's source file across a shape write", async () => {
    // An import's bytes live in the project's asset list, not on the shape, so
    // repacking the project without them would quietly strip the import out.
    const projectId = await makeProject();
    await addShape(projectId, { kind: "cube", size: 10 });
    const document = await readProjectDocument(projectsRoot, projectId);
    const bytes = binaryStlTriangle();
    const importedShape = {
      ...document!.shapes[0],
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 10,
        triangleCount: 1,
        sourceFormat: "stl" as const,
        assetId: "asset-1",
      },
    };
    await writeProjectDocument(
      projectsRoot,
      projectId,
      {
        ...document!,
        assets: [{
          id: "asset-1",
          name: "bracket.stl",
          mediaType: "model/stl",
          sourceFormat: "stl",
          bytes,
          byteLength: bytes.byteLength,
          sha256: "a".repeat(64),
        }],
      },
      [importedShape],
    );

    await addShape(projectId, { kind: "cube", size: 10, x: 25 });

    const after = await readProjectDocument(projectsRoot, projectId);
    expect(after?.assets.map((asset) => asset.name)).toEqual(["bracket.stl"]);
    expect(after?.assets[0].byteLength).toBe(bytes.byteLength);
  });

  it("keeps an undo step for the state before an API change", async () => {
    const projectId = await makeProject();
    await addShape(projectId, { kind: "cube", size: 10, name: "First" });
    await addShape(projectId, { kind: "cube", size: 10, x: 20, name: "Second" });

    const document = await readProjectDocument(projectsRoot, projectId);
    expect(document?.history.length).toBeGreaterThan(1);
    expect(document?.history[document.historyIndex].shapes.map((shape) => shape.name)).toEqual(["First", "Second"]);
    expect(document?.history[document!.historyIndex - 1].shapes.map((shape) => shape.name)).toEqual(["First"]);
  });

  it("deletes a project and everything it held", async () => {
    const projectId = await makeProject();
    await addShape(projectId, { kind: "cube", size: 10 });

    const response = await deleteProject(authorized(`/api/v1/projects/${projectId}`, { method: "DELETE" }), projectParams(projectId));

    expect(response.status).toBe(200);
    expect(await fs.readdir(projectsRoot)).toEqual([]);
  });
});
