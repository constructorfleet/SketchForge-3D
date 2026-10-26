import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";
import { CLIENT_RESOURCE_OPERATIONS, SketchForgeClient } from "../../packages/sketchforge-client/src/client.js";
import { MCP_RESOURCE_OPERATIONS, MCP_UNSUPPORTED_OPERATIONS } from "../../packages/sketchforge-client/mcp/operation-parity.mjs";

const root = process.cwd();

function pythonResources(): { resources: string[]; operations: Record<string, string[]> } {
  const python = process.platform === "win32" ? "python" : "python3";
  const source = [
    "import json",
    "from sketchforge3d.client import CLIENT_RESOURCE_OPERATIONS, SketchForgeClient",
    "client = SketchForgeClient('http://localhost', 'test')",
    "print(json.dumps({'resources': [key for key in vars(client) if not key.startswith('_')], 'operations': CLIENT_RESOURCE_OPERATIONS}))",
  ].join("; ");
  const output = execFileSync(python, ["-c", source], {
    cwd: path.join(root, "packages/sketchforge-py"),
    env: { ...process.env, PYTHONPATH: "src" },
    encoding: "utf8",
  });
  return JSON.parse(output) as { resources: string[]; operations: Record<string, string[]> };
}

describe("REST client operation parity", () => {
  it("derives the client matrix from the REST registry and each client's resource list", () => {
    const operations = API_V1_OPERATIONS.filter(({ method }) => method !== "OPTIONS");
    const registered = new Set(operations.map(({ operationId }) => operationId));
    const tsResources = Object.keys(new SketchForgeClient({ baseUrl: "http://localhost", token: "test" }))
      .filter((name) => name !== "transport");
    const py = pythonResources();
    const mcpToolNames = new Set(
      [...readFileSync(path.join(root, "packages/sketchforge-client/mcp/server.mjs"), "utf8").matchAll(/\bname:\s*"(sketchforge_[^"]+)"/g)]
        .map(([, name]) => name),
    );
    const matrices = {
      typescript: Object.values(CLIENT_RESOURCE_OPERATIONS).flat(),
      python: Object.values(py.operations).flat(),
      mcp: Object.entries(MCP_RESOURCE_OPERATIONS)
        .filter(([tool]) => mcpToolNames.has(tool))
        .flatMap(([, operationIds]) => operationIds),
    };

    expect(Object.keys(CLIENT_RESOURCE_OPERATIONS).sort()).toEqual(tsResources.sort());
    expect(Object.keys(py.operations).sort()).toEqual(py.resources.sort());
    expect(Object.keys(MCP_RESOURCE_OPERATIONS).filter((tool) => !mcpToolNames.has(tool))).toEqual([]);
    expect(Object.values(MCP_UNSUPPORTED_OPERATIONS).every((reason) => reason.trim().length > 0)).toBe(true);

    for (const client of ["typescript", "python", "mcp"] as const) {
      const implemented = new Set(matrices[client]);
      expect([...implemented].filter((operationId) => !registered.has(operationId)), `${client} declares unknown REST operations`).toEqual([]);
      const missing = [...registered].filter((operationId) => !implemented.has(operationId)).sort();
      const documentedGaps = client === "mcp" ? Object.keys(MCP_UNSUPPORTED_OPERATIONS).sort() : [];
      expect(missing, `${client} operations missing from its resources`).toEqual(documentedGaps);
    }
  });
});
