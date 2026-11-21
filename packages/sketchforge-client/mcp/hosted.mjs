/**
 * Exposes stored-project tools over HTTP. Withholds editor tools, the
 * process-wide selection, macros, and `url` (server-side request forgery).
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { callLocalEngineTool } from "./localEngine.mjs";
import { createDispatcher } from "./protocol.mjs";
import { engineTools } from "./toolCatalog.mjs";
import { createStreamableHttpHandler } from "./streamableHttp.mjs";

const WITHHELD_TOOLS = new Set(["sketchforge_list_editors", "sketchforge_inspect_errors", "sketchforge_select_objects"]);
const WITHHELD_PROPERTIES = ["url", "editorNumber", "editorId", "timeoutMs"];

function withoutTargeting(tool) {
  const properties = { ...tool.inputSchema.properties };
  for (const property of WITHHELD_PROPERTIES) delete properties[property];
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

export const hostedTools = engineTools.filter(({ name }) => !WITHHELD_TOOLS.has(name)).map(withoutTargeting);

const hostedToolNames = new Set(hostedTools.map(({ name }) => name));

// Same rule as the engine's `apiProjectId`, untrimmed; this module loads before the engine.
// `apiProjectIdRule.test.ts` keeps the two in step.
export const HOSTED_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const PATH_ARGUMENTS = ["filePath", "outputPath"];

/** Resolves symlinks in the deepest ancestor that exists; the rest may not exist yet. */
function physicalPath(value) {
  let candidate = path.resolve(value);
  const missing = [];
  for (;;) {
    try {
      return path.join(realpathSync(candidate), ...missing);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Rejects host paths that could reach stored projects or their lock files. */
function requireSeparateFilesRoot() {
  const files = process.env.SKETCHFORGE_MCP_FILES_DIR?.trim();
  const projects = process.env.SKETCHFORGE_PROJECTS_DIR?.trim();
  if (files && projects) {
    const [filesRoot, projectsRoot] = [physicalPath(files), physicalPath(projects)];
    if (!contains(filesRoot, projectsRoot) && !contains(projectsRoot, filesRoot)) return;
  }
  throw new Error("filePath and outputPath need SKETCHFORGE_MCP_FILES_DIR set on the server to a directory apart from SKETCHFORGE_PROJECTS_DIR. Omit outputPath to receive an export in the result.");
}

export async function callHostedTool(name, args = {}) {
  if (!hostedToolNames.has(name)) throw new Error(`Unknown tool: ${name}`);
  const input = args ?? {};
  if (input.url !== undefined) throw new Error("url is not accepted here: this endpoint works on its own server's projects.");
  if (input.projectId !== undefined && !(typeof input.projectId === "string" && HOSTED_PROJECT_ID.test(input.projectId))) {
    throw new Error("projectId must be a project id from sketchforge_list_projects: letters, digits, hyphens and underscores.");
  }
  if (PATH_ARGUMENTS.some((key) => input[key] !== undefined)) requireSeparateFilesRoot();
  return callLocalEngineTool(name, input);
}

/** Builds the Streamable HTTP handler. Authorize each request before calling it. */
export function createHostedMcpHandler({ version } = {}) {
  return createStreamableHttpHandler({
    dispatch: createDispatcher({ tools: hostedTools, callTool: callHostedTool, version }),
  });
}
