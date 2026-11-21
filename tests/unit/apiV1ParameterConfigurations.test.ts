import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { GET as getShapes, PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import { GET as listParameters, POST as createParameter } from "@/app/api/v1/parameters/route";
import {
  DELETE as deleteConfiguration,
  GET as listConfigurations,
  PATCH as patchConfiguration,
  POST as createConfiguration,
} from "@/app/api/v1/parameter-configurations/route";
import { POST as activateConfiguration } from "@/app/api/v1/parameter-configurations/activate/route";
import { GET as getProperties } from "@/app/api/v1/properties/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { directoryProjectStore } from "@/lib/engine/projectStore";
import { createEngine } from "@constructorfleet/sketchforge-engine";
import type { SketchConstraint, SketchProfile } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const TOKEN = "test-token-value";

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

type Json = Record<string, unknown>;
type Summary = Json & { id: string };

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${url}`, { ...init, headers });
}

async function call(handler: (request: Request) => Promise<Response>, url: string, init: RequestInit = {}) {
  const response = await handler(authorized(url, init));
  return { status: response.status, etag: response.headers.get("etag"), body: await response.json() as Json };
}

async function makeProject() {
  const created = await call(createProject, "/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Configurations" }) });
  return (created.body.project as { id: string }).id;
}

const base = "/api/v1/parameter-configurations";
const parameter = (projectId: string, body: Json) =>
  call(createParameter, `/api/v1/parameters?projectId=${projectId}`, { method: "POST", body: JSON.stringify(body) });
const create = (projectId: string, body: Json, headers: HeadersInit = {}) =>
  call(createConfiguration, `${base}?projectId=${projectId}`, { method: "POST", body: JSON.stringify(body), headers });
const patch = (projectId: string, name: string, body: Json, headers: HeadersInit = {}) =>
  call(patchConfiguration, `${base}?projectId=${projectId}&name=${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(body), headers });
const remove = (projectId: string, name: string, headers: HeadersInit = {}) =>
  call(deleteConfiguration, `${base}?projectId=${projectId}&name=${encodeURIComponent(name)}`, { method: "DELETE", headers });
const activate = (projectId: string, body: Json, headers: HeadersInit = {}) =>
  call(activateConfiguration, `${base}/activate?projectId=${projectId}`, { method: "POST", body: JSON.stringify(body), headers });
const list = (projectId: string) => call(listConfigurations, `${base}?projectId=${projectId}`);

async function addShape(projectId: string, shape: Json) {
  const created = await call(createShapes, `/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify(shape) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body.shapes as Summary[])[0]!;
}

async function readShape(projectId: string, shapeId: string) {
  const listed = await call(getShapes, `/api/v1/shapes?projectId=${projectId}`);
  return (listed.body.shapes as Summary[]).find((shape) => shape.id === shapeId)!;
}

async function volumeAndCentre(projectId: string, shapeId: string) {
  const read = await call(getProperties, `/api/v1/properties?projectId=${projectId}&shapeId=${shapeId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const properties = read.body.properties as { volume: number; centerOfMass: { x: number; y: number; z: number } };
  return { volume: properties.volume, centre: properties.centerOfMass };
}

/** A box 10 x 10 in depth and height whose width is wall * 5 and whose x is wall * 10. */
async function boundProject() {
  const projectId = await makeProject();
  expect((await parameter(projectId, { name: "wall", expression: "2", dimension: "length" })).status).toBe(201);
  const box = await addShape(projectId, { kind: "box", depth: 10, height: 10, expressions: { width: "wall * 5", x: "wall * 10" } });
  return { projectId, box };
}

async function expectGeometry(projectId: string, shapeId: string, volume: number, x: number) {
  const measured = await volumeAndCentre(projectId, shapeId);
  expect(measured.volume).toBeCloseTo(volume, 3);
  expect(measured.centre.x).toBeCloseTo(x, 6);
  expect(measured.centre.y).toBeCloseTo(5, 6);
  expect(measured.centre.z).toBeCloseTo(0, 6);
}

beforeEach(async () => {
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-configurations-"));
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

describe("/api/v1/parameter-configurations", () => {
  it("registers the five operations, with every write conditional", () => {
    const operations = API_V1_OPERATIONS.filter((operation) => operation.path.startsWith(base));
    expect(operations.map(({ method, path: route, operationId, ifMatch }) => ({ method, route, operationId, ifMatch }))).toEqual([
      { method: "GET", route: base, operationId: "listParameterConfigurations", ifMatch: undefined },
      { method: "POST", route: base, operationId: "createParameterConfiguration", ifMatch: true },
      { method: "PATCH", route: base, operationId: "updateParameterConfiguration", ifMatch: true },
      { method: "DELETE", route: base, operationId: "deleteParameterConfiguration", ifMatch: true },
      { method: "POST", route: `${base}/activate`, operationId: "activateParameterConfiguration", ifMatch: true },
    ]);
  });

  it("creates a configuration without touching geometry, and activating it rebuilds the bound box", async () => {
    const { projectId, box } = await boundProject();
    expect((await list(projectId)).body).toMatchObject({ configurations: [], activeConfiguration: null, issues: [] });

    const created = await create(projectId, { name: "Large", overrides: { wall: "4" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.etag).toBe(`"${created.body.revision}"`);
    expect(created.body).toMatchObject({
      configuration: { name: "Large", overrides: { wall: "4" } },
      configurations: [{ name: "Large", overrides: { wall: "4" } }],
      activeConfiguration: null,
      parameters: [{ name: "wall", expression: "2", value: 2 }],
      issues: [],
      shapes: [],
    });
    await expectGeometry(projectId, box.id, 1000, 20);

    const activated = await activate(projectId, { name: "Large" });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.etag).toBe(`"${activated.body.revision}"`);
    expect(activated.body).toMatchObject({
      activeConfiguration: "Large",
      parameters: [{ name: "wall", expression: "2", dimension: "length", value: 4 }],
    });
    expect(activated.body.shapes).toEqual([expect.objectContaining({ id: box.id, width: 20, x: 40 })]);
    expect(await readShape(projectId, box.id)).toMatchObject({ width: 20, x: 40 });
    await expectGeometry(projectId, box.id, 2000, 40);

    const parameters = await call(listParameters, `/api/v1/parameters?projectId=${projectId}`);
    expect(parameters.status, JSON.stringify(parameters.body)).toBe(200);
    expect(parameters.body).toMatchObject({ activeConfiguration: "Large", parameters: [{ name: "wall", expression: "2", value: 4 }] });

    const listed = await list(projectId);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      configurations: [{ name: "Large", overrides: { wall: "4" } }],
      activeConfiguration: "Large",
      parameters: [{ name: "wall", expression: "2", dimension: "length", value: 4 }],
      issues: [],
      revision: activated.body.revision,
    });

    const baseTable = await activate(projectId, { name: null });
    expect(baseTable.status, JSON.stringify(baseTable.body)).toBe(200);
    expect(baseTable.body).toMatchObject({ activeConfiguration: null, parameters: [{ name: "wall", value: 2 }] });
    expect(baseTable.body.shapes).toEqual([expect.objectContaining({ id: box.id, width: 10, x: 20 })]);
    await expectGeometry(projectId, box.id, 1000, 20);
    expect((await call(listParameters, `/api/v1/parameters?projectId=${projectId}`)).body.activeConfiguration).toBeNull();
  });

  it("sets and clears overrides, renames, and deletes, rebuilding only when the active table changes", async () => {
    const { projectId, box } = await boundProject();
    await create(projectId, { name: "Large", overrides: { wall: "4" } });
    await activate(projectId, { name: "Large" });

    const set = await patch(projectId, "Large", { parameter: "wall", expression: "3" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ configuration: { name: "Large", overrides: { wall: "3" } }, parameters: [{ value: 3 }] });
    expect(set.body.shapes).toEqual([expect.objectContaining({ id: box.id, width: 15, x: 30 })]);
    await expectGeometry(projectId, box.id, 1500, 30);

    const cleared = await patch(projectId, "Large", { parameter: "wall", expression: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body).toMatchObject({ configuration: { name: "Large", overrides: {} }, parameters: [{ value: 2 }] });
    expect(cleared.body.shapes).toEqual([expect.objectContaining({ id: box.id, width: 10 })]);
    await expectGeometry(projectId, box.id, 1000, 20);

    const unchanged = await patch(projectId, "Large", { parameter: "wall", expression: null });
    expect(unchanged).toMatchObject({ status: 200, body: { shapes: [], revision: cleared.body.revision } });

    await patch(projectId, "Large", { parameter: "wall", expression: "4" });
    const renamed = await patch(projectId, "Large", { name: "Big" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ configuration: { name: "Big", overrides: { wall: "4" } }, activeConfiguration: "Big", shapes: [] });

    await create(projectId, { name: "Small" });
    const inactive = await patch(projectId, "Small", { parameter: "wall", expression: "1" });
    expect(inactive).toMatchObject({ status: 200, body: { configuration: { name: "Small", overrides: { wall: "1" } }, activeConfiguration: "Big", shapes: [] } });
    await expectGeometry(projectId, box.id, 2000, 40);

    const deleted = await remove(projectId, "Big");
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toMatchObject({
      deleted: true,
      name: "Big",
      configurations: [{ name: "Small" }],
      activeConfiguration: null,
      parameters: [{ value: 2 }],
    });
    expect(deleted.body.configuration).toBeUndefined();
    expect(deleted.body.shapes).toEqual([expect.objectContaining({ id: box.id, width: 10, x: 20 })]);
    await expectGeometry(projectId, box.id, 1000, 20);
  });

  it("refuses names, unknown targets and expressions with the normalized error shape, writing nothing", async () => {
    const { projectId } = await boundProject();
    await create(projectId, { name: "Large", overrides: { wall: "4" } });
    const before = await list(projectId);

    expect(await create(projectId, { name: "Large" })).toMatchObject({ status: 409, body: { code: "configuration_exists", configuration: "Large", reason: "duplicateConfigurationName" } });
    expect(await create(projectId, { name: " padded" })).toMatchObject({ status: 400, body: { code: "invalid_request", reason: "invalidConfigurationName" } });
    expect(await patch(projectId, "Large", { name: "" })).toMatchObject({ status: 400, body: { code: "invalid_request" } });

    for (const refused of [
      await patch(projectId, "Missing", { name: "Other" }),
      await patch(projectId, "Missing", { parameter: "wall", expression: "1" }),
      await remove(projectId, "Missing"),
      await activate(projectId, { name: "Missing" }),
    ]) {
      expect(refused).toMatchObject({ status: 404, body: { code: "configuration_not_found", configuration: "Missing", reason: "unknownConfiguration" } });
    }

    expect(await create(projectId, { name: "Ghost", overrides: { gone: "1" } })).toMatchObject({ status: 404, body: { code: "parameter_not_found", parameter: "gone", configuration: "Ghost" } });
    expect(await patch(projectId, "Large", { parameter: "gone", expression: "1" })).toMatchObject({ status: 404, body: { code: "parameter_not_found", parameter: "gone", configuration: "Large" } });

    const parse = await patch(projectId, "Large", { parameter: "wall", expression: "2 *" });
    expect(parse).toMatchObject({ status: 422, body: { code: "invalid_expression", parameter: "wall", configuration: "Large", expressionError: { code: "parseError", span: { start: expect.any(Number) } } } });
    const cycle = await patch(projectId, "Large", { parameter: "wall", expression: "wall + 1" });
    expect(cycle).toMatchObject({ status: 422, body: { code: "invalid_expression", configuration: "Large", expressionError: { code: "cycle" } } });
    const mismatch = await create(projectId, { name: "Angled", overrides: { wall: "30 deg" } });
    expect(mismatch).toMatchObject({ status: 422, body: { code: "invalid_expression", configuration: "Angled", expressionError: { code: "dimensionMismatch" } } });

    expect((await list(projectId)).body).toEqual(before.body);
  });

  it("refuses an activation that would push a bound field out of range or rebuild a locked shape", async () => {
    const { projectId, box } = await boundProject();
    await create(projectId, { name: "Huge", overrides: { wall: "5000" } });
    await create(projectId, { name: "Large", overrides: { wall: "4" } });
    const before = await list(projectId);

    const outOfRange = await activate(projectId, { name: "Huge" });
    expect(outOfRange).toMatchObject({ status: 422, body: { code: "invalid_expression", reason: "outOfRange", shapeId: box.id, field: "width", value: 25000, max: 10000 } });

    await call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=${box.id}`, { method: "PATCH", body: JSON.stringify({ locked: true }) });
    const locked = await activate(projectId, { name: "Large" });
    expect(locked).toMatchObject({ status: 409, body: { code: "shape_locked", shapeId: box.id, fields: expect.arrayContaining(["width", "x"]) } });

    const after = await list(projectId);
    expect(after.body.activeConfiguration).toBeNull();
    expect(after.body.configurations).toEqual(before.body.configurations);
    await expectGeometry(projectId, box.id, 1000, 20);
  });

  it("refuses an activation the bound sketch cannot solve, naming the shape and constraints", async () => {
    const projectId = await makeProject();
    await parameter(projectId, { name: "w", expression: "2", dimension: "length" });
    const box = await addShape(projectId, { kind: "box", width: 2, depth: 2, height: 3 });
    const store = directoryProjectStore(projectsRoot);
    const current = (await store.read(projectId))!;
    const profile: SketchProfile = {
      points: [{ id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 }, { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 }],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
        { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
      ],
      constraints: [
        { id: "fix-a", kind: "fixed", pointId: "a", xMm: -1, zMm: -1 },
        { id: "h-ab", kind: "horizontal", segmentId: "ab" },
        { id: "v-bc", kind: "vertical", segmentId: "bc" },
        { id: "h-cd", kind: "horizontal", segmentId: "cd" },
        { id: "v-da", kind: "vertical", segmentId: "da" },
        { id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 2 },
        { id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 },
        // Pins the rectangle, so a new width cannot be solved.
        { id: "diagonal", kind: "distance", pointIds: ["a", "c"], valueMm: Math.hypot(2, 2) },
      ] satisfies SketchConstraint[],
    };
    await store.write(projectId, current, [{
      ...current.shapes[0]!,
      sketchOperation: "extrude",
      sketchProfile: profile,
      sketchSourceId: "sketch/pinned",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    }]);
    const engine = createEngine(store);
    expect((await engine.bindSketchConstraint(projectId, box.id, "width", "w")).ok).toBe(true);
    await create(projectId, { name: "Wide", overrides: { w: "4" } });

    const refused = await activate(projectId, { name: "Wide" });

    expect(refused).toMatchObject({ status: 422, body: { code: "geometry_failed", shapeId: box.id, constraintIds: expect.arrayContaining(["diagonal"]) } });
    expect((await list(projectId)).body.activeConfiguration).toBeNull();
  }, CAD_TEST_TIMEOUT_MS);

  it("lists stale overrides as issues", async () => {
    const { projectId } = await boundProject();
    const store = directoryProjectStore(projectsRoot);
    const current = (await store.read(projectId))!;
    await store.write(projectId, { ...current, configurations: [{ name: "Old", overrides: { gone: "1", wall: "3" } }] }, current.shapes);

    const listed = await list(projectId);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.issues).toEqual([{ configuration: "Old", parameter: "gone", code: "unknownParameter", message: expect.any(String) }]);
  });

  it("refuses malformed requests", async () => {
    const { projectId } = await boundProject();
    await create(projectId, { name: "Large" });

    for (const body of [{}, { name: 3 }, { name: "A", overrides: { wall: 4 } }, { name: "A", overrides: ["wall"] }, { name: "A", extra: true }]) {
      expect(await create(projectId, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    }
    for (const body of [{}, { name: "B", parameter: "wall", expression: "1" }, { parameter: "wall" }, { parameter: "wall", expression: 1 }, { expression: "1" }]) {
      expect(await patch(projectId, "Large", body), JSON.stringify(body)).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    }
    for (const body of [{}, { name: 3 }, { name: "Large", extra: 1 }]) {
      expect(await activate(projectId, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    }
    expect((await call(patchConfiguration, `${base}?projectId=${projectId}`, { method: "PATCH", body: JSON.stringify({ name: "B" }) })).status).toBe(400);
    expect((await call(listConfigurations, base)).body).toMatchObject({ code: "invalid_project_id" });
    expect((await call(listConfigurations, `${base}?projectId=absent`)).status).toBe(404);
  });

  it("honours If-Match on every write and leaves a stale write unapplied", async () => {
    const { projectId } = await boundProject();
    const created = await create(projectId, { name: "Large", overrides: { wall: "4" } });
    const revision = created.body.revision as number;
    const stale = { "If-Match": `"${revision - 1}"` };

    expect(await create(projectId, { name: "Small" }, stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch", revision } });
    expect(await patch(projectId, "Large", { name: "Big" }, stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch", revision } });
    expect(await patch(projectId, "Large", { parameter: "wall", expression: "3" }, stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch" } });
    expect(await activate(projectId, { name: "Large" }, stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch" } });
    expect(await remove(projectId, "Large", stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch" } });
    expect((await list(projectId)).body).toEqual({ configurations: [{ name: "Large", overrides: { wall: "4" } }], activeConfiguration: null, parameters: [{ name: "wall", expression: "2", dimension: "length", value: 2 }], issues: [], revision });

    const current = await activate(projectId, { name: "Large" }, { "If-Match": `"${revision}"` });
    expect(current.status).toBe(200);
    expect(current.etag).toBe(`"${current.body.revision}"`);
  });
});
