import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as mcpRoute from "@/app/mcp/route";
import { POST as createProject } from "@/app/api/v1/projects/route";
import * as shapesRoute from "@/app/api/v1/shapes/route";
import * as parametersRoute from "@/app/api/v1/parameters/route";
import * as propertiesRoute from "@/app/api/v1/properties/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";

const root = path.resolve(__dirname, "../..");
const serverScript = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
const TOKEN = "mcp-parameters-token";
const PARAMETER_TOOLS = [
  "sketchforge_list_parameters",
  "sketchforge_set_parameter",
  "sketchforge_rename_parameter",
  "sketchforge_delete_parameter",
  "sketchforge_set_shape_expression",
];

type Json = Record<string, any>;
type ToolAnswer = { isError?: boolean; content: { type: string; text: string }[] };

/** One transport and mode: how to call a tool, and how to make and lock a box there. */
type Mode = {
  tools(): Promise<string[]>;
  call(name: string, args: Json): Promise<ToolAnswer>;
  project(): Promise<string>;
  box(projectId: string, shape: Json): Promise<string>;
  lock(projectId: string, shapeId: string, locked: boolean): Promise<void>;
  close(): Promise<void>;
};

/** Keeps one stdio server open and answers requests in order. */
function stdioSession(environment: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: { ...process.env, SKETCHFORGE_URL: "", ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<number, (message: Json) => void>();
  let buffered = "";
  let stderr = "";
  let nextId = 1;
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
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
    request(method: string, params: Json) {
      const id = nextId++;
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out; stderr: ${stderr}`)), 60_000);
        waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        child.on("close", () => resolve());
        child.stdin.end();
      });
    },
  };
}

function authorized(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(new URL(url, "http://localhost"), { ...init, headers });
}

async function rest(handler: (request: Request) => Promise<Response>, url: string, init: RequestInit = {}) {
  const response = await handler(authorized(url, init));
  const body = await response.json() as Json;
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body;
}

const REST_ROUTES: Record<string, Record<string, (request: Request) => Promise<Response>>> = {
  "/api/v1/shapes": shapesRoute as never,
  "/api/v1/parameters": parametersRoute as never,
  "/api/v1/properties": propertiesRoute as never,
};

/** Serves the real REST v1 route handlers over TCP, for an MCP process started with url. */
async function restServer() {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const handler = REST_ROUTES[url.pathname]?.[request.method ?? "GET"];
      if (!handler) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "No such test route.", code: "not_found" }));
        return;
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const answer = await handler(new Request(url, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        ...(body ? { body } : {}),
      }));
      response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
      response.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test REST server did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function localStdioMode(projectsDir: string): Mode {
  const session = stdioSession({ SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "" });
  const call = async (name: string, args: Json) => (await session.request("tools/call", { name, arguments: args })).result as ToolAnswer;
  return localTools(() => listedNames(session), call, session.close);
}

async function listedNames(session: { request(method: string, params: Json): Promise<Json> }) {
  return ((await session.request("tools/list", {})).result.tools as { name: string }[]).map(({ name }) => name);
}

function hostedHttpMode(): Mode {
  const session = {
    async request(method: string, params: Json) {
      const response = await mcpRoute.POST(new Request("http://sketchforge.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: "sketchforge.test",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }));
      expect(response.status).toBe(200);
      return await response.json() as Json;
    },
  };
  const call = async (name: string, args: Json) => (await session.request("tools/call", { name, arguments: args })).result as ToolAnswer;
  return localTools(() => listedNames(session), call, async () => {});
}

/** Local engine modes make projects and shapes through MCP tools. */
function localTools(tools: Mode["tools"], call: Mode["call"], close: Mode["close"]): Mode {
  return {
    tools,
    call,
    close,
    async project() {
      return json(await call("sketchforge_create_project", { name: "Parameters" })).projectId;
    },
    async box(projectId, shape) {
      return json(await call("sketchforge_create_shape", { projectId, kind: "box", ...shape })).shapes[0].id;
    },
    async lock(projectId, shapeId, locked) {
      json(await call("sketchforge_update_object", { projectId, id: shapeId, locked }));
    },
  };
}

/** Remote mode: MCP tools reach REST over TCP; setup that has no remote tool goes to REST directly. */
async function remoteStdioMode(): Promise<Mode> {
  const api = await restServer();
  const session = stdioSession({ SKETCHFORGE_PROJECTS_DIR: "", SKETCHFORGE_API_TOKEN: TOKEN });
  return {
    tools: () => listedNames(session),
    async call(name, args) {
      return (await session.request("tools/call", { name, arguments: { ...args, url: api.url } })).result as ToolAnswer;
    },
    async project() {
      const created = await rest(createProject, "/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "Parameters" }) });
      return created.project.id;
    },
    async box(projectId, shape) {
      const created = await rest(shapesRoute.POST, `/api/v1/shapes?projectId=${projectId}`, { method: "POST", body: JSON.stringify({ kind: "box", ...shape }) });
      return created.shapes[0].id;
    },
    async lock(projectId, shapeId, locked) {
      await rest(shapesRoute.PATCH, `/api/v1/shapes?projectId=${projectId}&shapeId=${shapeId}`, { method: "PATCH", body: JSON.stringify({ locked }) });
    },
    async close() {
      await session.close();
      await api.close();
    },
  };
}

function json(answer: ToolAnswer) {
  expect(answer.isError, answer.content[0]?.text).toBeUndefined();
  return JSON.parse(answer.content[0].text) as Json;
}

/** Splits a tool error into its `[code]` and the JSON detail on the following line. */
function refusal(answer: ToolAnswer) {
  expect(answer.isError, answer.content[0]?.text).toBe(true);
  const [headline, ...rest] = answer.content[0].text.split("\n");
  const code = /\[([a-z_]+)\]$/.exec(headline)?.[1];
  return { headline, code, detail: rest.length ? JSON.parse(rest.join("\n")) as Json : {} };
}

async function volumeAndCentre(mode: Mode, projectId: string, shapeId: string) {
  const read = json(await mode.call("sketchforge_shape_properties", { projectId, shapeId }));
  const properties = (read.properties ?? read) as { volume: number; centerOfMass: { x: number } };
  return { volume: properties.volume, x: properties.centerOfMass.x };
}

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

beforeEach(async () => {
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-mcp-parameters-"));
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

const MODES: [string, () => Promise<Mode>][] = [
  ["stdio local mode", async () => localStdioMode(projectsRoot)],
  ["stdio remote mode", remoteStdioMode],
  ["Streamable HTTP /mcp", async () => hostedHttpMode()],
];

describe.each(MODES)("MCP parameter tools over %s", (_label, open) => {
  it("lists every parameter tool", async () => {
    const mode = await open();
    try {
      expect(await mode.tools()).toEqual(expect.arrayContaining(PARAMETER_TOOLS));
    } finally {
      await mode.close();
    }
  });

  it("drives bound geometry from parameters and reports each refusal with its code", async () => {
    const mode = await open();
    try {
      const projectId = await mode.project();
      expect(json(await mode.call("sketchforge_list_parameters", { projectId })).parameters).toEqual([]);

      const wall = json(await mode.call("sketchforge_set_parameter", { projectId, name: "wall", expression: "2", dimension: "length" }));
      expect(wall).toMatchObject({ created: true, parameter: { name: "wall", expression: "2", dimension: "length", value: 2 } });
      const lip = json(await mode.call("sketchforge_set_parameter", { projectId, name: "lip", expression: "wall + 1", dimension: "length" }));
      expect(lip.parameter.value).toBe(3);

      const boxId = await mode.box(projectId, { width: 10, depth: 10, height: 10, x: 0 });
      const bound = json(await mode.call("sketchforge_set_shape_expression", { projectId, shapeId: boxId, field: "width", expression: "wall * 5" }));
      expect(bound.shape).toMatchObject({ id: boxId, width: 10, expressions: { width: "wall * 5" } });
      json(await mode.call("sketchforge_set_shape_expression", { projectId, shapeId: boxId, field: "x", expression: "wall * 10" }));
      const before = await volumeAndCentre(mode, projectId, boxId);
      expect(before.volume).toBeCloseTo(1000, 3);
      expect(before.x).toBeCloseTo(20, 3);

      // Expression alone changes an existing parameter.
      const changed = json(await mode.call("sketchforge_set_parameter", { projectId, name: "wall", expression: "3" }));
      expect(changed).toMatchObject({ created: false, parameter: { name: "wall", value: 3 } });
      expect(changed.parameters.find((entry: Json) => entry.name === "lip").value).toBe(4);
      expect(changed.shapes.find((shape: Json) => shape.id === boxId)).toMatchObject({ width: 15, x: 30 });
      const after = await volumeAndCentre(mode, projectId, boxId);
      expect(after.volume).toBeCloseTo(1500, 3);
      expect(after.x).toBeCloseTo(30, 3);

      // Expression and dimension on an existing name change it rather than refusing.
      const restated = json(await mode.call("sketchforge_set_parameter", { projectId, name: "wall", expression: "3 mm", dimension: "length" }));
      expect(restated).toMatchObject({ created: false, parameter: { name: "wall", expression: "3 mm", value: 3 } });

      const syntax = refusal(await mode.call("sketchforge_set_parameter", { projectId, name: "lip", expression: "wall +" }));
      expect(syntax.code).toBe("invalid_expression");
      expect(syntax.detail).toMatchObject({ parameter: "lip", reason: "invalidExpression", expressionError: { span: { start: expect.any(Number), end: expect.any(Number) } } });

      const cycle = refusal(await mode.call("sketchforge_set_parameter", { projectId, name: "wall", expression: "lip" }));
      expect(cycle.code).toBe("invalid_expression");
      expect(cycle.detail.expressionError.cycle).toEqual(expect.arrayContaining(["wall", "lip"]));

      const missing = refusal(await mode.call("sketchforge_set_parameter", { projectId, name: "ghost", expression: "1" }));
      expect(missing.code).toBe("parameter_not_found");
      expect(missing.headline).toMatch(/dimension/);

      const renamed = json(await mode.call("sketchforge_rename_parameter", { projectId, name: "wall", newName: "thickness" }));
      expect(renamed.parameter).toMatchObject({ name: "thickness", value: 3 });
      expect(renamed.parameters.find((entry: Json) => entry.name === "lip").expression).toBe("thickness + 1");
      expect(renamed.shapes.find((shape: Json) => shape.id === boxId).expressions).toEqual({ width: "thickness * 5", x: "thickness * 10" });

      expect(refusal(await mode.call("sketchforge_rename_parameter", { projectId, name: "lip", newName: "thickness" })).code).toBe("parameter_exists");

      const inUse = refusal(await mode.call("sketchforge_delete_parameter", { projectId, name: "thickness" }));
      expect(inUse.code).toBe("parameter_in_use");
      expect(inUse.detail.dependents).toEqual(["lip"]);
      expect(inUse.detail.shapeDependents).toEqual([{ shapeId: boxId, fields: expect.arrayContaining(["width", "x"]) }]);

      expect(json(await mode.call("sketchforge_delete_parameter", { projectId, name: "lip" }))).toMatchObject({ deleted: true, name: "lip" });

      const unbindable = refusal(await mode.call("sketchforge_set_shape_expression", { projectId, shapeId: boxId, field: "teeth", expression: "thickness" }));
      expect(unbindable.code).toBe("unapplicable_fields");
      expect(unbindable.detail.fields).toEqual(["teeth"]);

      const unknownName = refusal(await mode.call("sketchforge_set_shape_expression", { projectId, shapeId: boxId, field: "width", expression: "nope * 2" }));
      expect(unknownName.code).toBe("invalid_expression");
      expect(unknownName.detail).toMatchObject({ shapeId: boxId, field: "width" });

      await mode.lock(projectId, boxId, true);
      const locked = refusal(await mode.call("sketchforge_set_parameter", { projectId, name: "thickness", expression: "4" }));
      expect(locked.code).toBe("shape_locked");
      expect(locked.detail).toMatchObject({ shapeId: boxId, fields: expect.arrayContaining(["width", "x"]) });
      expect((await volumeAndCentre(mode, projectId, boxId)).volume).toBeCloseTo(1500, 3);
      await mode.lock(projectId, boxId, false);

      const cleared = json(await mode.call("sketchforge_set_shape_expression", { projectId, shapeId: boxId, field: "width", expression: null }));
      expect(cleared.shape.width).toBe(15);
      expect(cleared.shape.expressions).toEqual({ x: "thickness * 10" });
      json(await mode.call("sketchforge_set_shape_expression", { projectId, shapeId: boxId, field: "x", expression: null }));

      expect(json(await mode.call("sketchforge_delete_parameter", { projectId, name: "thickness" }))).toMatchObject({ deleted: true, parameters: [] });
      expect(json(await mode.call("sketchforge_list_parameters", { projectId })).parameters).toEqual([]);
      expect(refusal(await mode.call("sketchforge_delete_parameter", { projectId, name: "thickness" })).code).toBe("parameter_not_found");
      expect(refusal(await mode.call("sketchforge_list_parameters", { projectId: "no-such-project" })).code).toBe("project_not_found");
    } finally {
      await mode.close();
    }
  }, 120_000);
});
