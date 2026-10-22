import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const outputPath = path.join(root, "docs/mcp/TOOLS_REFERENCE.md");

export async function listRuntimeTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["packages/sketchforge-client/mcp/server.mjs"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(output.trim());
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result.tools);
      } catch (error) {
        reject(new Error(`MCP tools/list did not return JSON: ${errors || output || error}`));
      }
    });
  });
}

export function renderReference(tools) {
  const sections = tools.map((tool) => [
    `## ${tool.name}`,
    "",
    "### Description",
    "",
    tool.description,
    "",
    "### Input schema",
    "",
    "```json",
    JSON.stringify(tool.inputSchema, null, 2),
    "```",
  ].join("\n"));
  return [
    "---",
    "slug: /docs/mcp/TOOLS_REFERENCE",
    "title: MCP tool reference",
    "audience: MCP users",
    "owner: MCP",
    "sources:",
    "  - packages/sketchforge-client/mcp/**",
    "---",
    "",
    "# MCP tool reference",
    "",
    "Generated from the running `tools/list` registry in `packages/sketchforge-client/mcp/server.mjs`.",
    "Regenerate with `node scripts/generate-mcp-reference.mjs`; `--check` verifies that this file matches the current public registry.",
    "",
    `The server currently exposes ${tools.length} tools. Input schemas below are the exact JSON Schema values advertised over MCP.`,
    "",
    ...sections,
    "",
  ].join("\n");
}

const check = process.argv.includes("--check");
const tools = await listRuntimeTools();
const content = renderReference(tools);
if (check) {
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    throw new Error(`${path.relative(root, outputPath)} is missing; run node scripts/generate-mcp-reference.mjs`);
  }
  if (current !== content) {
    throw new Error(`${path.relative(root, outputPath)} is stale; run node scripts/generate-mcp-reference.mjs`);
  }
  console.log("MCP tool reference matches the running tools/list registry.");
} else {
  await writeFile(outputPath, content);
  console.log(`Generated ${path.relative(root, outputPath)} from ${tools.length} MCP tools.`);
}
