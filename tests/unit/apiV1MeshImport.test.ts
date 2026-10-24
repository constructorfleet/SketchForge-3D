import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as importMesh } from "@/app/api/v1/imports/route";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { importedMeshFromFile } from "@constructorfleet/sketchforge-engine/meshImport";
import { readProjectDocument } from "@constructorfleet/sketchforge-engine/serverProjectDocument";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

const TOKEN = "test-token-value";

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

beforeEach(async () => {
  previousRoot = process.env[SERVER_PROJECTS_ENV];
  previousToken = process.env[API_TOKEN_ENV];
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-import-"));
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

async function makeProject() {
  const response = await createProject(new Request("http://localhost/api/v1/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Imported" }),
  }));
  const payload = await response.json() as { project: { id: string } };
  return payload.project.id;
}

/**
 * An ASCII STL of a rectangular plate, in the slicer's Z-up convention.
 *
 * Three different side lengths on purpose. The importer maps a Z-up file into
 * SketchForge's Y-up scene, and with two equal sides a swapped or negated axis
 * is invisible: an 80 x 60 x 20 plate becomes an 80 wide, 60 deep, 20 high one
 * and no other permutation of those numbers.
 *
 * The header deliberately does not say "sketchforge": the importer honours the
 * Y-up orientation of this project's own older exports, recognised by that word
 * in the header, and this fixture is testing the other path.
 */
function plateStl(xSize: number, ySize: number, zSize: number) {
  const corners = [
    [0, 0, 0], [xSize, 0, 0], [xSize, ySize, 0], [0, ySize, 0],
    [0, 0, zSize], [xSize, 0, zSize], [xSize, ySize, zSize], [0, ySize, zSize],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const facets = faces.map(([a, b, c]) => [
    "facet normal 0 0 0",
    "  outer loop",
    `    vertex ${corners[a].join(" ")}`,
    `    vertex ${corners[b].join(" ")}`,
    `    vertex ${corners[c].join(" ")}`,
    "  endloop",
    "endfacet",
  ].join("\n")).join("\n");
  return new TextEncoder().encode(`solid plate\n${facets}\nendsolid plate`);
}

function base64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

function jsonImport(projectId: string, body: Record<string, unknown>) {
  return importMesh(new Request(`http://localhost/api/v1/imports?projectId=${projectId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/**
 * Volume and centre of mass of a stored triangle soup, by the divergence theorem.
 *
 * Not bounding extents: a box's bounding box is unchanged by a reflection or by
 * a face wound the wrong way, and the import path does reflect -- the Z-up
 * conversion negates an axis -- so extents are exactly the measure that cannot
 * see whether it went right.
 */
function measureSoup(positions: readonly number[]) {
  let volume = 0;
  const moment = [0, 0, 0];
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(index, index + 9);
    const signed = (
      ax * (by * cz - bz * cy)
      - ay * (bx * cz - bz * cx)
      + az * (bx * cy - by * cx)
    ) / 6;
    volume += signed;
    moment[0] += signed * (ax + bx + cx) / 4;
    moment[1] += signed * (ay + by + cy) / 4;
    moment[2] += signed * (az + bz + cz) / 4;
  }
  return { volume, centroid: moment.map((value) => value / volume) as [number, number, number] };
}

async function storedShapes(projectId: string) {
  const document = await readProjectDocument(projectsRoot, projectId);
  if (!document) throw new Error("project missing");
  return document;
}

describe("POST /imports", () => {
  it("adds the model an STL describes, sized and seated as the editor would", async () => {
    const projectId = await makeProject();
    const bytes = plateStl(80, 60, 20);

    const response = await jsonImport(projectId, { fileName: "plate.stl", data: base64(bytes) });
    const payload = await response.json() as {
      shape: { id: string; kind: string; name: string; width: number; depth: number; height: number; x: number; z: number; elevation: number };
      triangles: number;
      revision: number;
    };

    expect(response.status).toBe(201);
    // A Z-up file's own Z is SketchForge's height, so an 80 x 60 x 20 plate is
    // 80 wide, 60 deep and 20 high. Any other permutation is a mapping bug.
    expect(payload.shape).toMatchObject({ kind: "mesh", name: "plate", width: 80, depth: 60, height: 20 });
    expect(payload.shape.x).toBe(0);
    expect(payload.shape.z).toBe(0);
    expect(payload.triangles).toBe(12);
    expect(payload.revision).toBeGreaterThan(0);
  });

  it("stores the triangles where the shape says they are", async () => {
    const projectId = await makeProject();

    await jsonImport(projectId, { fileName: "plate.stl", data: base64(plateStl(80, 60, 20)) });
    const [shape] = (await storedShapes(projectId)).shapes;
    const measured = measureSoup(shape.importedMesh!.positions);

    // 80 x 60 x 20. Measured rather than read off the reported size, because
    // the reported size comes from the same bounding box the import computed
    // and would agree with itself even if the geometry were somewhere else.
    expect(Math.abs(measured.volume)).toBeCloseTo(96_000, 3);
    // Centred on the workplane in X and Z, and seated on it in Y, so the
    // centre of mass of a uniform plate is half its height up and nowhere else.
    expect(measured.centroid[0]).toBeCloseTo(0, 4);
    expect(measured.centroid[1]).toBeCloseTo(10, 4);
    expect(measured.centroid[2]).toBeCloseTo(0, 4);
  });

  it("keeps the source file on the project, and points the shape at it", async () => {
    const projectId = await makeProject();
    const bytes = plateStl(80, 60, 20);

    await jsonImport(projectId, { fileName: "plate.stl", data: base64(bytes) });
    const document = await storedShapes(projectId);

    // Write the shape without the asset and the next save strips the import
    // back out of the project, so this is the half of an import that is easy
    // to leave out and impossible to notice until something reloads.
    expect(document.assets).toHaveLength(1);
    expect(document.assets[0]).toMatchObject({
      name: "plate.stl",
      sourceFormat: "stl",
      byteLength: bytes.byteLength,
      mediaType: "model/stl",
    });
    expect(document.shapes[0].importedMesh?.assetId).toBe(document.assets[0].id);
  });

  it("reads the same model out of a multipart upload", async () => {
    const projectId = await makeProject();
    const body = new FormData();
    body.set("file", new File([plateStl(80, 60, 20)], "plate.stl", { type: "model/stl" }));

    const response = await importMesh(new Request(`http://localhost/api/v1/imports?projectId=${projectId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body,
    }));
    const payload = await response.json() as { shape: { width: number; depth: number; height: number } };

    expect(response.status).toBe(201);
    expect(payload.shape).toMatchObject({ width: 80, depth: 60, height: 20 });
  });

  it("rejects a declared 70 MB import body before attempting to parse or import it", async () => {
    const projectId = await makeProject();
    const validImport = JSON.stringify({ fileName: "plate.stl", data: base64(plateStl(80, 60, 20)) });
    const response = await importMesh(new Request(`http://localhost/api/v1/imports?projectId=${projectId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": String(70 * 1024 * 1024),
      },
      body: validImport,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect((await storedShapes(projectId)).shapes).toHaveLength(0);
  });

  it("reads an OBJ, whose faces may have more than three corners", async () => {
    const projectId = await makeProject();
    const obj = [
      "v 0 0 0", "v 30 0 0", "v 30 12 0", "v 0 12 0",
      "f 1 2 3 4",
    ].join("\n");

    const response = await jsonImport(projectId, { fileName: "panel.obj", data: base64(new TextEncoder().encode(obj)) });
    const payload = await response.json() as { shape: { name: string; width: number }; triangles: number };

    expect(response.status).toBe(201);
    expect(payload.shape.name).toBe("panel");
    expect(payload.shape.width).toBe(30);
    // A quad is two triangles, which is the one thing an OBJ reader can get
    // wrong while still producing a plausible shape.
    expect(payload.triangles).toBe(2);
  });

  it("refuses a format nothing here can read, naming the ones it can", async () => {
    const projectId = await makeProject();

    const response = await jsonImport(projectId, { fileName: "bracket.3mf", data: base64(plateStl(10, 10, 10)) });
    const payload = await response.json() as { error: string; code: string };

    expect(response.status).toBe(415);
    expect(payload.code).toBe("unsupported_format");
    expect(payload.error).toContain("stl, obj, svg");
    // Refused before the project was touched, which is the point of checking
    // the name rather than attempting the parse.
    expect((await storedShapes(projectId)).shapes).toHaveLength(0);
  });

  it("refuses a file it can name but cannot parse, and leaves the project alone", async () => {
    const projectId = await makeProject();

    const response = await jsonImport(projectId, {
      fileName: "truncated.stl",
      data: base64(new TextEncoder().encode("solid nothing\nendsolid nothing")),
    });
    const payload = await response.json() as { error: string; code: string };

    expect(response.status).toBe(422);
    expect(payload.code).toBe("geometry_failed");
    expect(payload.error).toContain("truncated.stl");
    expect((await storedShapes(projectId)).shapes).toHaveLength(0);
  });

  it("refuses a body with no file name and one with no bytes", async () => {
    const projectId = await makeProject();

    const noName = await jsonImport(projectId, { data: base64(plateStl(10, 10, 10)) });
    const noData = await jsonImport(projectId, { fileName: "plate.stl" });
    const emptyData = await jsonImport(projectId, { fileName: "plate.stl", data: "" });
    for (const response of [noName, noData, emptyData]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_body" });
    }
  });

  it("returns contract-shaped authentication and project-id errors", async () => {
    const unauthorized = await importMesh(new Request("http://localhost/api/v1/imports?projectId=project-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "plate.stl", data: base64(plateStl(10, 10, 10)) }),
    }));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ code: "unauthorized" });

    const invalidProjectId = await importMesh(new Request("http://localhost/api/v1/imports?projectId=../unsafe", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "plate.stl", data: base64(plateStl(10, 10, 10)) }),
    }));
    expect(invalidProjectId.status).toBe(400);
    expect(await invalidProjectId.json()).toMatchObject({ code: "invalid_project_id" });
  });

  it("reads bytes that are a window onto a larger buffer", async () => {
    // Node hands small `Buffer`s out of a shared 8KB pool, so a decoded upload
    // can easily be a view with a non-zero offset into something much bigger.
    // An importer reading `bytes.buffer` rather than the view would then parse
    // the pool -- which is why this goes at the engine operation directly: the
    // route happens to copy, so it cannot show the difference.
    const plate = plateStl(80, 60, 20);
    const padded = new Uint8Array(plate.byteLength + 64);
    padded.set(plate, 32);
    const view = padded.subarray(32, 32 + plate.byteLength);

    const imported = await importedMeshFromFile("plate.stl", view);

    expect(view.byteOffset).toBe(32);
    expect(imported.shape).toMatchObject({ width: 80, depth: 60, height: 20 });
    expect(imported.shape.importedMesh?.triangleCount).toBe(12);
  });

  it("refuses a project that is not there", async () => {
    const response = await jsonImport("project-missing", { fileName: "plate.stl", data: base64(plateStl(10, 10, 10)) });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "project_not_found" });
  });
});
