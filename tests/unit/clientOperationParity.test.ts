import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";
import { CLIENT_RESOURCE_OPERATIONS, SketchForgeClient } from "../../packages/sketchforge-client/src/client.js";
import { MCP_RESOURCE_OPERATIONS, MCP_UNSUPPORTED_OPERATIONS } from "../../packages/sketchforge-client/mcp/operation-parity.mjs";

const root = process.cwd();

function pythonResources(): {
  resources: string[];
  operations: Record<string, unknown>;
  methods: Record<string, string[]>;
} {
  const python = process.platform === "win32" ? "python" : "python3";
  const source = [
    "import json",
    "from sketchforge3d.client import CLIENT_RESOURCE_OPERATIONS, SketchForgeClient",
    "client = SketchForgeClient('http://localhost', 'test')",
    "resources = [key for key in vars(client) if not key.startswith('_')]",
    "methods = {key: [name for name in dir(getattr(client, key)) if not name.startswith('_') and callable(getattr(getattr(client, key), name))] for key in resources}",
    "print(json.dumps({'resources': resources, 'operations': CLIENT_RESOURCE_OPERATIONS, 'methods': methods}))",
  ].join("; ");
  const output = execFileSync(python, ["-c", source], {
    cwd: path.join(root, "packages/sketchforge-py"),
    env: { ...process.env, PYTHONPATH: "src" },
    encoding: "utf8",
  });
  return JSON.parse(output) as { resources: string[]; operations: Record<string, unknown>; methods: Record<string, string[]> };
}

function declaredOperationIds(resourceOperations: Record<string, unknown>): string[] {
  return Object.values(resourceOperations).flatMap((operations) =>
    operations && typeof operations === "object" ? Object.keys(operations) : [],
  );
}

describe("REST client operation parity", () => {
  it("derives the client matrix from the REST registry and each client's resource list", () => {
    const operations = API_V1_OPERATIONS.filter(({ method }) => method !== "OPTIONS");
    const registered = new Set(operations.map(({ operationId }) => operationId));
    const tsClient = new SketchForgeClient({ baseUrl: "http://localhost", token: "test" });
    const tsResources = Object.keys(tsClient)
      .filter((name) => name !== "transport");
    const py = pythonResources();
    const mcpToolNames = new Set(
      [...readFileSync(path.join(root, "packages/sketchforge-client/mcp/server.mjs"), "utf8").matchAll(/\bname:\s*"(sketchforge_[^"]+)"/g)]
        .map(([, name]) => name),
    );
    const matrices = {
      typescript: declaredOperationIds(CLIENT_RESOURCE_OPERATIONS),
      python: declaredOperationIds(py.operations),
      mcp: Object.entries(MCP_RESOURCE_OPERATIONS)
        .filter(([tool]) => mcpToolNames.has(tool))
        .flatMap(([, operationIds]) => operationIds),
    };

    expect(Object.keys(CLIENT_RESOURCE_OPERATIONS).sort()).toEqual(tsResources.sort());
    expect(Object.keys(py.operations).sort()).toEqual(py.resources.sort());
    expect(Object.keys(MCP_RESOURCE_OPERATIONS).filter((tool) => !mcpToolNames.has(tool))).toEqual([]);
    expect(Object.values(MCP_UNSUPPORTED_OPERATIONS).every((reason) => reason.trim().length > 0)).toBe(true);

    for (const [resourceName, operationMap] of Object.entries(CLIENT_RESOURCE_OPERATIONS)) {
      const resource = (tsClient as unknown as Record<string, Record<string, unknown>>)[resourceName];
      for (const [operationId, methodNames] of Object.entries(operationMap)) {
        expect(Array.isArray(methodNames), `TypeScript ${resourceName}.${operationId} must name callable methods`).toBe(true);
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
        for (const methodName of methodNames as string[]) {
          expect(methods.has(methodName), `Python ${resourceName}.${methodName} for ${operationId}`).toBe(true);
        }
      }
    }

    const serverSource = readFileSync(path.join(root, "packages/sketchforge-client/mcp/server.mjs"), "utf8");
    const toolCases = [...serverSource.matchAll(/case "(sketchforge_[^"]+)":/g)];
    const apiBackedTools = toolCases.filter((toolCase, index) => {
      const start = toolCase.index ?? 0;
      const end = toolCases[index + 1]?.index ?? serverSource.length;
      return serverSource.slice(start, end).includes("restRequest(");
    }).map(([, toolName]) => toolName);
    expect(apiBackedTools.filter((toolName) => !MCP_RESOURCE_OPERATIONS[toolName]?.length)).toEqual([]);

    for (const client of ["typescript", "python", "mcp"] as const) {
      const implemented = new Set(matrices[client]);
      expect([...implemented].filter((operationId) => !registered.has(operationId)), `${client} declares unknown REST operations`).toEqual([]);
      const missing = [...registered].filter((operationId) => !implemented.has(operationId)).sort();
      const documentedGaps = client === "mcp" ? Object.keys(MCP_UNSUPPORTED_OPERATIONS).sort() : [];
      expect(missing, `${client} operations missing from its resources`).toEqual(documentedGaps);
    }
  });
});
