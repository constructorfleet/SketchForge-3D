import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { GET as getShapes, PATCH as patchShape, POST as createShapes } from "@/app/api/v1/shapes/route";
import {
  DELETE as deleteParameter,
  GET as listParameters,
  PATCH as patchParameter,
  POST as createParameter,
} from "@/app/api/v1/parameters/route";
import { GET as getProperties } from "@/app/api/v1/properties/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

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
  const created = await call(createProject, "/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Parameters" }) });
  return (created.body.project as { id: string }).id;
}

const post = (projectId: string, body: Json, headers: HeadersInit = {}) =>
  call(createParameter, `/api/v1/parameters?projectId=${projectId}`, { method: "POST", body: JSON.stringify(body), headers });
const patch = (projectId: string, name: string, body: Json, headers: HeadersInit = {}) =>
  call(patchParameter, `/api/v1/parameters?projectId=${projectId}&name=${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(body), headers });
const remove = (projectId: string, name: string, headers: HeadersInit = {}) =>
  call(deleteParameter, `/api/v1/parameters?projectId=${projectId}&name=${encodeURIComponent(name)}`, { method: "DELETE", headers });
const list = (projectId: string) => call(listParameters, `/api/v1/parameters?projectId=${projectId}`);

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

beforeEach(async () => {
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-parameters-"));
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

describe("/api/v1/parameters", () => {
  it("registers the four operations as conditional writes and reads", () => {
    const operations = API_V1_OPERATIONS.filter((operation) => operation.path === "/api/v1/parameters");
    expect(operations.map(({ method, operationId, ifMatch }) => ({ method, operationId, ifMatch }))).toEqual([
      { method: "GET", operationId: "listParameters", ifMatch: undefined },
      { method: "POST", operationId: "createParameter", ifMatch: true },
      { method: "PATCH", operationId: "updateParameter", ifMatch: true },
      { method: "DELETE", operationId: "deleteParameter", ifMatch: true },
    ]);
  });

  it("creates, lists, changes, renames and deletes parameters", async () => {
    const projectId = await makeProject();
    expect((await list(projectId)).body).toMatchObject({ parameters: [], bindingIssues: [] });

    const created = await post(projectId, { name: "wall", expression: "2 mm", dimension: "length" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      parameter: { name: "wall", expression: "2 mm", dimension: "length", value: 2 },
      parameters: [{ name: "wall", value: 2 }],
      shapes: [],
    });
    expect(created.etag).toBe(`"${created.body.revision}"`);
    const lip = await post(projectId, { name: "lip", expression: "wall * 3", dimension: "length" });
    expect(lip.body.parameter).toMatchObject({ name: "lip", value: 6 });

    const changed = await patch(projectId, "wall", { expression: "0.5cm" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.parameters).toEqual([
      { name: "wall", expression: "0.5cm", dimension: "length", value: 5 },
      { name: "lip", expression: "wall * 3", dimension: "length", value: 15 },
    ]);

    const renamed = await patch(projectId, "wall", { name: "thickness" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.parameter).toMatchObject({ name: "thickness", value: 5 });
    expect((renamed.body.parameters as Json[])[1]).toMatchObject({ name: "lip", expression: "thickness * 3" });

    const listed = await list(projectId);
    expect(listed.status).toBe(200);
    expect(listed.body.revision).toBe(renamed.body.revision);
    expect((listed.body.parameters as Json[]).map((parameter) => parameter.name)).toEqual(["thickness", "lip"]);

    const deleted = await remove(projectId, "lip");
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, name: "lip", parameters: [{ name: "thickness" }], shapes: [] });
  });

  it("returns the shapes a parameter change rebuilt, and GET /shapes shows them", async () => {
    const projectId = await makeProject();
    await post(projectId, { name: "wall", expression: "2", dimension: "length" });
    const box = await addShape(projectId, { kind: "box", depth: 10, height: 10, expressions: { width: "wall * 5", x: "wall * 10" } });
    expect(box).toMatchObject({ width: 10, x: 20, expressions: { width: "wall * 5", x: "wall * 10" } });
    const before = await volumeAndCentre(projectId, box.id);
    expect(before.volume).toBeCloseTo(1000, 3);
    expect(before.centre.x).toBeCloseTo(20, 6);

    const changed = await patch(projectId, "wall", { expression: "3" });

    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.shapes).toEqual([expect.objectContaining({ id: box.id, width: 15, x: 30, expressions: { width: "wall * 5", x: "wall * 10" } })]);
    expect(await readShape(projectId, box.id)).toMatchObject({ width: 15, x: 30 });
    const after = await volumeAndCentre(projectId, box.id);
    expect(after.volume).toBeCloseTo(1500, 3);
    expect(after.centre.x).toBeCloseTo(30, 6);
  });

  it("reports evaluation errors with their code, span and cycle, and writes nothing", async () => {
    const projectId = await makeProject();
    await post(projectId, { name: "a", expression: "1", dimension: "length" });
    await post(projectId, { name: "b", expression: "a + 1", dimension: "length" });
    const before = await list(projectId);

    const parseError = await post(projectId, { name: "c", expression: "a *", dimension: "length" });
    expect(parseError.status).toBe(422);
    expect(parseError.body).toMatchObject({
      code: "invalid_expression",
      parameter: "c",
      reason: "invalidExpression",
      expressionError: { code: "parseError", span: { start: expect.any(Number), end: expect.any(Number) } },
    });
    expect(typeof parseError.body.error).toBe("string");

    const cycle = await patch(projectId, "a", { expression: "b" });
    expect(cycle.status).toBe(422);
    expect(cycle.body).toMatchObject({ code: "invalid_expression", expressionError: { code: "cycle", cycle: expect.arrayContaining(["a", "b"]) } });

    const mismatch = await patch(projectId, "a", { expression: "30 deg" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: "invalid_expression", expressionError: { code: "dimensionMismatch" } });

    expect((await list(projectId)).body).toEqual(before.body);
  });

  it("refuses malformed requests, duplicates, unknown names and parameters still in use", async () => {
    const projectId = await makeProject();
    await post(projectId, { name: "wall", expression: "2", dimension: "length" });
    const box = await addShape(projectId, { kind: "box", expressions: { width: "wall * 2" } });

    expect((await post(projectId, { name: "wall", expression: "3", dimension: "length" })).body).toMatchObject({ code: "parameter_exists", parameter: "wall" });
    expect((await post(projectId, { name: "wall", expression: "3", dimension: "length" })).status).toBe(409);
    const badName = await post(projectId, { name: "2wall", expression: "3", dimension: "length" });
    expect(badName).toMatchObject({ status: 400, body: { code: "invalid_request", reason: "invalidName" } });
    const reserved = await post(projectId, { name: "mm", expression: "3", dimension: "length" });
    expect(reserved).toMatchObject({ status: 400, body: { code: "invalid_request", reason: "invalidName" } });
    expect((await post(projectId, { name: "depth", expression: "3", dimension: "volume" })).status).toBe(400);
    expect((await post(projectId, { name: "depth", dimension: "length" })).status).toBe(400);
    expect((await patch(projectId, "wall", {})).status).toBe(400);
    expect((await patch(projectId, "wall", { name: "thickness", expression: "4" })).status).toBe(400);

    const unknown = await patch(projectId, "missing", { expression: "4" });
    expect(unknown).toMatchObject({ status: 404, body: { code: "parameter_not_found", parameter: "missing" } });
    expect((await remove(projectId, "missing")).status).toBe(404);

    const inUse = await remove(projectId, "wall");
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({ code: "parameter_in_use", parameter: "wall", dependents: [], shapeDependents: [{ shapeId: box.id, fields: ["width"] }] });

    const brokenBinding = await patch(projectId, "wall", { expression: "30 deg", dimension: "angle" });
    expect(brokenBinding.status).toBe(422);
    expect(brokenBinding.body).toMatchObject({ code: "invalid_expression", shapeId: box.id, field: "width", reason: "invalidExpression", expressionError: { code: "dimensionMismatch" } });

    await call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=${box.id}`, { method: "PATCH", body: JSON.stringify({ locked: true }) });
    const locked = await patch(projectId, "wall", { expression: "3" });
    expect(locked).toMatchObject({ status: 409, body: { code: "shape_locked" } });
    expect((await list(projectId)).body.parameters).toEqual([{ name: "wall", expression: "2", dimension: "length", value: 2 }]);

    const noProject = await call(listParameters, "/api/v1/parameters");
    expect(noProject.status).toBe(400);
    expect((await call(listParameters, "/api/v1/parameters?projectId=absent")).status).toBe(404);
  });

  it("honours If-Match on every parameter write and leaves a stale write unapplied", async () => {
    const projectId = await makeProject();
    const created = await post(projectId, { name: "wall", expression: "2", dimension: "length" });
    const revision = created.body.revision as number;
    const stale = { "If-Match": `"${revision - 1}"` };

    expect(await post(projectId, { name: "lip", expression: "1", dimension: "length" }, stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch", revision } });
    expect(await patch(projectId, "wall", { expression: "9" }, stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch", revision } });
    expect(await patch(projectId, "wall", { name: "thickness" }, stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch" } });
    expect(await remove(projectId, "wall", stale)).toMatchObject({ status: 409, body: { code: "revision_mismatch" } });
    expect((await list(projectId)).body).toMatchObject({ parameters: [{ name: "wall", expression: "2" }], revision });

    const current = await patch(projectId, "wall", { expression: "9" }, { "If-Match": `"${revision}"` });
    expect(current.status).toBe(200);
    expect(current.etag).toBe(`"${current.body.revision}"`);
  });
});

describe("shape requests carrying expressions", () => {
  it("keeps bindings when a client sends a shape summary back whole", async () => {
    const projectId = await makeProject();
    await post(projectId, { name: "wall", expression: "2", dimension: "length" });
    const box = await addShape(projectId, { kind: "box", depth: 10, height: 10, expressions: { width: "wall * 5" } });

    // Without expressions: an unchanged width is an echo, not an edit.
    const { expressions: _expressions, ...withoutExpressions } = await readShape(projectId, box.id);
    const renamed = await call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=${box.id}`, {
      method: "PATCH", body: JSON.stringify({ ...withoutExpressions, name: "Plate" }),
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.shape).toMatchObject({ name: "Plate", width: 10, expressions: { width: "wall * 5" } });

    // With expressions: the whole summary, unchanged, still binds.
    const summary = await readShape(projectId, box.id);
    const echoed = await call(patchShape, `/api/v1/shapes?projectId=${projectId}&shapeId=${box.id}`, {
      method: "PATCH", body: JSON.stringify({ ...summary, color: "#336699" }),
    });
    expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
    expect(echoed.body.shape).toMatchObject({ color: "#336699", expressions: { width: "wall * 5" } });

    await patch(projectId, "wall", { expression: "4" });
    expect(await readShape(projectId, box.id)).toMatchObject({ width: 20, expressions: { width: "wall * 5" } });
    const rebuilt = await volumeAndCentre(projectId, box.id);
    expect(rebuilt.volume).toBeCloseTo(2000, 3);
  });

  it("drops a binding for a changed number, clears one on null, and refuses a contradiction", async () => {
    const projectId = await makeProject();
    await post(projectId, { name: "wall", expression: "2", dimension: "length" });
    const box = await addShape(projectId, { kind: "box", expressions: { width: "wall * 5", depth: "wall * 4" } });
    const url = `/api/v1/shapes?projectId=${projectId}&shapeId=${box.id}`;

    const edited = await call(patchShape, url, { method: "PATCH", body: JSON.stringify({ width: 12 }) });
    expect(edited.body.shape).toMatchObject({ width: 12, expressions: { depth: "wall * 4" } });

    const contradiction = await call(patchShape, url, { method: "PATCH", body: JSON.stringify({ depth: 3, expressions: { depth: "wall * 4" } }) });
    expect(contradiction).toMatchObject({ status: 400, body: { code: "invalid_request" } });

    const cleared = await call(patchShape, url, { method: "PATCH", body: JSON.stringify({ expressions: { depth: null } }) });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.shape).toMatchObject({ depth: 8 });
    expect((cleared.body.shape as Json).expressions).toBeUndefined();

    const rebound = await call(patchShape, url, { method: "PATCH", body: JSON.stringify({ expressions: { height: "wall * 7" } }) });
    expect(rebound.body.shape).toMatchObject({ height: 14, expressions: { height: "wall * 7" } });
  });

  it("refuses bindings that do not evaluate or do not apply, with the normalized error shape", async () => {
    const projectId = await makeProject();
    await post(projectId, { name: "wall", expression: "2", dimension: "length" });
    await post(projectId, { name: "count", expression: "2.5", dimension: "unitless" });
    const box = await addShape(projectId, { kind: "box" });
    const url = `/api/v1/shapes?projectId=${projectId}&shapeId=${box.id}`;

    const invalid = await call(createShapes, `/api/v1/shapes?projectId=${projectId}`, {
      method: "POST", body: JSON.stringify({ shapes: [{ kind: "box" }, { kind: "box", expressions: { width: "wall +" } }] }),
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ code: "invalid_expression", field: "width", reason: "invalidExpression", index: 1, expressionError: { code: "parseError", span: { start: expect.any(Number) } } });
    expect(String(invalid.body.error)).toMatch(/^Shape 1: /);

    const notBindable = await call(patchShape, url, { method: "PATCH", body: JSON.stringify({ expressions: { sides: "6" } }) });
    expect(notBindable).toMatchObject({ status: 422, body: { code: "unapplicable_fields", fields: ["sides"], reason: "fieldNotBindable" } });

    const fractional = await call(createShapes, `/api/v1/shapes?projectId=${projectId}`, {
      method: "POST", body: JSON.stringify({ kind: "cylinder", expressions: { sides: "count" } }),
    });
    expect(fractional).toMatchObject({ status: 422, body: { code: "invalid_expression", reason: "notAnInteger", field: "sides" } });

    const clamped = await call(patchShape, url, { method: "PATCH", body: JSON.stringify({ expressions: { width: "wall * 10000" } }) });
    expect(clamped).toMatchObject({ status: 422, body: { code: "invalid_expression", reason: "outOfRange", field: "width", value: 20000, max: 10000 } });

    const malformed = await call(patchShape, url, { method: "PATCH", body: JSON.stringify({ expressions: { width: 3 } }) });
    expect(malformed).toMatchObject({ status: 400, body: { code: "invalid_request" } });

    expect((await call(getShapes, `/api/v1/shapes?projectId=${projectId}`)).body.shapes).toHaveLength(1);
  });
});
