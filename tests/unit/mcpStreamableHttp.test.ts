import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as route from "@/app/mcp/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { readProjectDocument } from "@constructorfleet/sketchforge-engine/serverProjectDocument";
import { listTools as listStdioTools, runMcp } from "./support/localMcp";
import clientManifest from "../../packages/sketchforge-client/package.json";

const TOKEN = "test-token-value";
const ENDPOINT = "http://sketchforge.test/mcp";

let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

beforeEach(async () => {
  previousRoot = process.env[SERVER_PROJECTS_ENV];
  previousToken = process.env[API_TOKEN_ENV];
  projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-mcp-http-"));
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

function post(body: unknown, headers: Record<string, string> = {}) {
  return route.POST(new Request(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "sketchforge.test",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

async function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await post({ jsonrpc: "2.0", id, method, params });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return await response.json() as { jsonrpc: string; id: number; result?: any; error?: { code: number; message: string } };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return result as { isError?: boolean; content: { type: string; text: string }[] };
}

async function toolJson(name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(name, args);
  expect(result.isError, result.content[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe("POST /mcp access", () => {
  it("answers 404 while no API token is configured", async () => {
    delete process.env[API_TOKEN_ENV];
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("api_disabled");
  });

  it("answers 401 with a bearer challenge for a wrong token", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer wrong" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("answers 503 without server project storage", async () => {
    delete process.env[SERVER_PROJECTS_ENV];
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.status).toBe(503);
  });

  it("refuses a browser request from another origin", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://attacker.example" });
    expect(response.status).toBe(403);
  });

  it("accepts a browser request from its own origin", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "http://sketchforge.test" });
    expect(response.status).toBe(200);
  });

  it("leaves GET and DELETE unimplemented so the framework answers 405", () => {
    expect(Object.keys(route).filter((name) => ["GET", "DELETE", "PUT", "PATCH"].includes(name))).toEqual([]);
  });
});

describe("POST /mcp transport", () => {
  it("negotiates a supported protocol version on initialize", async () => {
    const supported = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(supported.result.protocolVersion).toBe("2025-06-18");
    expect(supported.result.capabilities).toEqual({ tools: {} });
    expect(supported.result.serverInfo.name).toBe("sketchforge-mcp");
    expect(supported.result.serverInfo.version).toBe(clientManifest.version);

    const unknown = await rpc("initialize", { protocolVersion: "2099-01-01" });
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
  });

  it("accepts notifications with 202 and no body", async () => {
    const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers a batch with one response per request", async () => {
    const response = await post([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "no/such/method" },
    ]);
    expect(response.status).toBe(200);
    const answers = await response.json() as { id: string; result?: unknown; error?: { code: number } }[];
    expect(answers.map(({ id }) => id).sort()).toEqual(["a", "b"]);
    expect(answers.find(({ id }) => id === "a")?.result).toEqual({});
    expect(answers.find(({ id }) => id === "b")?.error?.code).toBe(-32601);
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32700);
  });

  it("answers a body that is not a JSON-RPC message with an invalid-request error", async () => {
    for (const body of [[], 7, { jsonrpc: "2.0" }, { id: 1, method: "ping" }]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).error.code).toBe(-32600);
    }
  });

  it("refuses a body that is not JSON", async () => {
    const response = await post("ping", { "Content-Type": "text/plain" });
    expect(response.status).toBe(415);
  });

  it("refuses a client that cannot accept a JSON answer", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Accept: "text/html" });
    expect(response.status).toBe(406);
  });

  it("refuses an unsupported MCP-Protocol-Version header", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "1999-01-01" });
    expect(response.status).toBe(400);
    const accepted = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "2025-03-26" });
    expect(accepted.status).toBe(200);
  });

  it("refuses an oversized body without parsing it", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "ping", params: { padding: "x".repeat(17 * 1024 * 1024) } });
    expect(response.status).toBe(413);
  });
});

describe("POST /mcp tools", () => {
  it("lists the stdio tools that work on server storage, without editor targeting", async () => {
    const hosted = (await rpc("tools/list")).result.tools as { name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }[];
    const names = hosted.map(({ name }) => name);
    const stdio = listStdioTools(projectsRoot);
    const withheld = [
      "sketchforge_list_editors",
      "sketchforge_inspect_errors",
      "sketchforge_select_objects",
      "sketchforge_list_macros",
      "sketchforge_run_macro",
    ];
    expect(names).toEqual(stdio.map(({ name }) => name).filter((name) => !withheld.includes(name)));
    for (const tool of hosted) {
      for (const property of ["url", "editorNumber", "editorId", "timeoutMs"]) {
        expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).not.toContain(property);
      }
      expect(tool.description, tool.name).toBe(stdio.find(({ name }) => name === tool.name)?.description);
    }
  });

  it("serves every listed tool from the local engine", async () => {
    const hosted = (await rpc("tools/list")).result.tools as { name: string }[];
    const probe = await toolJson("sketchforge_create_project", { name: "Probe" });
    for (const { name } of hosted) {
      const result = await callTool(name, { projectId: probe.projectId });
      expect(result.content[0].text, name).not.toMatch(/needs an open SketchForge editor|Unknown tool/);
    }
  });

  it("writes to the server's project storage", async () => {
    const project = await toolJson("sketchforge_create_project", { name: "Bracket" });
    await toolJson("sketchforge_create_shape", { projectId: project.projectId, kind: "box", name: "Plate", width: 40, depth: 20, height: 5 });

    const listed = await toolJson("sketchforge_list_objects", { projectId: project.projectId });
    expect(listed.objects.map((shape: { name: string }) => shape.name)).toEqual(["Plate"]);

    const stored = await readProjectDocument(projectsRoot, project.projectId);
    expect(stored?.shapes.map(({ name, width, depth, height }) => ({ name, width, depth, height }))).toEqual([
      { name: "Plate", width: 40, depth: 20, height: 5 },
    ]);
  });

  it("reports a tool failure as a tool result, not a transport error", async () => {
    const result = await callTool("sketchforge_list_objects", { projectId: "missing" });
    expect(result.isError).toBe(true);
  });

  it("refuses to forward a call to another server", async () => {
    const result = await callTool("sketchforge_list_objects", { projectId: "case", url: "http://169.254.169.254" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/url/);
  });

  it("does not serve tools it does not list", async () => {
    for (const name of ["sketchforge_run_macro", "sketchforge_list_macros", "sketchforge_select_objects", "sketchforge_list_editors"]) {
      const result = await callTool(name, { projectId: "case" });
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toMatch(/Unknown tool/);
    }
  });
});

describe("POST /mcp host filesystem", () => {
  let outside = "";
  let filesDir = "";
  let previousFilesDir: string | undefined;

  beforeEach(async () => {
    previousFilesDir = process.env.SKETCHFORGE_MCP_FILES_DIR;
    delete process.env.SKETCHFORGE_MCP_FILES_DIR;
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-mcp-outside-"));
    filesDir = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-mcp-files-"));
  });

  afterEach(async () => {
    if (previousFilesDir === undefined) delete process.env.SKETCHFORGE_MCP_FILES_DIR;
    else process.env.SKETCHFORGE_MCP_FILES_DIR = previousFilesDir;
    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(filesDir, { recursive: true, force: true });
  });

  it("refuses a projectId that names a file outside the project directory", async () => {
    const victim = path.join(outside, "victim.json");
    const original = JSON.stringify({ name: "Victim", createdAt: 1, revision: 1 });
    await fs.writeFile(victim, original);
    const traversal = path.join(path.relative(projectsRoot, outside), "victim");

    for (const projectId of [traversal, path.join(outside, "victim"), "a/b", "..", "a.b", " "]) {
      const read = await callTool("sketchforge_read_scene", { projectId });
      expect(read.isError, projectId).toBe(true);
      expect(read.content[0].text, projectId).toMatch(/projectId/);
      expect(read.content[0].text, projectId).not.toContain("Victim");
      const write = await callTool("sketchforge_create_shape", { projectId, kind: "box" });
      expect(write.isError, projectId).toBe(true);
    }
    expect(await fs.readFile(victim, "utf8")).toBe(original);
    expect(await fs.readdir(outside)).toEqual(["victim.json"]);
  });

  it("refuses host file paths until a separate files directory is configured", async () => {
    const project = await toolJson("sketchforge_create_project", { name: "Paths" });
    await toolJson("sketchforge_create_shape", { projectId: project.projectId, kind: "box" });
    const lock = path.join(projectsRoot, `${project.projectId}.lock`);

    const roots = [undefined, projectsRoot, path.join(projectsRoot, "exports"), path.dirname(projectsRoot)];
    for (const root of roots) {
      if (root === undefined) delete process.env.SKETCHFORGE_MCP_FILES_DIR;
      else process.env.SKETCHFORGE_MCP_FILES_DIR = root;
      const exported = await callTool("sketchforge_export_scene", { projectId: project.projectId, format: "stl", outputPath: lock });
      expect(exported.isError, String(root)).toBe(true);
      expect(exported.content[0].text, String(root)).toMatch(/SKETCHFORGE_MCP_FILES_DIR/);
      const imported = await callTool("sketchforge_import_project", { filePath: path.join(projectsRoot, `${project.projectId}.skf`) });
      expect(imported.isError, String(root)).toBe(true);
      expect(imported.content[0].text, String(root)).toMatch(/SKETCHFORGE_MCP_FILES_DIR/);
    }
    await expect(fs.access(lock)).rejects.toThrow();
    // The project still takes writes: no stray lock was left behind.
    await toolJson("sketchforge_create_shape", { projectId: project.projectId, kind: "box" });
  });

  it("reads and writes host files inside a separate files directory", async () => {
    process.env.SKETCHFORGE_MCP_FILES_DIR = filesDir;
    const project = await toolJson("sketchforge_create_project", { name: "Paths" });
    await toolJson("sketchforge_create_shape", { projectId: project.projectId, kind: "box", width: 10, depth: 10, height: 10 });

    const destination = path.join(filesDir, "out", "part.stl");
    const exported = await toolJson("sketchforge_export_scene", { projectId: project.projectId, format: "stl", outputPath: destination });
    expect(exported.savedTo).toBe(destination);
    expect((await fs.stat(destination)).size).toBe(exported.bytes);

    const escaped = await callTool("sketchforge_export_scene", { projectId: project.projectId, format: "stl", outputPath: path.join(outside, "part.stl") });
    expect(escaped.isError).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);

    const inline = await toolJson("sketchforge_export_scene", { projectId: project.projectId, format: "stl" });
    expect(Buffer.from(inline.base64, "base64").byteLength).toBe(exported.bytes);
  });

  it("answers the same for a missing and an existing file outside the files directory", async () => {
    process.env.SKETCHFORGE_MCP_FILES_DIR = filesDir;
    await fs.writeFile(path.join(outside, "real.skf"), "x");
    const existing = await callTool("sketchforge_import_project", { filePath: path.join(outside, "real.skf") });
    const missing = await callTool("sketchforge_import_project", { filePath: path.join(outside, "missing.skf") });
    expect(existing.isError).toBe(true);
    expect(missing.content[0].text).toBe(existing.content[0].text);
  });
});

describe("stdio transport", () => {
  it("negotiates the protocol version and stays silent for messages without an id", () => {
    const answers = runMcp(projectsRoot, [
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } },
      { jsonrpc: "2.0", method: "notifications/unknown" },
      { jsonrpc: "2.0", method: "tools/call", params: { name: "sketchforge_create_project", arguments: { name: "Unasked" } } },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]);
    expect(answers.get(1).result.protocolVersion).toBe("2024-11-05");
    expect(answers.get(2).result.protocolVersion).toBe("2025-11-25");
    expect([...answers.keys()].sort()).toEqual([1, 2, 3]);
    expect(fsSync.readdirSync(projectsRoot)).toEqual([]);
  });
});
