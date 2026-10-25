import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";

/**
 * Drive the MCP server in local mode (no editor url) over stdio.
 *
 * Every message is sent in one run, so the server answers them concurrently;
 * calls that write the same project have to go in separate runs.
 */

const root = path.resolve(__dirname, "../../..");
const server = path.join(root, "packages/sketchforge-client/mcp/server.mjs");

export function runMcp(projectsDir: string, messages: Record<string, unknown>[]) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    ...messages,
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, SKETCHFORGE_PROJECTS_DIR: projectsDir, SKETCHFORGE_API_TOKEN: "", SKETCHFORGE_URL: "" },
    timeout: 120_000,
  });
  expect(run.status, run.stderr).toBe(0);
  const responses = run.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  return new Map(responses.map((response) => [response.id, response]));
}

/** A fresh projects directory holding one empty project, `case`; `cleanup` removes it. */
export function localProjects(prefix: string) {
  const directories: string[] = [];
  return {
    create() {
      const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      directories.push(projectsDir);
      fs.writeFileSync(path.join(projectsDir, "case.json"), JSON.stringify({ name: "Case", createdAt: 1, revision: 1 }));
      return projectsDir;
    },
    cleanup() {
      for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function listTools(projectsDir: string) {
  return runMcp(projectsDir, [{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]).get(2).result.tools as {
    name: string;
    description: string;
    inputSchema: { properties: Record<string, any> };
  }[];
}

export function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** One tool call in its own run, answered with its parsed JSON payload; fails the test on a tool error. */
export function callTool(projectsDir: string, name: string, args: Record<string, unknown>) {
  const result = runMcp(projectsDir, [toolCall(2, name, args)]).get(2)?.result;
  expect(result?.isError, result?.content?.[0]?.text).toBeUndefined();
  return JSON.parse(result.content[0].text);
}
