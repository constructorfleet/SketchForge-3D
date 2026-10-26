import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";
import { CLIENT_COMPOSITE_RESOURCE_OPERATIONS, CLIENT_RESOURCE_OPERATIONS, SketchForgeClient } from "../../packages/sketchforge-client/src/client.js";
import {
  MCP_NON_REST_TOOL_REASONS,
  MCP_RESOURCE_OPERATIONS,
  MCP_UNSUPPORTED_OPERATIONS,
} from "../../packages/sketchforge-client/mcp/operation-parity.mjs";

const root = process.cwd();

function pythonResources(): {
  resources: string[];
  operations: Record<string, unknown>;
  compositeOperations: Record<string, Record<string, string[]>>;
  methods: Record<string, string[]>;
} {
  const python = process.platform === "win32" ? "python" : "python3";
  const source = [
    "import json",
    "from sketchforge3d.client import CLIENT_COMPOSITE_RESOURCE_OPERATIONS, CLIENT_RESOURCE_OPERATIONS, SketchForgeClient",
    "client = SketchForgeClient('http://localhost', 'test')",
    "resources = [key for key in vars(client) if not key.startswith('_')]",
    "methods = {key: [name for name in dir(getattr(client, key)) if not name.startswith('_') and callable(getattr(getattr(client, key), name))] for key in resources}",
    "print(json.dumps({'resources': resources, 'operations': CLIENT_RESOURCE_OPERATIONS, 'compositeOperations': CLIENT_COMPOSITE_RESOURCE_OPERATIONS, 'methods': methods}))",
  ].join("; ");
  const output = execFileSync(python, ["-c", source], {
    cwd: path.join(root, "packages/sketchforge-py"),
    env: { ...process.env, PYTHONPATH: "src" },
    encoding: "utf8",
  });
  return JSON.parse(output) as { resources: string[]; operations: Record<string, unknown>; compositeOperations: Record<string, Record<string, string[]>>; methods: Record<string, string[]> };
}

function declaredOperationIds(resourceOperations: Record<string, unknown>): string[] {
  return Object.values(resourceOperations).flatMap((operations) =>
    operations && typeof operations === "object" ? Object.keys(operations) : [],
  );
}

const PROJECT_ID = "parity-project";
const SHAPE_ID = "parity-shape";
const CALL_ARGUMENTS: Record<string, unknown[]> = {
  listProjectsOrGetProject: [],
  createProject: ["Parity project"],
  deleteProject: [PROJECT_ID],
  listShapes: [PROJECT_ID],
  createShapes: [PROJECT_ID, { kind: "box", width: 1, depth: 1, height: 1 }],
  updateShape: [PROJECT_ID, SHAPE_ID, { name: "Updated" }],
  deleteShape: [PROJECT_ID, SHAPE_ID],
  listEdges: [PROJECT_ID, SHAPE_ID],
  explodeAssembly: [PROJECT_ID, SHAPE_ID],
  listFaces: [PROJECT_ID, SHAPE_ID],
  listMeasurements: [PROJECT_ID, SHAPE_ID],
  measureEntities: [PROJECT_ID, { shapeId: SHAPE_ID }, { shapeId: "other-shape" }],
  mirrorShapes: [PROJECT_ID, [SHAPE_ID], "x"],
  getShapeProperties: [PROJECT_ID, SHAPE_ID],
  treatShape: [PROJECT_ID, SHAPE_ID, { kind: "fillet", amount: 1 }],
  draftPrism: [PROJECT_ID, SHAPE_ID, 1],
  shellShape: [PROJECT_ID, SHAPE_ID, { thickness: 1 }],
  alignShapes: [PROJECT_ID, { ids: [SHAPE_ID, "other-shape"], axis: "x", target: "top" }],
  distributeShapes: [PROJECT_ID, { ids: [SHAPE_ID, "other-shape", "third-shape"], axis: "x", spacing: "equal" }],
  patternShapes: [PROJECT_ID, { kind: "row", ids: [SHAPE_ID], count: 2, stepX: 1 }],
  importGeometry: [PROJECT_ID, { fileName: "mesh.stl", bytes: new Uint8Array([1]), mediaType: "model/stl" }],
  analyzeInterference: [PROJECT_ID, { ids: [SHAPE_ID] }],
  estimateThickness: [PROJECT_ID, SHAPE_ID],
  exportProject: [PROJECT_ID, { format: "stl" }],
  booleanShapes: [PROJECT_ID, { solidIds: [SHAPE_ID], holeIds: ["cutter"] }],
  groupShapes: [PROJECT_ID, [SHAPE_ID, "other-shape"]],
  ungroupShape: [PROJECT_ID, SHAPE_ID],
  splitParts: [PROJECT_ID, SHAPE_ID],
};
const PYTHON_CALL_ARGUMENTS: Record<string, unknown[]> = {
  ...CALL_ARGUMENTS,
  treatShape: [PROJECT_ID, SHAPE_ID, "fillet", 1],
  alignShapes: [PROJECT_ID, [SHAPE_ID, "other-shape"], "x", "max"],
  booleanShapes: [PROJECT_ID, [SHAPE_ID], ["cutter"]],
};
const TS_METHOD_ARGUMENTS: Record<string, unknown[]> = {
  "drawings.section": [PROJECT_ID, { plane: "xy", offset: 0 }],
  "drawings.dxf": [PROJECT_ID, { plane: "xy", offset: 0 }],
  "projects.listPage": [{ limit: 10, cursor: "next-page" }],
  "projects.get": [PROJECT_ID],
  "projects.findByName": ["Parity project"],
  "shapes.listPage": [PROJECT_ID, { limit: 10, cursor: "next-page" }],
  "shapes.createMany": [PROJECT_ID, [{ kind: "box", width: 1, depth: 1, height: 1 }]],
  "treatments.fillet": [PROJECT_ID, SHAPE_ID, 1],
  "treatments.chamfer": [PROJECT_ID, SHAPE_ID, 1],
  "shell.hollow": [PROJECT_ID, SHAPE_ID, 1],
  "shell.tray": [PROJECT_ID, SHAPE_ID, 1],
  "align.tops": [PROJECT_ID, [SHAPE_ID, "other-shape"]],
  "align.bottoms": [PROJECT_ID, [SHAPE_ID, "other-shape"]],
  "align.centers": [PROJECT_ID, [SHAPE_ID, "other-shape"], "x"],
  "distribute.gaps": [PROJECT_ID, [SHAPE_ID, "other-shape", "third-shape"]],
  "distribute.pitch": [PROJECT_ID, [SHAPE_ID, "other-shape", "third-shape"]],
  "patterns.row": [PROJECT_ID, [SHAPE_ID], 2, 1],
  "patterns.ring": [PROJECT_ID, [SHAPE_ID], 2, { x: 0, z: 0 }],
};
const PY_METHOD_ARGUMENTS: Record<string, unknown[]> = {
  "projects.get": [PROJECT_ID],
  "projects.find_by_name": ["Parity project"],
  "projects.list_page": [10, "next-page"],
  "shapes.list_page": [PROJECT_ID, 10, "next-page"],
  "shapes.create_many": [PROJECT_ID, [{ kind: "box", width: 1, depth: 1, height: 1 }]],
  "edges.filletable_indexes": [PROJECT_ID, SHAPE_ID],
  "faces.facing": [PROJECT_ID, SHAPE_ID, "top"],
  "faces.ids_facing": [PROJECT_ID, SHAPE_ID, "top"],
  "treatments.fillet": [PROJECT_ID, SHAPE_ID, 1],
  "treatments.chamfer": [PROJECT_ID, SHAPE_ID, 1],
  "shell.hollow": [PROJECT_ID, SHAPE_ID, 1],
  "shell.tray": [PROJECT_ID, SHAPE_ID, 1],
  "align.tops": [PROJECT_ID, [SHAPE_ID, "other-shape"]],
  "align.bottoms": [PROJECT_ID, [SHAPE_ID, "other-shape"]],
  "align.centers": [PROJECT_ID, [SHAPE_ID, "other-shape"], "x"],
  "distribute.gaps": [PROJECT_ID, [SHAPE_ID, "other-shape", "third-shape"]],
  "distribute.pitch": [PROJECT_ID, [SHAPE_ID, "other-shape", "third-shape"]],
  "patterns.row": [PROJECT_ID, [SHAPE_ID], 2, 1],
  "patterns.ring": [PROJECT_ID, [SHAPE_ID], 2, [0, 0]],
  "imports.file": [PROJECT_ID],
  "imports.apply": [PROJECT_ID, "mesh.stl", "fixture", "model/stl"],
  "exports.file": [PROJECT_ID, "stl"],
};

type CapturedRequest = { method: string; pathname: string; query?: string; body?: string | null };

function operationLookup() {
  return new Map(API_V1_OPERATIONS.map((operation) => [operation.operationId, operation]));
}

async function captureTypeScriptDeleteAllRequests(): Promise<CapturedRequest[]> {
  const requests: CapturedRequest[] = [];
  const client = new SketchForgeClient({
    baseUrl: "http://parity.test",
    token: "test",
    fetch: async (input, init) => {
      const url = new URL(input);
      requests.push({ method: init?.method ?? "GET", pathname: url.pathname, query: url.search, body: typeof init?.body === "string" ? init.body : undefined });
      const body = url.pathname.endsWith("/shapes") && (init?.method ?? "GET") === "GET"
        ? JSON.stringify({ shapes: [{ id: SHAPE_ID, locked: true }] })
        : "{}";
      return new Response(body, { status: 200 });
    },
  });
  await client.shapes.deleteAll(PROJECT_ID);
  return requests;
}

async function captureTypeScriptRequests(): Promise<CapturedRequest[]> {
  const requests: CapturedRequest[] = [];
  const client = new SketchForgeClient({
    baseUrl: "http://parity.test",
    token: "test",
    fetch: async (input, init) => {
      const url = new URL(input);
      requests.push({ method: init?.method ?? "GET", pathname: url.pathname, query: url.search });
      return new Response("{}", { status: 200 });
    },
  });
  const lookup = operationLookup();
  for (const [resourceName, operationMap] of Object.entries(CLIENT_RESOURCE_OPERATIONS)) {
    const resource = (client as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[resourceName];
    for (const [operationId, methodNames] of Object.entries(operationMap)) {
      const operation = lookup.get(operationId);
      for (const methodName of methodNames as readonly string[]) {
        const before = requests.length;
        try {
          await resource[methodName](...(TS_METHOD_ARGUMENTS[`${resourceName}.${methodName}`] ?? CALL_ARGUMENTS[operationId] ?? []));
        } catch {
          // Response decoding is incidental here; the real HTTP request is the assertion target.
        }
        expect(requests.slice(before), `TypeScript ${resourceName}.${methodName} should call ${operationId}`).toHaveLength(1);
        expect({ method: requests[before]?.method, pathname: requests[before]?.pathname }, `TypeScript ${resourceName}.${methodName} request`).toEqual({ method: operation?.method, pathname: operation?.path });
        if (resourceName === "projects" && methodName === "get") expect(requests[before]?.query).toContain("projectId=parity-project");
        if (resourceName === "projects" && methodName === "listPage") {
          expect(requests[before]?.query).toContain("limit=10");
          expect(requests[before]?.query).toContain("cursor=next-page");
        }
        if (resourceName === "shapes" && methodName === "listPage") {
          expect(requests[before]?.query).toContain("limit=10");
          expect(requests[before]?.query).toContain("cursor=next-page");
        }
      }
    }
  }
  return requests;
}

function capturePythonRequests(): { requests: CapturedRequest[]; calls: { resource: string; method: string; requestCount: number; queries: string[] }[]; compositeRequests: CapturedRequest[] } {
  const python = process.platform === "win32" ? "python" : "python3";
  const source = [
    "import json, tempfile, urllib.parse",
    "from sketchforge3d.client import CLIENT_RESOURCE_OPERATIONS, SketchForgeClient",
    "class Reply:",
    "    def __init__(self, body=b'{}'): self.body = body",
    "    def __enter__(self): return self",
    "    def __exit__(self, *args): return False",
    "    def read(self): return self.body",
    "class Opener:",
    "    def __init__(self): self.requests = []",
    "    def open(self, request, timeout=None):",
    "        parsed = urllib.parse.urlsplit(request.full_url)",
    "        self.requests.append({'method': request.get_method(), 'pathname': parsed.path, 'query': parsed.query, 'body': request.data.decode() if request.data else None})",
    "        if parsed.path == '/api/v1/shapes' and request.get_method() == 'GET': return Reply(b'{\"shapes\":[{\"id\":\"parity-shape\",\"locked\":true}]}')",
    "        return Reply()",
    "opener = Opener()",
    "client = SketchForgeClient('http://parity.test', 'test', opener=opener)",
    "calls = []",
    "arguments = json.loads(__import__('sys').argv[1])",
    "for resource_name, operation_map in CLIENT_RESOURCE_OPERATIONS.items():",
    "    for operation_id, method_names in operation_map.items():",
    "        for method_name in method_names:",
    "            call_args = arguments.get(resource_name + '.' + method_name, arguments.get(operation_id, []))",
    "            before = len(opener.requests)",
    "            try:",
    "                if resource_name == 'imports' and method_name == 'file':",
    "                    with tempfile.NamedTemporaryFile(suffix='.stl') as fixture: getattr(getattr(client, resource_name), method_name)(call_args[0], fixture.name)",
    "                elif resource_name == 'imports' and method_name == 'apply': getattr(getattr(client, resource_name), method_name)(call_args[0], call_args[1], b'fixture', call_args[3])",
    "                elif resource_name == 'exports' and method_name == 'file':",
    "                    with tempfile.NamedTemporaryFile(suffix='.stl') as fixture: getattr(getattr(client, resource_name), method_name)(call_args[0], call_args[1], fixture.name)",
    "                else: getattr(getattr(client, resource_name), method_name)(*call_args)",
    "            except Exception: pass",
    "            calls.append({'resource': resource_name, 'method': method_name, 'requestCount': len(opener.requests) - before, 'queries': [request['query'] for request in opener.requests[before:]]})",
    "composite_opener = Opener()",
    "composite_client = SketchForgeClient('http://parity.test', 'test', opener=composite_opener)",
    "composite_client.shapes.delete_all('parity-project')",
    "print(json.dumps({'requests': opener.requests, 'calls': calls, 'compositeRequests': composite_opener.requests}))",
  ].join("\n");
  const output = execFileSync(python, ["-c", source, JSON.stringify({ ...PYTHON_CALL_ARGUMENTS, ...PY_METHOD_ARGUMENTS })], {
    cwd: path.join(root, "packages/sketchforge-py"),
    env: { ...process.env, PYTHONPATH: "src" },
    encoding: "utf8",
  });
  return JSON.parse(output) as { requests: CapturedRequest[]; calls: { resource: string; method: string; requestCount: number; queries: string[] }[]; compositeRequests: CapturedRequest[] };
}

function captureMcpRequest(toolName: string, args: Record<string, unknown>, filesDir: string): CapturedRequest[] {
  const serverPath = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
  const spyPath = path.join(root, "tests/unit/support/mcp-rest-fetch-spy.mjs");
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: { ...args, url: "http://parity.test" } } })}\n`;
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(spyPath).href, serverPath], {
    input,
    encoding: "utf8",
    env: { ...process.env, SKETCHFORGE_API_TOKEN: "test", SKETCHFORGE_MCP_FILES_DIR: filesDir },
  });
  expect(result.status, `MCP ${toolName} handler should exit cleanly: ${result.stderr}`).toBe(0);
  return result.stderr.split("\n")
    .filter((line) => line.startsWith("SKETCHFORGE_TEST_REQUEST "))
    .map((line) => JSON.parse(line.slice("SKETCHFORGE_TEST_REQUEST ".length)) as CapturedRequest);
}

function listRuntimeMcpTools(): string[] {
  const serverPath = path.join(root, "packages/sketchforge-client/mcp/server.mjs");
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`;
  const result = spawnSync(process.execPath, [serverPath], { input, encoding: "utf8" });
  expect(result.status, `MCP tools/list should exit cleanly: ${result.stderr}`).toBe(0);
  const response = JSON.parse(result.stdout) as { result: { tools: { name: string }[] } };
  return response.result.tools.map(({ name }) => name);
}

describe("REST client operation parity", () => {
  it("derives the client matrix from the REST registry and each client's resource list", async () => {
    const operations = API_V1_OPERATIONS.filter(({ method }) => method !== "OPTIONS");
    const registered = new Set(operations.map(({ operationId }) => operationId));
    const tsClient = new SketchForgeClient({ baseUrl: "http://localhost", token: "test" });
    const tsResources = Object.keys(tsClient)
      .filter((name) => name !== "transport");
    const py = pythonResources();
    const mcpToolNames = new Set(listRuntimeMcpTools());
    const matrices = {
      typescript: declaredOperationIds(CLIENT_RESOURCE_OPERATIONS),
      python: declaredOperationIds(py.operations),
      mcp: Object.entries(MCP_RESOURCE_OPERATIONS)
        .filter(([tool]) => mcpToolNames.has(tool))
        .flatMap(([, operationIds]) => operationIds),
    };

    expect(Object.keys(CLIENT_RESOURCE_OPERATIONS).sort()).toEqual(tsResources.sort());
    expect(Object.keys(py.operations).sort()).toEqual(py.resources.sort());
    expect(CLIENT_COMPOSITE_RESOURCE_OPERATIONS.shapes.deleteAll).toEqual(["listShapes", "updateShape", "deleteShape"]);
    expect(typeof tsClient.shapes.deleteAll).toBe("function");
    expect(py.compositeOperations.shapes.delete_all).toEqual(["listShapes", "updateShape", "deleteShape"]);
    expect(py.methods.shapes).toContain("delete_all");
    const expectedSecondaryMethods = {
      typescript: { projects: ["listPage", "get", "findByName"], shapes: ["listPage", "createMany"], edges: ["filletableIndexes"], faces: ["facing"], measurements: ["withRadius"], treatments: ["fillet", "chamfer"], shell: ["hollow", "tray"], align: ["tops", "bottoms", "centers"], distribute: ["gaps", "pitch"], patterns: ["row", "ring"], drawings: ["section", "dxf"] },
      python: { projects: ["list_page", "get", "find_by_name"], shapes: ["list_page", "create_many"], edges: ["filletable_indexes"], faces: ["facing", "ids_facing"], measurements: ["with_radius"], treatments: ["fillet", "chamfer"], shell: ["hollow", "tray"], align: ["tops", "bottoms", "centers"], distribute: ["gaps", "pitch"], patterns: ["row", "ring"], imports: ["file"], exports: ["file"] },
    } as const;
    for (const [resourceName, methods] of Object.entries(expectedSecondaryMethods.typescript)) {
      const mapped = Object.values(CLIENT_RESOURCE_OPERATIONS[resourceName as keyof typeof CLIENT_RESOURCE_OPERATIONS]).flat();
      expect(mapped, `TypeScript ${resourceName} secondary route methods`).toEqual(expect.arrayContaining([...methods]));
    }
    for (const [resourceName, methods] of Object.entries(expectedSecondaryMethods.python)) {
      const operationMap = py.operations[resourceName] as Record<string, string[]>;
      expect(Object.values(operationMap).flat(), `Python ${resourceName} secondary route methods`).toEqual(expect.arrayContaining([...methods]));
    }
    const restBackedTools = Object.keys(MCP_RESOURCE_OPERATIONS);
    const nonRestTools = Object.keys(MCP_NON_REST_TOOL_REASONS);
    expect([...restBackedTools, ...nonRestTools].sort()).toEqual([...mcpToolNames].sort());
    expect(restBackedTools.filter((tool) => nonRestTools.includes(tool))).toEqual([]);
    expect(Object.values(MCP_NON_REST_TOOL_REASONS).every((reason) => reason.trim().length > 0)).toBe(true);
    expect(Object.values(MCP_UNSUPPORTED_OPERATIONS).every((reason) => reason.trim().length > 0)).toBe(true);

    for (const [resourceName, operationMap] of Object.entries(CLIENT_RESOURCE_OPERATIONS)) {
      const resource = (tsClient as unknown as Record<string, Record<string, unknown>>)[resourceName];
      for (const [operationId, methodNames] of Object.entries(operationMap)) {
        expect(Array.isArray(methodNames), `TypeScript ${resourceName}.${operationId} must name callable methods`).toBe(true);
        expect(methodNames.length, `TypeScript ${resourceName}.${operationId} must identify route methods`).toBeGreaterThan(0);
        for (const methodName of methodNames as string[]) {
          expect(typeof resource[methodName], `TypeScript ${resourceName}.${methodName} for ${operationId}`).toBe("function");
        }
      }
    }

    for (const [resourceName, operationMap] of Object.entries(py.operations)) {
      const methods = new Set(py.methods[resourceName]);
      expect(operationMap && typeof operationMap === "object", `Python ${resourceName} must map operations to methods`).toBe(true);
      for (const [operationId, methodNames] of Object.entries(operationMap as Record<string, unknown>)) {
        expect(Array.isArray(methodNames), `Python ${resourceName}.${operationId} must name callable methods`).toBe(true);
        expect((methodNames as unknown[]).length, `Python ${resourceName}.${operationId} must identify route methods`).toBeGreaterThan(0);
        for (const methodName of methodNames as string[]) {
          expect(methods.has(methodName), `Python ${resourceName}.${methodName} for ${operationId}`).toBe(true);
        }
      }
    }

    const apiBackedTools = restBackedTools;

    const operationById = operationLookup();
    const pythonExpected = Object.values(py.operations).flatMap((operationMap) =>
      Object.entries(operationMap as Record<string, string[]>).flatMap(([operationId, methods]) => methods.map(() => {
        const operation = operationById.get(operationId)!;
        return { method: operation.method, pathname: operation.path };
      })),
    );
    const typeScriptRequests = await captureTypeScriptRequests();
    const tsExpectedCount = Object.values(CLIENT_RESOURCE_OPERATIONS).flatMap((operationMap) => Object.values(operationMap)).reduce((sum, methods) => sum + methods.length, 0);
    expect(typeScriptRequests).toHaveLength(tsExpectedCount);
    const pythonCaptured = capturePythonRequests();
    for (const call of pythonCaptured.calls) {
      expect(call.requestCount, `Python ${call.resource}.${call.method} should emit exactly one REST request`).toBe(1);
    }
    for (const resource of ["projects", "shapes"]) {
      const call = pythonCaptured.calls.find((candidate) => candidate.resource === resource && candidate.method === "list_page");
      expect(call?.queries[0], `Python ${resource}.list_page limit`).toContain("limit=10");
      expect(call?.queries[0], `Python ${resource}.list_page cursor`).toContain("cursor=next-page");
    }
    expect(pythonCaptured.requests.map(({ method, pathname }) => ({ method, pathname }))).toEqual(pythonExpected);
    expect(pythonCaptured.requests.find(({ query }) => query?.includes("projectId=parity-project"))).toBeDefined();
    expect(pythonCaptured.requests.find(({ query }) => query?.includes("limit=10"))).toBeDefined();
    expect(pythonCaptured.requests.find(({ query }) => query?.includes("cursor=next-page"))).toBeDefined();

    const deleteAllOperationIds = CLIENT_COMPOSITE_RESOURCE_OPERATIONS.shapes.deleteAll;
    const deleteAllExpected = deleteAllOperationIds.map((operationId) => {
      const operation = operationById.get(operationId)!;
      return { method: operation.method, pathname: operation.path };
    });
    const typeScriptDeleteAll = await captureTypeScriptDeleteAllRequests();
    expect(typeScriptDeleteAll.map(({ method, pathname }) => ({ method, pathname }))).toEqual(deleteAllExpected);
    expect(typeScriptDeleteAll[0]?.query).toContain("projectId=parity-project");
    expect(typeScriptDeleteAll[1]?.query).toContain("projectId=parity-project");
    expect(typeScriptDeleteAll[1]?.query).toContain("shapeId=parity-shape");
    expect(JSON.parse(typeScriptDeleteAll[1]?.body ?? "{}")).toEqual({ locked: false });
    expect(typeScriptDeleteAll[2]?.query).toContain("projectId=parity-project");
    expect(typeScriptDeleteAll[2]?.query).toContain("shapeId=parity-shape");
    expect(typeScriptDeleteAll[0]?.body).toBeUndefined();
    expect(typeScriptDeleteAll[2]?.body).toBeUndefined();
    expect(pythonCaptured.compositeRequests.map(({ method, pathname }) => ({ method, pathname }))).toEqual(deleteAllExpected);
    expect(pythonCaptured.compositeRequests[0]?.query).toContain("projectId=parity-project");
    expect(pythonCaptured.compositeRequests[1]?.query).toContain("projectId=parity-project");
    expect(pythonCaptured.compositeRequests[1]?.query).toContain("shapeId=parity-shape");
    expect(JSON.parse(pythonCaptured.compositeRequests[1]?.body ?? "{}")).toEqual({ locked: false });
    expect(pythonCaptured.compositeRequests[2]?.query).toContain("projectId=parity-project");
    expect(pythonCaptured.compositeRequests[2]?.query).toContain("shapeId=parity-shape");
    expect(pythonCaptured.compositeRequests[0]?.body).toBeNull();
    expect(pythonCaptured.compositeRequests[2]?.body).toBeNull();

    const filesDir = mkdtempSync(path.join(tmpdir(), "sketchforge-client-parity-"));
    try {
      const importPath = path.join(filesDir, "parity.stl");
      writeFileSync(importPath, "fixture");
      const mcpArgs: Record<string, Record<string, unknown>> = {
        sketchforge_mirror_baked: { projectId: PROJECT_ID, ids: [SHAPE_ID], axis: "x" },
        sketchforge_import_file: { projectId: PROJECT_ID, filePath: importPath },
        sketchforge_explode_step_assembly: { projectId: PROJECT_ID, shapeId: SHAPE_ID },
        sketchforge_list_faces: { projectId: PROJECT_ID, shapeId: SHAPE_ID },
        sketchforge_measure_shape: { projectId: PROJECT_ID, shapeId: SHAPE_ID },
        sketchforge_shape_properties: { projectId: PROJECT_ID, shapeId: SHAPE_ID },
        sketchforge_estimate_wall_thickness: { projectId: PROJECT_ID, shapeId: SHAPE_ID },
        sketchforge_measure_between: { projectId: PROJECT_ID, from: { shapeId: SHAPE_ID }, to: { shapeId: "other-shape" } },
        sketchforge_hollow_shape: { projectId: PROJECT_ID, shapeId: SHAPE_ID, thickness: 1 },
        sketchforge_project_view: { projectId: PROJECT_ID, view: "front" },
        sketchforge_section_view: { projectId: PROJECT_ID, plane: "xy", offset: 0 },
        sketchforge_export_scene: { projectId: PROJECT_ID, format: "svg" },
        sketchforge_check_interference: { projectId: PROJECT_ID, ids: [SHAPE_ID] },
      };
      for (const toolName of apiBackedTools) {
        const actual = captureMcpRequest(toolName, mcpArgs[toolName] ?? {}, filesDir);
        const expected = MCP_RESOURCE_OPERATIONS[toolName].map((operationId) => {
          const operation = operationById.get(operationId)!;
          return { method: operation.method, pathname: operation.path };
        });
        expect(actual, `MCP ${toolName} should emit the REST operation in its inventory`).toEqual(expected);
      }
    } finally {
      rmSync(filesDir, { recursive: true, force: true });
    }

    for (const client of ["typescript", "python", "mcp"] as const) {
      const implemented = new Set(matrices[client]);
      expect([...implemented].filter((operationId) => !registered.has(operationId)), `${client} declares unknown REST operations`).toEqual([]);
      const missing = [...registered].filter((operationId) => !implemented.has(operationId)).sort();
      const documentedGaps = client === "mcp" ? Object.keys(MCP_UNSUPPORTED_OPERATIONS).sort() : [];
      expect(missing, `${client} operations missing from its resources`).toEqual(documentedGaps);
    }
  });
});
