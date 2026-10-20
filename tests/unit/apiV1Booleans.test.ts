import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { POST as booleanCut } from "@/app/api/v1/booleans/route";
import { DELETE as ungroup, POST as group } from "@/app/api/v1/groups/route";
import { POST as separateParts } from "@/app/api/v1/parts/route";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { readProjectDocument } from "@/lib/serverProjectDocument";
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

async function makeProject(name = "Bracket") {
  const response = await createProject(authorized("/api/v1/projects", { method: "POST", body: JSON.stringify({ name }) }));
  const payload = await response.json() as { project: { id: string } };
  return payload.project.id;
}

async function addShapes(projectId: string, shapes: Record<string, unknown>[]) {
  const response = await createShapes(
    authorized(`/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ shapes }) }),
  );
  const payload = await response.json() as { shapes?: Array<{ id: string }>; error?: string };
  if (!payload.shapes) throw new Error(`shape creation failed: ${payload.error}`);
  return payload.shapes.map((shape) => shape.id);
}

function cut(projectId: string, body: Record<string, unknown>) {
  return booleanCut(authorized(`/api/v1/booleans?projectId=${projectId}`, { method: "POST", body: JSON.stringify(body) }));
}

/**
 * The volume a closed triangle mesh encloses.
 *
 * A cut is only right if the material it removed is the material it was asked
 * to remove, and counting triangles cannot tell a hole in the right place from
 * one 10mm to the left. The divergence theorem over the stored triangles gives
 * a number that moves the moment any operand lands in the wrong place, is the
 * wrong size, or is not subtracted at all.
 */
function meshVolume(positions: number[]) {
  let total = 0;
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(index, index + 9);
    total += (
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx)
    ) / 6;
  }
  return Math.abs(total);
}

/**
 * That a cut removed the volume it was asked to remove.
 *
 * The stored mesh approximates a round bore with flats drawn inside the true
 * circle, so the material left always measures a shade more than the exact
 * answer -- a tenth of a percent here, against the three percent that failing
 * to cut at all would leave.
 */
function expectVolume(actual: number, expected: number) {
  expect(actual).toBeGreaterThan(expected);
  expect(actual).toBeLessThan(expected * 1.002);
}

async function storedShapes(projectId: string) {
  const document = await readProjectDocument(projectsRoot, projectId);
  if (!document) throw new Error("project missing");
  return document.shapes;
}

function environmentHooks(prefix: string) {
  beforeEach(async () => {
    previousRoot = process.env[SERVER_PROJECTS_ENV];
    previousToken = process.env[API_TOKEN_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
}

describe("REST API v1 grouping", () => {
  environmentHooks("sketchforge-api-groups-");

  async function twoBoxes() {
    const projectId = await makeProject("Grouped");
    const [left, right] = await addShapes(projectId, [
      { kind: "box", width: 10, depth: 10, height: 10, x: -20, elevation: 4, name: "Left" },
      { kind: "box", width: 10, depth: 10, height: 10, x: 20, elevation: 4, name: "Right" },
    ]);
    return { projectId, left, right };
  }

  it("groups two solids into one shape spanning both", async () => {
    const { projectId, left, right } = await twoBoxes();

    const response = await group(authorized(`/api/v1/groups?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ ids: [left, right] }),
    }));
    const payload = await response.json() as { shape: { id: string; width: number; depth: number; height: number; x: number; groupedCount: number } };

    expect(response.status).toBe(201);
    expect(payload.shape.groupedCount).toBe(2);
    expect(payload.shape.width).toBeCloseTo(50, 3);
    expect(payload.shape.depth).toBeCloseTo(10, 3);
    expect(payload.shape.height).toBeCloseTo(10, 3);
    expect(payload.shape.x).toBeCloseTo(0, 3);
    expect(await storedShapes(projectId)).toHaveLength(1);
  });

  it("keeps a pure group as a record rather than baking it into a mesh", async () => {
    const { projectId, left, right } = await twoBoxes();

    await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [left, right] }) }));
    const [stored] = await storedShapes(projectId);

    expect(stored.importedMesh).toBeUndefined();
    expect(stored.groupedShapes?.map((child) => child.name)).toEqual(["Left", "Right"]);
  });

  it("ungroups back to the two shapes it was made from", async () => {
    const { projectId, left, right } = await twoBoxes();
    const created = await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [left, right] }) }));
    const groupId = (await created.json() as { shape: { id: string } }).shape.id;

    const response = await ungroup(authorized(`/api/v1/groups?projectId=${projectId}&shapeId=${groupId}`, { method: "DELETE" }));
    const payload = await response.json() as { shapes: Array<{ name: string; x: number; elevation: number; width: number; height: number }> };

    expect(response.status).toBe(200);
    expect(payload.shapes.map((shape) => shape.name)).toEqual(["Left", "Right"]);
    expect(payload.shapes.map((shape) => shape.x)).toEqual([-20, 20]);
    expect(payload.shapes.map((shape) => shape.elevation)).toEqual([4, 4]);
    expect(payload.shapes.every((shape) => shape.width === 10 && shape.height === 10)).toBe(true);
  });

  it("pushes a resize of the group down into its children when ungrouping", async () => {
    const { projectId, left, right } = await twoBoxes();
    const created = await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [left, right] }) }));
    const groupId = (await created.json() as { shape: { id: string } }).shape.id;
    await patchShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ width: 100, height: 20 }),
    }));

    const response = await ungroup(authorized(`/api/v1/groups?projectId=${projectId}&shapeId=${groupId}`, { method: "DELETE" }));
    const payload = await response.json() as { shapes: Array<{ x: number; elevation: number; width: number; height: number }> };

    expect(payload.shapes.map((shape) => shape.width)).toEqual([20, 20]);
    expect(payload.shapes.map((shape) => shape.height)).toEqual([20, 20]);
    expect(payload.shapes.map((shape) => shape.x)).toEqual([-40, 40]);
    expect(payload.shapes.map((shape) => shape.elevation)).toEqual([4, 4]);
  });

  it("refuses to group one shape, an unknown shape, and a locked one", async () => {
    const { projectId, left, right } = await twoBoxes();
    await patchShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${right}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }));

    const attempts: Array<[Record<string, unknown>, number]> = [
      [{ ids: [left] }, 400],
      [{ ids: [left, "not-a-shape"] }, 404],
      [{ ids: [left, right] }, 409],
      [{}, 400],
    ];
    for (const [body, status] of attempts) {
      const response = await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(status);
    }
  });

  it("refuses to ungroup a shape that is not a group", async () => {
    const { projectId, left } = await twoBoxes();

    const response = await ungroup(authorized(`/api/v1/groups?projectId=${projectId}&shapeId=${left}`, { method: "DELETE" }));

    expect(response.status).toBe(422);
  });
});

// These go through the CAD kernel; see the note in serverCadSolids.test.ts.
describe("REST API v1 boolean cut", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  environmentHooks("sketchforge-api-booleans-");

  const PLATE_VOLUME = 40 * 40 * 10;

  async function platedProject(hole: Record<string, unknown>) {
    const projectId = await makeProject("Hole plate");
    const [plate, bore] = await addShapes(projectId, [
      { kind: "box", width: 40, depth: 40, height: 10, name: "Plate" },
      { kind: "cylinder", width: 8, depth: 8, height: 30, elevation: -10, sides: 96, name: "Bore", ...hole },
    ]);
    return { projectId, plate, bore };
  }

  it("subtracts a through hole and leaves the plate's own size alone", async () => {
    const { projectId, plate, bore } = await platedProject({});

    const response = await cut(projectId, { solidIds: [plate], holeIds: [bore] });
    const payload = await response.json() as { shape: { kind: string; width: number; height: number; groupedCount: number }; triangles: number };

    expect(response.status).toBe(201);
    expect(payload.shape.kind).toBe("mesh");
    expect(payload.shape.width).toBeCloseTo(40, 2);
    expect(payload.shape.height).toBeCloseTo(10, 2);
    expect(payload.shape.groupedCount).toBe(2);

    const [stored] = await storedShapes(projectId);
    expectVolume(meshVolume(stored.importedMesh!.positions), PLATE_VOLUME - Math.PI * 16 * 10);
  });

  it("cuts the hole where the hole is, not where the plate is", async () => {
    const { projectId, plate, bore } = await platedProject({ x: 12, z: -8 });

    await cut(projectId, { solidIds: [plate], holeIds: [bore] });
    const [stored] = await storedShapes(projectId);

    expectVolume(meshVolume(stored.importedMesh!.positions), PLATE_VOLUME - Math.PI * 16 * 10);
    // Half the bore hangs off the plate's edge, so only half of it can be
    // removed -- which it cannot be if the cutter was placed by the plate.
    const { projectId: edgeProject, plate: edgePlate, bore: edgeBore } = await platedProject({ x: 20 });
    await cut(edgeProject, { solidIds: [edgePlate], holeIds: [edgeBore] });
    const [edgeStored] = await storedShapes(edgeProject);
    expectVolume(meshVolume(edgeStored.importedMesh!.positions), PLATE_VOLUME - Math.PI * 16 * 10 / 2);
  });

  it("cuts a pocket to the depth the cutter reaches, not through", async () => {
    const { projectId, plate, bore } = await platedProject({ elevation: 6, height: 10 });

    await cut(projectId, { solidIds: [plate], holeIds: [bore] });
    const [stored] = await storedShapes(projectId);

    expectVolume(meshVolume(stored.importedMesh!.positions), PLATE_VOLUME - Math.PI * 16 * 4);
  });

  it("stores exact geometry for the result, so a later treatment is not working from triangles", async () => {
    const { projectId, plate, bore } = await platedProject({});

    await cut(projectId, { solidIds: [plate], holeIds: [bore] });
    const [stored] = await storedShapes(projectId);

    expect(stored.cadBrep).toContain("CASCADE Topology");
    expect(stored.cadBrepFrame).toMatchObject({ x: 0, z: 0, elevation: 0 });
  });

  it("subtracts a shape the caller never marked as a hole", async () => {
    const { projectId, plate, bore } = await platedProject({});
    const before = await storedShapes(projectId);
    expect(before.every((shape) => !shape.hole)).toBe(true);

    await cut(projectId, { solidIds: [plate], holeIds: [bore] });
    const [stored] = await storedShapes(projectId);

    expect(meshVolume(stored.importedMesh!.positions)).toBeLessThan(PLATE_VOLUME - 400);
  });

  it("refuses a cut that would leave nothing behind, and leaves the project as it was", async () => {
    const projectId = await makeProject("Consumed");
    const [plate, bore] = await addShapes(projectId, [
      { kind: "box", width: 10, depth: 10, height: 10, name: "Plate" },
      { kind: "box", width: 40, depth: 40, height: 40, elevation: -15, name: "Bore" },
    ]);

    const response = await cut(projectId, { solidIds: [plate], holeIds: [bore] });

    expect(response.status).toBe(422);
    expect(await storedShapes(projectId)).toHaveLength(2);
  });

  it("refuses a request with no solid, no hole, a shape in both roles, or an unknown id", async () => {
    const { projectId, plate, bore } = await platedProject({});

    const attempts: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ holeIds: [bore] }, 400, /solidIds/],
      [{ solidIds: [plate] }, 400, /holeIds/],
      [{ solidIds: [plate], holeIds: [plate] }, 400, /both a solid and a hole/],
      [{ solidIds: [plate], holeIds: ["not-a-shape"] }, 404, /not-a-shape/],
    ];
    for (const [body, status, message] of attempts) {
      const response = await cut(projectId, body);
      expect(response.status).toBe(status);
      expect((await response.json() as { error: string }).error).toMatch(message);
    }
  });

  it("refuses to cut a locked operand", async () => {
    const { projectId, plate, bore } = await platedProject({});
    await patchShape(authorized(`/api/v1/shapes?projectId=${projectId}&shapeId=${plate}`, { method: "PATCH", body: JSON.stringify({ locked: true }) }));

    const response = await cut(projectId, { solidIds: [plate], holeIds: [bore] });

    expect(response.status).toBe(409);
  });

  it("grouping a solid with a hole cuts it, the way the editor's Group button does", async () => {
    const projectId = await makeProject("Grouped cut");
    const [plate, bore] = await addShapes(projectId, [
      { kind: "box", width: 40, depth: 40, height: 10, name: "Plate" },
      { kind: "cylinder", width: 8, depth: 8, height: 30, elevation: -10, sides: 96, hole: true, name: "Bore" },
    ]);

    const response = await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [plate, bore] }) }));
    const [stored] = await storedShapes(projectId);

    expect(response.status).toBe(201);
    expectVolume(meshVolume(stored.importedMesh!.positions), PLATE_VOLUME - Math.PI * 16 * 10);
  });

  it("separates a bar a cut has split in two", async () => {
    const projectId = await makeProject("Severed bar");
    const [bar, saw] = await addShapes(projectId, [
      { kind: "box", width: 40, depth: 10, height: 10, name: "Bar" },
      { kind: "box", width: 6, depth: 20, height: 20, elevation: -5, name: "Saw" },
    ]);
    const cutResponse = await cut(projectId, { solidIds: [bar], holeIds: [saw] });
    const groupId = (await cutResponse.json() as { shape: { id: string } }).shape.id;

    const response = await separateParts(authorized(`/api/v1/parts?projectId=${projectId}&shapeId=${groupId}`, { method: "POST" }));
    const payload = await response.json() as { shapes: Array<{ name: string; x: number; width: number }> };

    expect(response.status).toBe(200);
    expect(payload.shapes).toHaveLength(2);
    expect(payload.shapes.map((shape) => shape.name)).toEqual(["Group Part 1", "Group Part 2"]);
    expect(payload.shapes.map((shape) => shape.width)).toEqual([17, 17]);
    expect(payload.shapes.map((shape) => shape.x).sort((a, b) => a - b)).toEqual([-11.5, 11.5]);
    expect(await storedShapes(projectId)).toHaveLength(2);
  });

  it("separates a pure group back into its children", async () => {
    const projectId = await makeProject("Separable group");
    const [left, right] = await addShapes(projectId, [
      { kind: "box", width: 10, depth: 10, height: 10, x: -20, name: "Left" },
      { kind: "box", width: 10, depth: 10, height: 10, x: 20, name: "Right" },
    ]);
    const created = await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [left, right] }) }));
    const groupId = (await created.json() as { shape: { id: string } }).shape.id;

    const response = await separateParts(authorized(`/api/v1/parts?projectId=${projectId}&shapeId=${groupId}`, { method: "POST" }));
    const payload = await response.json() as { shapes: Array<{ name: string }> };

    expect(response.status).toBe(200);
    expect(payload.shapes.map((shape) => shape.name)).toEqual(["Left", "Right"]);
  });

  it("cuts into a group by cutting the shapes the group holds", async () => {
    const projectId = await makeProject("Cut group");
    const [left, right, bore] = await addShapes(projectId, [
      { kind: "box", width: 20, depth: 20, height: 10, x: -15, name: "Left" },
      { kind: "box", width: 20, depth: 20, height: 10, x: 15, name: "Right" },
      { kind: "cylinder", width: 8, depth: 8, height: 30, x: -15, elevation: -10, sides: 96, name: "Bore" },
    ]);
    const grouped = await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [left, right] }) }));
    const groupId = (await grouped.json() as { shape: { id: string } }).shape.id;

    const response = await cut(projectId, { solidIds: [groupId], holeIds: [bore] });
    const payload = await response.json() as { shape: { groupedCount: number } };
    const [stored] = await storedShapes(projectId);

    expect(response.status).toBe(201);
    // The group was taken apart, so the result holds both boxes and the bore
    // rather than the group and the bore.
    expect(payload.shape.groupedCount).toBe(3);
    expectVolume(meshVolume(stored.importedMesh!.positions), 2 * 20 * 20 * 10 - Math.PI * 16 * 10);
  });

  it("refuses to separate a group of holes, which has no body to split", async () => {
    const projectId = await makeProject("Hole group");
    const [left, right] = await addShapes(projectId, [
      { kind: "box", width: 10, depth: 10, height: 10, x: -20, hole: true, name: "Left" },
      { kind: "box", width: 10, depth: 10, height: 10, x: 20, hole: true, name: "Right" },
    ]);
    const grouped = await group(authorized(`/api/v1/groups?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ ids: [left, right] }) }));
    const groupId = (await grouped.json() as { shape: { id: string } }).shape.id;

    const response = await separateParts(authorized(`/api/v1/parts?projectId=${projectId}&shapeId=${groupId}`, { method: "POST" }));
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(422);
    expect(payload.error).toContain("cutter");
  });

  it("says a single body is a single body rather than splitting it into nothing", async () => {
    const projectId = await makeProject("One body");
    const [box] = await addShapes(projectId, [{ kind: "box", width: 10, depth: 10, height: 10, name: "Box" }]);

    const response = await separateParts(authorized(`/api/v1/parts?projectId=${projectId}&shapeId=${box}`, { method: "POST" }));

    expect(response.status).toBe(422);
    expect(await storedShapes(projectId)).toHaveLength(1);
  });
});

describe("a cut that does not cut", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  environmentHooks("sketchforge-api-noop-cut-");
  it("refuses a hole that misses the solid instead of answering with the solid unchanged", async () => {
    // `cutAll` hands back the solid untouched when nothing met it, and says
    // nothing about having done so. Answering 200 with an unchanged "Group" is
    // the one reply a script cannot tell from success.
    const project = await makeProject("Missing hole");
    const [plate] = await addShapes(project, [
      { kind: "box", width: 40, depth: 40, height: 10, x: 0, z: 0 },
    ]);
    const [stray] = await addShapes(project, [
      { kind: "cylinder", width: 6, depth: 6, height: 30, x: 500, z: 500, hole: true },
    ]);

    const response = await cut(project, { solidIds: [plate], holeIds: [stray] });

    expect(response.status).toBe(422);
    const payload = await response.json() as { error: string; code?: string };
    expect(payload.error).toMatch(/nothing to cut|do not meet|meet the solid/i);

    // And the project is left as it was, rather than carrying a group that is
    // really just the plate.
    const stored = await storedShapes(project);
    expect(stored).toHaveLength(2);
  }, CAD_TEST_TIMEOUT_MS);

  it("still cuts when the hole does meet the solid", async () => {
    const project = await makeProject("Real hole");
    const [plate] = await addShapes(project, [
      { kind: "box", width: 40, depth: 40, height: 10, x: 0, z: 0 },
    ]);
    const [bore] = await addShapes(project, [
      { kind: "cylinder", width: 10, depth: 10, height: 30, x: 0, z: 0, hole: true },
    ]);

    const response = await cut(project, { solidIds: [plate], holeIds: [bore] });

    expect(response.status).toBe(201);
  }, CAD_TEST_TIMEOUT_MS);
});
