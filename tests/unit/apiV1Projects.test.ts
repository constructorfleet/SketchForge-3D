import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE as deleteProject, GET as getProjects, POST as createProject } from "@/app/api/v1/projects/route";
import { DELETE as deleteShape, GET as getShapes, PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { GET as edges } from "@/app/api/v1/edges/route";
import { POST as treatments } from "@/app/api/v1/treatments/route";
import { POST as draftPrism } from "@/app/api/v1/draft-prism/route";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { readProjectDocument, writeProjectDocument } from "@constructorfleet/sketchforge-engine/serverProjectDocument";
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

async function makeProject(name = "Bracket") {
  const response = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name }) }));
  const payload = await response.json() as { project: { id: string } };
  return payload.project.id;
}

async function addShape(projectId: string, shape: Record<string, unknown>) {
  const response = await createShapes(
    authorized(`/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify(shape) }),
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

  it("paginates project and shape listings with a next cursor", async () => {
    const firstProjectId = await makeProject("First");
    await makeProject("Second");
    await makeProject("Third");

    const firstProjectsResponse = await getProjects(authorized("/api/v1/projects?limit=2"));
    const firstProjects = await firstProjectsResponse.json() as { projects: Array<{ id: string }>; nextCursor: string | null };
    expect(firstProjects.projects).toHaveLength(2);
    expect(firstProjects.nextCursor).toEqual(expect.any(String));
    const secondProjects = await (await getProjects(authorized(`/api/v1/projects?limit=2&cursor=${encodeURIComponent(firstProjects.nextCursor!)}`))).json() as { projects: Array<{ id: string }>; nextCursor: string | null };
    expect(secondProjects.projects).toHaveLength(1);
    expect(secondProjects.nextCursor).toBeNull();
    expect([...firstProjects.projects, ...secondProjects.projects]).toHaveLength(3);

    await addShape(firstProjectId, { kind: "cube", size: 10, name: "A" });
    await addShape(firstProjectId, { kind: "cube", size: 10, x: 20, name: "B" });
    await addShape(firstProjectId, { kind: "cube", size: 10, x: 40, name: "C" });
    const firstShapes = await (await getShapes(authorized(`/api/v1/shapes?projectId=${firstProjectId}&limit=2`))).json() as { shapes: Array<{ name: string }>; nextCursor: string | null };
    expect(firstShapes.shapes).toHaveLength(2);
    expect(firstShapes.nextCursor).toEqual(expect.any(String));
    const secondShapes = await (await getShapes(authorized(`/api/v1/shapes?projectId=${firstProjectId}&limit=2&cursor=${encodeURIComponent(firstShapes.nextCursor!)}`))).json() as { shapes: Array<{ name: string }>; nextCursor: string | null };
    expect(secondShapes.shapes).toHaveLength(1);
    expect(secondShapes.nextCursor).toBeNull();
    expect([...firstShapes.shapes, ...secondShapes.shapes].map((shape) => shape.name)).toEqual(["A", "B", "C"]);
  });

  it("requires a name to create a project", async () => {
    const response = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "   " }) }));
    expect(response.status).toBe(400);
  });

  it("adds a shape and reads it back with the dimensions it asked for", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, { kind: "cylinder", width: 8, height: 30, sides: 6, x: 12, name: "Post" });
    expect(created.status).toBe(201);

    const payload = await (await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as {
      shapes: Array<{ name: string; kind: string; sides?: number; width: number; height: number; x: number }>;
    };

    expect(payload.shapes).toHaveLength(1);
    expect(payload.shapes[0]).toMatchObject({ name: "Post", kind: "cylinder", sides: 6, width: 8, height: 30, x: 12 });
  });

  it("rejects a shape request without its required kind before engine dispatch", async () => {
    const projectId = await makeProject();
    const created = await addShape(projectId, { width: 10 });
    expect(created.status).toBe(400);
    expect(created.payload).toMatchObject({ code: "invalid_request" });
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
    const listing = await (await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as { shapes: Array<{ name: string }> };
    expect(listing.shapes.map((shape) => shape.name)).toEqual(["A", "B", "C"]);
  });

  it("returns a limit error when a shape batch exceeds 200 entries", async () => {
    const projectId = await makeProject();
    const response = await createShapes(authorized(`/api/v1/shapes?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ shapes: Array.from({ length: 201 }, () => ({ kind: "box", width: 1, depth: 1, height: 1 })) }),
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "limit_exceeded", limit: 200, given: 201 });
  });

  it("creates a thread from a diameter and a pitch", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, { kind: "thread", diameter: 8, pitch: 1.25, turns: 6, name: "M8" });

    expect(created.status).toBe(201);
    const document = await readProjectDocument(projectsRoot, projectId);
    const thread = document?.shapes[0];
    expect(thread?.name).toBe("M8");
    expect(thread?.width).toBeCloseTo(8, 0);
    // Six turns of rise plus the one-pitch-tall profile.
    expect(thread?.height).toBeCloseTo(1.25 * 7, 1);
    // Still a revolve, so its pitch is editable in the inspector afterwards.
    expect(thread?.sketchRevolve).toMatchObject({ pitch: 1.25, turns: 6 });
  });

  it("creates a thread from a catalog size, which carries its own pitch", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, { kind: "thread", size: "M6", length: 12 });

    expect(created.status).toBe(201);
    const document = await readProjectDocument(projectsRoot, projectId);
    const thread = document?.shapes[0];
    // M6 is 1mm coarse pitch, so 12mm of thread is 12 turns, and the name says
    // which size it is rather than just "Thread".
    expect(thread?.name).toBe("M6");
    expect(thread?.sketchRevolve?.pitch).toBe(1);
    expect(thread?.sketchRevolve?.turns).toBe(12);
    expect(thread?.width).toBeCloseTo(6, 0);
  });

  it("cuts a tapped hole wider than the bolt, and marks it as a hole", async () => {
    const projectId = await makeProject();

    await addShape(projectId, { kind: "thread", size: "M8", turns: 4 });
    await addShape(projectId, { kind: "thread", size: "M8", turns: 4, hole: true });

    const document = await readProjectDocument(projectsRoot, projectId);
    const solid = document?.shapes.find((shape) => shape.name === "M8");
    const hole = document?.shapes.find((shape) => shape.name === "M8 hole");

    expect(hole?.hole).toBe(true);
    expect(solid?.hole).toBeFalsy();
    // 0.2mm of clearance on each side, so the bolt fits.
    expect(hole!.width).toBeGreaterThan(solid!.width);
    expect(hole!.width - solid!.width).toBeCloseTo(0.4, 1);
  });

  it("names the sizes it knows when given one it does not", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, { kind: "thread", size: "M7" });

    expect(created.status).toBe(400);
    expect(created.payload.error).toContain("M8");
  });

  it("creates a revolve from an outline, with or without a pitch", async () => {
    const projectId = await makeProject();
    const outline = [[4, 0], [6, 0], [6, 3], [4, 3]];

    const spring = await addShape(projectId, { kind: "revolve", profile: outline, pitch: 5, turns: 4, name: "Coil" });
    const ring = await addShape(projectId, { kind: "revolve", profile: outline, name: "Ring" });

    expect(spring.status).toBe(201);
    expect(ring.status).toBe(201);
    const document = await readProjectDocument(projectsRoot, projectId);
    const coil = document?.shapes.find((shape) => shape.name === "Coil");
    const plain = document?.shapes.find((shape) => shape.name === "Ring");
    expect(coil?.height).toBeCloseTo(5 * 4 + 3, 1);
    // No pitch: a plain ring of the profile's own height.
    expect(plain?.height).toBeCloseTo(3, 1);
  });

  it("explains an outline it cannot revolve", async () => {
    const projectId = await makeProject();

    const missing = await addShape(projectId, { kind: "revolve" });
    const tooFew = await addShape(projectId, { kind: "revolve", profile: [[1, 1], [2, 2]] });

    expect(missing.status).toBe(400);
    expect(missing.payload.error).toContain("profile");
    expect(tooFew.status).toBe(400);
    expect(tooFew.payload.error).toContain("at least 3");
  });

  it("reports a kind it cannot build without saying it worked", async () => {
    const projectId = await makeProject();

    const created = await addShape(projectId, { kind: "sketch", width: 10 });

    expect(created.status).toBe(422);
    expect(created.payload.error).toContain("unsupported kind");
    const listing = await (await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as { shapes: unknown[] };
    expect(listing.shapes).toEqual([]);
  });

  it("changes one shape and leaves the others alone", async () => {
    const projectId = await makeProject();
    await addShape(projectId, { shapes: [{ kind: "cube", size: 10, name: "A" }, { kind: "cube", size: 10, name: "B" }] });
    const before = await (await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as { shapes: Array<{ id: string; name: string }> };
    const target = before.shapes[0];

    const response = await patchShape(
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${target.id}`, { method: "PATCH", body: JSON.stringify({ height: 42, name: "Taller" }) }));

    expect(response.status).toBe(200);
    const after = await (await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as {
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
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "DELETE" }));

    expect(response.status).toBe(200);
    const listing = await (await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as { shapes: unknown[] };
    expect(listing.shapes).toEqual([]);
  });

  it("will not change or delete a locked shape by accident", async () => {
    const projectId = await makeProject();
    const created = await addShape(projectId, { kind: "cube", size: 10 });
    const shapeId = created.payload.shapes![0].id;
    await patchShape(
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }));

    const blockedPatch = await patchShape(
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "PATCH", body: JSON.stringify({ height: 99 }) }));
    const blockedDelete = await deleteShape(
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "DELETE" }));

    expect(blockedPatch.status).toBe(409);
    expect(blockedDelete.status).toBe(409);
  });

  it("unlocks a shape when asked to, so a lock is not a dead end", async () => {
    const projectId = await makeProject();
    const created = await addShape(projectId, { kind: "cube", size: 10 });
    const shapeId = created.payload.shapes![0].id;
    await patchShape(
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }));

    const response = await patchShape(
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "PATCH", body: JSON.stringify({ locked: false }) }));

    expect(response.status).toBe(200);
  });

  it("reports a project, shape, and project id that are not there", async () => {
    const projectId = await makeProject();

    expect((await getProjects(authorized("/api/v1/projects?projectId=project-missing"))).status).toBe(404);
    expect((await getShapes(authorized("/api/v1/shapes?projectId=..%2Fescaped"))).status).toBe(400);
    expect((await deleteShape(
      authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=shape-missing`, { method: "DELETE" }))).status).toBe(404);
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

    const response = await deleteProject(authorized(`/api/v1/projects?projectId=${projectId}`, { method: "DELETE" }));

    expect(response.status).toBe(200);
    expect(await fs.readdir(projectsRoot)).toEqual([]);
  });
});

// These go through the CAD kernel; see the note in serverCadSolids.test.ts.
describe("REST API v1 edge treatments", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  beforeEach(async () => {
    previousRoot = process.env[SERVER_PROJECTS_ENV];
    previousToken = process.env[API_TOKEN_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-cad-"));
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

  async function boxProject() {
    const projectId = await makeProject("Filleted");
    const created = await addShape(projectId, { kind: "box", width: 40, depth: 40, height: 10, name: "Plate" });
    return { projectId, shapeId: created.payload.shapes![0].id };
  }

  function treat(projectId: string, shapeId: string, body: Record<string, unknown>) {
    return treatments(
      authorized(`/api/v1/treatments?projectId=${projectId}&shapeId=${shapeId}`, { method: "POST", body: JSON.stringify(body) }));
  }

  it("drafts a solid and persists exact geometry through the API", async () => {
    const { projectId, shapeId } = await boxProject();
    const sourceDocument = await readProjectDocument(projectsRoot, projectId);
    const sourceShape = sourceDocument?.shapes.find((candidate) => candidate.id === shapeId);
    expect(sourceDocument && sourceShape).toBeTruthy();
    const points = [
      { id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: -20 },
      { id: "c", x: 20, z: 20 }, { id: "d", x: -20, z: 20 },
    ];
    Object.assign(sourceShape!, {
      kind: "mesh",
      sketchOperation: "extrude",
      sketchProfile: {
        points,
        segments: points.map((point, index) => ({ id: `edge-${index}`, startId: point.id, endId: points[(index + 1) % points.length].id, kind: "line" })),
      },
    });
    await writeProjectDocument(projectsRoot, projectId, sourceDocument!, sourceDocument!.shapes);
    const response = await draftPrism(authorized(`/api/v1/draft-prism?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "POST",
      body: JSON.stringify({ angle: 5 }),
    }));
    const payload = await response.json() as { shape: { kind: string }; triangles: number; revision: number };

    expect(response.status).toBe(200);
    expect(payload.shape.kind).toBe("mesh");
    expect(payload.triangles).toBeGreaterThan(0);
    const document = await readProjectDocument(projectsRoot, projectId);
    const shape = document?.shapes.find((candidate) => candidate.id === shapeId);
    expect(shape?.cadBrep).toContain("CASCADE Topology");
    expect(shape?.importedMesh?.triangleCount).toBe(payload.triangles);
  });

  it("edits a persisted draft-prism angle by the sketch source ID and reports it in shape summaries", async () => {
    const { projectId, shapeId } = await boxProject();
    const document = await readProjectDocument(projectsRoot, projectId);
    const sourceShape = document?.shapes.find((candidate) => candidate.id === shapeId);
    expect(document && sourceShape).toBeTruthy();
    const points = [
      { id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: -20 },
      { id: "c", x: 20, z: 20 }, { id: "d", x: -20, z: 20 },
    ];
    Object.assign(sourceShape!, {
      kind: "mesh",
      sketchOperation: "extrude",
      sketchSourceId: "sketch/api-draft-prism",
      sketchProfile: {
        points,
        segments: points.map((point, index) => ({ id: `edge-${index}`, startId: point.id, endId: points[(index + 1) % points.length]!.id, kind: "line" })),
      },
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 40, depth: 40, height: 10 },
    });
    await writeProjectDocument(projectsRoot, projectId, document!, document!.shapes);
    const drafted = await draftPrism(authorized(`/api/v1/draft-prism?projectId=${projectId}&shapeId=${shapeId}`, {
      method: "POST",
      body: JSON.stringify({ angle: 5 }),
    }));
    expect(drafted.status).toBe(200);

    const changed = await patchShape(authorized(
      `/api/v1/shapes?projectId=${projectId}&shapeId=sketch%2Fapi-draft-prism`,
      { method: "PATCH", body: JSON.stringify({ draftPrismAngle: 12 }) },
    ));
    const payload = await changed.json() as { shape?: { id: string; sketchSourceId: string; draftPrismAngle: number } };
    expect(changed.status).toBe(200);
    expect(payload.shape).toMatchObject({ id: shapeId, sketchSourceId: "sketch/api-draft-prism", draftPrismAngle: 12 });

    const listing = await (await getShapes(authorized(`/api/v1/shapes?projectId=${projectId}`))).json() as {
      shapes: Array<{ id: string; draftPrismAngle?: number }>;
    };
    expect(listing.shapes.find((shape) => shape.id === shapeId)?.draftPrismAngle).toBe(12);
  });

  it("lists a box's edges", async () => {
    const { projectId, shapeId } = await boxProject();

    const response = await edges(authorized(`/api/v1/edges?projectId=${projectId}&shapeId=${shapeId}`));
    const payload = await response.json() as { edges: Array<{ index: number; length: number }> };

    expect(response.status).toBe(200);
    expect(payload.edges).toHaveLength(12);
  });

  it("fillets a box and stores exact geometry on the shape", async () => {
    const { projectId, shapeId } = await boxProject();

    const response = await treat(projectId, shapeId, { kind: "fillet", amount: 3 });
    const payload = await response.json() as { shape: { kind: string }; triangles: number };

    expect(response.status).toBe(200);
    expect(payload.shape.kind).toBe("mesh");
    expect(payload.triangles).toBeGreaterThan(100);

    const document = await readProjectDocument(projectsRoot, projectId);
    const shape = document?.shapes.find((candidate) => candidate.id === shapeId);
    expect(shape?.cadBrep).toContain("CASCADE Topology");
    expect(shape?.importedMesh?.positions.length).toBe(payload.triangles * 9);
  });

  it("chamfers only the edges it is given", async () => {
    const { projectId, shapeId } = await boxProject();

    const response = await treat(projectId, shapeId, { kind: "chamfer", amount: 2, edges: [0, 1] });

    expect(response.status).toBe(200);
  });

  it("reports a radius the geometry cannot take", async () => {
    const projectId = await makeProject("Thin");
    const created = await addShape(projectId, { kind: "box", width: 40, depth: 40, height: 1 });
    const shapeId = created.payload.shapes![0].id;

    const response = await treat(projectId, shapeId, { kind: "fillet", amount: 5 });

    expect(response.status).toBe(422);
    expect((await response.json() as { error: string }).error).toMatch(/too large/);
    // The project is left as it was, not half-treated.
    const document = await readProjectDocument(projectsRoot, projectId);
    expect(document?.shapes[0].cadBrep).toBeUndefined();
  });

  it("checks the request before touching the kernel", async () => {
    const { projectId, shapeId } = await boxProject();

    expect((await treat(projectId, shapeId, { amount: 3 })).status).toBe(400);
    expect((await treat(projectId, shapeId, { kind: "fillet" })).status).toBe(400);
    expect((await treat(projectId, shapeId, { kind: "fillet", amount: 3, edges: "some" })).status).toBe(400);
    expect((await treat(projectId, shapeId, { kind: "fillet", amount: 3, angle: "wide" })).status).toBe(400);
  });

  it("says what it cannot treat instead of approximating it", async () => {
    const projectId = await makeProject("Lettering");
    const created = await addShape(projectId, { kind: "text", width: 20, depth: 20, height: 20, text: "HI" });
    const shapeId = created.payload.shapes![0].id;

    const response = await treat(projectId, shapeId, { kind: "fillet", amount: 1 });

    expect(response.status).toBe(422);
    expect((await response.json() as { error: string }).error).toMatch(/text/);
  });

  it("treats the parametric kinds, not just boxes", async () => {
    const projectId = await makeProject("Everything");
    const created = await addShape(projectId, {
      shapes: [
        { kind: "cylinder", width: 30, depth: 30, height: 20, name: "Round" },
        { kind: "cylinder", width: 30, depth: 30, height: 20, sides: 6, name: "Hex" },
        { kind: "loft", width: 30, depth: 30, height: 20, name: "Loft" },
      ],
    });

    for (const shape of created.payload.shapes!) {
      const response = await treat(projectId, shape.id, { kind: "fillet", amount: 1 });
      expect(response.status, shape.kind).toBe(200);
    }
  });

  it("advances the revision so an open editor reloads the treated shape", async () => {
    const { projectId, shapeId } = await boxProject();
    const before = await (await getProjects(authorized("/api/v1/projects"))).json() as { projects: Array<{ revision: number }> };

    await treat(projectId, shapeId, { kind: "fillet", amount: 3 });

    const after = await (await getProjects(authorized("/api/v1/projects"))).json() as { projects: Array<{ revision: number }> };
    expect(after.projects[0].revision).toBeGreaterThan(before.projects[0].revision);
  });
});
