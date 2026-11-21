import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as projectsRoute from "@/app/api/v1/projects/route";
import * as shapesRoute from "@/app/api/v1/shapes/route";
import * as parametersRoute from "@/app/api/v1/parameters/route";
import * as propertiesRoute from "@/app/api/v1/properties/route";
import * as sketchConstraintsRoute from "@/app/api/v1/sketch-constraints/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { createEngine } from "@/lib/engine/engine";
import { directoryProjectStore } from "@/lib/engine/projectStore";

/**
 * Sends each call to a local-mode and a remote-mode MCP server, on identical
 * projects in one store, and requires the same reply or refusal from both.
 */

const root = path.resolve(__dirname, "../..");
const serverScript = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const TOKEN = "mcp-parity-token";

type Json = Record<string, any>;
type Answer = { isError: boolean; text: string };

function stdio(environment: Record<string, string>) {
  const child = spawn(process.execPath, [serverScript], { cwd: root, env: { ...process.env, SKETCHFORGE_URL: "", ...environment } });
  const waiting = new Map<number, (message: Json) => void>();
  let buffered = "";
  let nextId = 1;
  child.stderr.on("data", () => {});
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const message = JSON.parse(line) as Json;
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  return {
    async call(name: string, args: Json): Promise<Answer> {
      const id = nextId++;
      const message = await new Promise<Json>((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
      return { isError: message.result?.isError ?? false, text: message.result?.content?.[0]?.text ?? JSON.stringify(message) };
    },
    close: () => new Promise<void>((resolve) => { child.on("close", () => resolve()); child.stdin.end(); }),
  };
}

const ROUTES: Record<string, Json> = {
  "/api/v1/projects": projectsRoute,
  "/api/v1/shapes": shapesRoute,
  "/api/v1/parameters": parametersRoute,
  "/api/v1/properties": propertiesRoute,
  "/api/v1/sketch-constraints": sketchConstraintsRoute,
};

async function restServer() {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const handler = ROUTES[url.pathname]?.[request.method ?? "GET"];
      if (!handler) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const answer: Response = await handler(new Request(url, { method: request.method, headers: request.headers as Record<string, string>, ...(body ? { body } : {}) }));
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test REST server did not bind a TCP port.");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A 2 x 2 square, corner `a` fixed; `diagonal` over-constrains it so only width 2 solves. */
const squareProfile = ({ diagonal }: { diagonal: boolean }) => ({
  points: [{ id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 }, { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 }],
  segments: [{ id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" }, { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" }],
  constraints: [
    { id: "fix-a", kind: "fixed", pointId: "a", xMm: -1, zMm: -1 },
    { id: "h-ab", kind: "horizontal", segmentId: "ab" },
    { id: "v-bc", kind: "vertical", segmentId: "bc" },
    { id: "h-cd", kind: "horizontal", segmentId: "cd" },
    { id: "v-da", kind: "vertical", segmentId: "da" },
    { id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 2 },
    { id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 },
    ...(diagonal ? [{ id: "diagonal", kind: "distance", pointIds: ["a", "c"], valueMm: Math.hypot(2, 2) }] : []),
  ],
});

let projectsDir = "";
let api: Awaited<ReturnType<typeof restServer>>;
let local: ReturnType<typeof stdio>;
let remote: ReturnType<typeof stdio>;
const previous = { root: process.env[SERVER_PROJECTS_ENV], token: process.env[API_TOKEN_ENV] };

async function rest(handler: (request: Request) => Promise<Response>, url: string, body: Json) {
  const response = await handler(new Request(new URL(url, "http://localhost"), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const payload = await response.json() as Json;
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  return payload;
}

type Fixture = { projectId: string; shapeId: string };

async function boxProject(): Promise<Fixture> {
  const projectId = (await rest(projectsRoute.POST, "/api/v1/projects", { name: "Parity" })).project.id;
  const shapeId = (await rest(shapesRoute.POST, `/api/v1/shapes?projectId=${projectId}`, { kind: "box", width: 10, depth: 10, height: 10 })).shapes[0].id;
  return { projectId, shapeId };
}

/** A 2 x 2 x 3 sketch-backed extrusion with `w = 2`; by default its `width` constraint is bound to `w`. */
async function sketchProject({ diagonal = true, bindWidth = true } = {}): Promise<Fixture> {
  const projectId = (await rest(projectsRoute.POST, "/api/v1/projects", { name: "Sketch" })).project.id;
  const store = directoryProjectStore(projectsDir);
  const engine = createEngine(store);
  const added = await engine.addShapes(projectId, [{ kind: "box", width: 2, depth: 2, height: 3 }]);
  if (!added.ok) throw new Error(JSON.stringify(added.failure));
  const document = (await store.read(projectId))!;
  const shape = document.shapes[0]!;
  await store.write(projectId, document, [{
    ...shape,
    sketchOperation: "extrude",
    sketchProfile: squareProfile({ diagonal }),
    sketchSourceId: "sketch",
    cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
  } as never]);
  const added2 = await engine.addParameter(projectId, { name: "w", expression: "2", dimension: "length" });
  if (!added2.ok) throw new Error(JSON.stringify(added2.failure));
  if (bindWidth) {
    const bound = await engine.bindSketchConstraint(projectId, shape.id, "width", "w");
    if (!bound.ok) throw new Error(JSON.stringify(bound.failure));
  }
  return { projectId, shapeId: shape.id };
}

function normalized(answer: Answer, fixture: Fixture) {
  return {
    isError: answer.isError,
    // A rebuild mints random face ids, so only their count and order compare.
    text: answer.text.split(fixture.projectId).join("<project>").split(fixture.shapeId).join("<shape>")
      .replace(/"revision": ?\d+/g, '"revision": N')
      .replace(/(-face-\d+-)[0-9a-f-]{36}/g, "$1<id>"),
  };
}

/** Calls local on `a` and remote on `b`, asserts they agree, and returns local's reply. */
async function both(name: string, args: (fixture: Fixture) => Json, a: Fixture, b: Fixture) {
  const fromLocal = await local.call(name, args(a));
  const fromRemote = await remote.call(name, { ...args(b), url: api.url });
  expect(normalized(fromLocal, a), `${name} ${JSON.stringify(args(a))}`).toEqual(normalized(fromRemote, b));
  return { local: fromLocal, remote: fromRemote };
}

beforeAll(async () => {
  projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-mcp-parity-"));
  process.env[SERVER_PROJECTS_ENV] = projectsDir;
  process.env[API_TOKEN_ENV] = TOKEN;
  api = await restServer();
  local = stdio({ SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "" });
  remote = stdio({ SKETCHFORGE_PROJECTS_DIR: "", SKETCHFORGE_API_TOKEN: TOKEN });
});

afterAll(async () => {
  await local.close();
  await remote.close();
  await api.close();
  if (previous.root === undefined) delete process.env[SERVER_PROJECTS_ENV];
  else process.env[SERVER_PROJECTS_ENV] = previous.root;
  if (previous.token === undefined) delete process.env[API_TOKEN_ENV];
  else process.env[API_TOKEN_ENV] = previous.token;
  await fs.rm(projectsDir, { recursive: true, force: true });
});

const SET = "sketchforge_set_parameter";
const BIND = "sketchforge_set_shape_expression";

describe("MCP parameter tools answer the same in local and remote mode", () => {
  it("agrees on every reply and refusal for a box", async () => {
    const a = await boxProject();
    const b = await boxProject();
    const steps: [string, (fixture: Fixture) => Json][] = [
      ["sketchforge_list_parameters", () => ({})],
      ["sketchforge_list_parameters", () => ({ projectId: "bad id" })],
      [SET, (c) => ({ projectId: c.projectId, name: "wall" })],
      [SET, (c) => ({ projectId: c.projectId, name: "1bad", expression: "2", dimension: "length" })],
      [SET, (c) => ({ projectId: c.projectId, name: "w", expression: "2", dimension: "bogus" })],
      [SET, (c) => ({ projectId: c.projectId, name: "w", expression: "", dimension: "length" })],
      [SET, (c) => ({ projectId: c.projectId, name: "big", expression: `${"1+".repeat(6000)}1`, dimension: "unitless" })],
      [SET, (c) => ({ projectId: c.projectId, name: "x".repeat(65), expression: "1", dimension: "unitless" })],
      [SET, (c) => ({ projectId: c.projectId, name: "ghost", expression: "1" })],
      [SET, (c) => ({ projectId: c.projectId, name: "wall", expression: "2", dimension: "length" })],
      [SET, (c) => ({ projectId: c.projectId, name: "ang", expression: "30 deg", dimension: "angle" })],
      [SET, (c) => ({ projectId: c.projectId, name: "wall", expression: "2", dimension: "length" })],
      [SET, (c) => ({ projectId: c.projectId, name: "wall", expression: "wall +" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "width", expression: "wall * 5" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "__proto__", expression: "wall" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "depth", expression: "" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "depth", expression: 5 })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "depth" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "height", expression: "wall * -100" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "depth", expression: "ang" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "teeth", expression: "wall" })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: "nope", field: "width", expression: "wall" })],
      [SET, (c) => ({ projectId: c.projectId, name: "wall", expression: "3" })],
      [SET, (c) => ({ projectId: c.projectId, name: "wall", dimension: "angle" })],
      ["sketchforge_rename_parameter", (c) => ({ projectId: c.projectId, name: "wall", newName: "wall" })],
      ["sketchforge_rename_parameter", (c) => ({ projectId: c.projectId, name: "wall", newName: "a b" })],
      ["sketchforge_rename_parameter", (c) => ({ projectId: c.projectId, name: "ghost", newName: "z" })],
      ["sketchforge_rename_parameter", (c) => ({ projectId: c.projectId, name: "ang", newName: "wall" })],
      ["sketchforge_delete_parameter", (c) => ({ projectId: c.projectId, name: "x#y" })],
      ["sketchforge_delete_parameter", (c) => ({ projectId: c.projectId, name: "wall" })],
      ["sketchforge_list_parameters", (c) => ({ projectId: c.projectId })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "width", expression: null })],
      ["sketchforge_delete_parameter", (c) => ({ projectId: c.projectId, name: "wall" })],
    ];
    for (const [name, args] of steps) await both(name, args, a, b);
  }, 120_000);

  it("agrees on a locked shape, with the bound fields named", async () => {
    const a = await boxProject();
    const b = await boxProject();
    await both(SET, (c) => ({ projectId: c.projectId, name: "wall", expression: "2", dimension: "length" }), a, b);
    await both(BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "width", expression: "wall * 5" }), a, b);
    for (const fixture of [a, b]) {
      const response = await shapesRoute.PATCH(new Request(new URL(`/api/v1/shapes?projectId=${fixture.projectId}&shapeId=${fixture.shapeId}`, "http://localhost"), {
        method: "PATCH",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ locked: true }),
      }));
      expect(response.status).toBe(200);
    }
    const viaParameter = await both(SET, (c) => ({ projectId: c.projectId, name: "wall", expression: "3" }), a, b);
    expect(viaParameter.local.text).toMatch(/\[shape_locked\]/);
    const direct = await both(BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "depth", expression: "wall" }), a, b);
    const [headline, detail] = direct.local.text.split("\n");
    expect(headline).toMatch(/\[shape_locked\]$/);
    expect(JSON.parse(detail!)).toEqual({ shapeId: a.shapeId, fields: ["depth"] });
  }, 60_000);

  it("does not write when a binding repeats the stored expression", async () => {
    const a = await boxProject();
    const b = await boxProject();
    await both(SET, (c) => ({ projectId: c.projectId, name: "wall", expression: "2", dimension: "length" }), a, b);
    const first = await both(BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "width", expression: "wall * 5" }), a, b);
    const again = await both(BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "width", expression: "wall * 5" }), a, b);
    for (const mode of ["local", "remote"] as const) {
      expect(JSON.parse(again[mode].text).revision, mode).toBe(JSON.parse(first[mode].text).revision);
    }
  }, 60_000);

  it("agrees on sketch constraint bindings", async () => {
    const a = await sketchProject();
    const b = await sketchProject();
    const inUse = await both("sketchforge_delete_parameter", (c) => ({ projectId: c.projectId, name: "w" }), a, b);
    expect(JSON.parse(inUse.local.text.split("\n")[1]!).sketchConstraintDependents).toEqual([{ shapeId: a.shapeId, constraintIds: ["width"] }]);
    const unsolvable = await both(SET, (c) => ({ projectId: c.projectId, name: "w", expression: "4" }), a, b);
    expect(unsolvable.local.text).toMatch(/\[geometry_failed\]/);
    await both("sketchforge_list_parameters", (c) => ({ projectId: c.projectId }), a, b);
    await both(SET, (c) => ({ projectId: c.projectId, name: "w", expression: "2 mm" }), a, b);
  }, 60_000);

  it("agrees on binding and unbinding sketch constraints, and on each refusal", async () => {
    const BIND_CONSTRAINT = "sketchforge_bind_sketch_constraint";
    const a = await sketchProject({ diagonal: false, bindWidth: false });
    const b = await sketchProject({ diagonal: false, bindWidth: false });
    const volume = async (mode: typeof local, fixture: Fixture, url?: string) => {
      const read = JSON.parse((await mode.call("sketchforge_shape_properties", { projectId: fixture.projectId, shapeId: fixture.shapeId, ...(url ? { url } : {}) })).text);
      return (read.properties ?? read) as { volume: number; centerOfMass: { x: number } };
    };
    const before = await volume(local, a);

    const bound = await both(BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width", expression: "w * 2" }), a, b);
    expect(JSON.parse(bound.local.text).constraint).toEqual({ id: "width", kind: "distance", value: 4, expression: "w * 2" });
    // 2 x 2 x 3 grows to 4 x 2 x 3 with corner `a` held: twice the volume, centre 1 mm further along x.
    for (const [mode, fixture, url] of [[local, a, undefined], [remote, b, api.url]] as const) {
      const after = await volume(mode, fixture, url);
      expect(after.volume).toBeCloseTo(before.volume * 2, 3);
      expect(after.centerOfMass.x - before.centerOfMass.x).toBeCloseTo(1, 4);
    }
    await both("sketchforge_set_parameter", (c) => ({ projectId: c.projectId, name: "w", expression: "1.5" }), a, b);

    const steps: [string, (fixture: Fixture) => Json][] = [
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width", expression: "-w" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width", expression: "nope" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width", expression: "" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "missing", expression: "w" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "h-ab", expression: "w" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: "nowhere", constraintId: "width", expression: "w" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "x".repeat(201), expression: "w" })],
      [BIND_CONSTRAINT, (c) => ({ shapeId: c.shapeId, constraintId: "width", expression: "w" })],
      // A bound sketch dimension and a bound size of the same output conflict.
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "depth", expression: "w" })],
      ["sketchforge_delete_parameter", (c) => ({ projectId: c.projectId, name: "w" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width", expression: "w * 2" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width", expression: null })],
      [BIND, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, field: "width", expression: "w" })],
      [BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "depth", expression: "w" })],
    ];
    const answers: { local: Answer; remote: Answer }[] = [];
    for (const [name, args] of steps) answers.push(await both(name, args, a, b));
    const code = (index: number) => /\[([a-z_]+)\]$/.exec(answers[index]!.local.text.split("\n")[0]!)?.[1];
    expect(code(0)).toBe("invalid_expression");
    expect(JSON.parse(answers[0]!.local.text.split("\n")[1]!)).toMatchObject({ reason: "outOfRange", constraintId: "width" });
    expect(code(4)).toBe("invalid_request");
    expect(code(5)).toBe("unapplicable_fields");
    expect(code(6)).toBe("shape_not_found");
    expect(code(9)).toBe("unapplicable_fields");
    expect(JSON.parse(answers[9]!.local.text.split("\n")[1]!)).toMatchObject({ reason: "conflictingBinding", constraintIds: ["width"] });
    expect(JSON.parse(answers[10]!.local.text.split("\n")[1]!).sketchConstraintDependents).toEqual([{ shapeId: a.shapeId, constraintIds: ["width"] }]);
    expect(JSON.parse(answers[12]!.local.text).constraint).toEqual({ id: "width", kind: "distance", value: 3 });
    expect(code(14)).toBe("unapplicable_fields");
    expect(JSON.parse(answers[14]!.local.text.split("\n")[1]!)).toMatchObject({ reason: "conflictingBinding", fields: ["width"] });
  }, 120_000);

  it("agrees when a constraint binding hits a lock or an unsolvable sketch", async () => {
    const BIND_CONSTRAINT = "sketchforge_bind_sketch_constraint";
    const a = await sketchProject({ diagonal: true, bindWidth: false });
    const b = await sketchProject({ diagonal: true, bindWidth: false });
    const unsolvable = await both(BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "width", expression: "w * 2" }), a, b);
    expect(unsolvable.local.text).toMatch(/\[geometry_failed\]/);
    expect(JSON.parse(unsolvable.local.text.split("\n")[1]!).constraintIds).toEqual(expect.arrayContaining(["diagonal"]));
    for (const fixture of [a, b]) {
      const response = await shapesRoute.PATCH(new Request(new URL(`/api/v1/shapes?projectId=${fixture.projectId}&shapeId=${fixture.shapeId}`, "http://localhost"), {
        method: "PATCH",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ locked: true }),
      }));
      expect(response.status).toBe(200);
    }
    const locked = await both(BIND_CONSTRAINT, (c) => ({ projectId: c.projectId, shapeId: c.shapeId, constraintId: "depth", expression: "w" }), a, b);
    expect(locked.local.text).toMatch(/\[shape_locked\]/);
  }, 60_000);
});
