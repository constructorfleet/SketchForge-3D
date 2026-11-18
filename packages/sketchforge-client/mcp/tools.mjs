import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveMcpReadPath, resolveMcpWritePath } from "./filesystemPaths.mjs";
import { listMacros, macroTools, runMacroByName } from "./macroTools.mjs";
import { callLocalEngineTool } from "./localEngine.mjs";
import { engineTools } from "./toolCatalog.mjs";

const MCP_ROUTE = "/api/sketchforge-mcp";

export const tools = [
  ...engineTools,
  // Macros run only from the directory the operator configured.
  ...macroTools,
];

const API_TOKEN_ENV = "SKETCHFORGE_API_TOKEN";

/**
 * One request to the headless REST API, as the operator's token.
 *
 * The editor bridge cannot serve every tool here: hollowing is a server-side
 * OCCT operation on a stored project, with no editor tab involved and nothing
 * to ask one for. The token is the same one the server was started with, and
 * without it every route answers 404 rather than saying it is switched off.
 */
async function restRequest(method, path, { query = {}, body, baseUrl } = {}) {
  const token = process.env[API_TOKEN_ENV];
  if (!token) {
    throw new Error(
      `${API_TOKEN_ENV} is not set. It is the same token the SketchForge server was started with; without it the REST API answers 404 to everything.`,
    );
  }
  const url = new URL(`/api/v1${path}`, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // The sentence is for whoever reads the log; the code is the half a client
    // can act on, so carry both rather than flattening to a status.
    throw new Error(
      payload?.error
        ? `${payload.error}${payload.code ? ` [${payload.code}]` : ""}`
        : `SketchForge API returned HTTP ${response.status}`,
    );
  }
  return payload;
}

function bridgeUrl(baseUrl) {
  return new URL(MCP_ROUTE, baseUrl);
}

async function bridgeGet(baseUrl) {
  const response = await fetch(bridgeUrl(baseUrl));
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `SketchForge bridge returned HTTP ${response.status}`);
  }
  return payload;
}

async function bridgeCommand(action, args = {}, defaultTimeoutMs = 15000, baseUrl) {
  const { editorNumber, editorId, timeoutMs, url, ...params } = args || {};
  let targetNumber = typeof editorNumber === "number" ? editorNumber : undefined;
  let targetId = typeof editorId === "string" ? editorId : undefined;

  if (!targetNumber && !targetId) {
    const { editors = [] } = await bridgeGet(baseUrl);
    if (editors.length === 1) {
      targetNumber = editors[0].editorNumber;
    } else {
      throw new Error(editors.length === 0 ? "No open SketchForge editors found" : "Provide editorNumber because multiple SketchForge editors are open");
    }
  }

  const response = await fetch(bridgeUrl(baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "command",
      editorNumber: targetNumber,
      editorId: targetId,
      action,
      params,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : defaultTimeoutMs,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!payload?.ok) {
    throw new Error(payload?.error || `SketchForge command failed with HTTP ${response.status}`);
  }
  return payload.data;
}

async function callRemoteTool(name, args, baseUrl) {
  switch (name) {
    case "sketchforge_list_editors":
      return bridgeGet(baseUrl);
    case "sketchforge_read_scene":
      return bridgeCommand("get_scene", args, 15000, baseUrl);
    case "sketchforge_list_objects":
      return bridgeCommand("list_objects", args, 15000, baseUrl);
    case "sketchforge_select_objects":
      return bridgeCommand("select_objects", args, 15000, baseUrl);
    case "sketchforge_mirror_objects":
      return bridgeCommand("mirror_objects", args, 15000, baseUrl);
    case "sketchforge_mirror_baked":
      return restRequest("POST", "/mirrors", {
        query: { projectId: args.projectId },
        body: { ids: args.ids, axis: args.axis },
        baseUrl,
      });
    case "sketchforge_delete_objects":
      return bridgeCommand("delete_objects", args, 15000, baseUrl);
    case "sketchforge_create_shape":
      return bridgeCommand("create_shape", args, 15000, baseUrl);
    case "sketchforge_import_mesh":
      return bridgeCommand("import_mesh", args, 60000, baseUrl);
    case "sketchforge_import_file": {
      const sourcePath = await resolveMcpReadPath(args.filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      const mediaType = extension === ".stl" ? "model/stl" : extension === ".obj" ? "model/obj" : extension === ".svg" ? "image/svg+xml" : undefined;
      if (!mediaType) throw new Error("filePath must point to an .stl, .obj, or .svg file.");
      const bytes = readFileSync(sourcePath);
      return restRequest("POST", "/imports", {
        query: { projectId: args.projectId },
        body: { fileName: path.basename(sourcePath), data: bytes.toString("base64"), mediaType },
        baseUrl,
      });
    }
    case "sketchforge_update_object":
      return bridgeCommand("update_object", args, 15000, baseUrl);
    case "sketchforge_align_objects":
      return bridgeCommand("align_objects", args, 15000, baseUrl);
    case "sketchforge_distribute_objects":
      return bridgeCommand("distribute_objects", args, 15000, baseUrl);
    case "sketchforge_pattern_objects":
      return bridgeCommand("pattern_objects", args, 15000, baseUrl);
    case "sketchforge_group_objects":
      return bridgeCommand("group_objects", args, 30000, baseUrl);
    case "sketchforge_ungroup_objects":
      return bridgeCommand("ungroup_objects", args, 15000, baseUrl);
    case "sketchforge_boolean_cut":
      return bridgeCommand("boolean_cut", args, 45000, baseUrl);
    case "sketchforge_separate_parts":
      return bridgeCommand("separate_parts", args, 15000, baseUrl);
    case "sketchforge_explode_step_assembly":
      return restRequest("POST", "/explode", { query: { projectId: args.projectId, shapeId: args.shapeId }, body: {}, baseUrl });
    case "sketchforge_list_edges":
      return bridgeCommand("list_edges", args, 30000, baseUrl);
    case "sketchforge_apply_edge_treatment":
      return bridgeCommand("apply_edge_treatment", args, 60000, baseUrl);
    case "sketchforge_list_faces":
      return restRequest("GET", "/faces", { query: { projectId: args.projectId, shapeId: args.shapeId }, baseUrl });
    case "sketchforge_measure_shape":
      return restRequest("GET", "/measurements", { query: { projectId: args.projectId, shapeId: args.shapeId }, baseUrl });
    case "sketchforge_shape_properties":
      return restRequest("GET", "/properties", { query: { projectId: args.projectId, shapeId: args.shapeId }, baseUrl });
    case "sketchforge_estimate_wall_thickness":
      return restRequest("GET", "/thickness", { query: { projectId: args.projectId, shapeId: args.shapeId }, baseUrl });
    case "sketchforge_measure_between":
      return restRequest("POST", "/measurements", {
        query: { projectId: args.projectId },
        body: { from: args.from, to: args.to },
        baseUrl,
      });
    case "sketchforge_hollow_shape":
      return restRequest("POST", "/shell", {
        query: { projectId: args.projectId, shapeId: args.shapeId },
        body: {
          thickness: args.thickness,
          ...(args.openFaces === undefined ? {} : { openFaces: args.openFaces }),
        },
        baseUrl,
      });
    case "sketchforge_inspect_errors":
      return bridgeCommand("inspect_errors", args, 15000, baseUrl);
    case "sketchforge_capture_image":
      return bridgeCommand("capture_image", args, 30000, baseUrl);
    case "sketchforge_project_view": {
      const artifact = await restRequest("POST", "/exports", {
        query: { projectId: args.projectId },
        body: {
          format: "svg",
          ...(args.view === undefined ? {} : { view: args.view }),
          ...(args.featureAngle === undefined ? {} : { featureAngle: args.featureAngle }),
          ...(args.shapeIds === undefined ? {} : { shapeIds: args.shapeIds }),
          ...(args.name === undefined ? {} : { name: args.name }),
        },
        baseUrl,
      });
      const bytes = Buffer.from(artifact.base64, "base64");
      const response = { view: args.view ?? "multiview", filename: artifact.filename, mimeType: artifact.mimeType, bytes: artifact.bytes, shapeCount: artifact.shapeCount };
      if (typeof args.outputPath === "string" && args.outputPath.trim()) {
        const destination = await resolveMcpWritePath(args.outputPath, { overwrite: args.overwrite === true });
        writeFileSync(destination, bytes, { flag: args.overwrite === true ? "w" : "wx" });
        return { ...response, savedTo: path.resolve(args.outputPath) };
      }
      return { ...response, svg: bytes.toString("utf8") };
    }
    case "sketchforge_section_view": {
      const artifact = await restRequest("POST", "/exports", {
        query: { projectId: args.projectId },
        body: {
          format: "svg",
          section: { plane: args.plane, offset: args.offset },
          ...(args.shapeIds === undefined ? {} : { shapeIds: args.shapeIds }),
          ...(args.name === undefined ? {} : { name: args.name }),
        },
        baseUrl,
      });
      const bytes = Buffer.from(artifact.base64, "base64");
      const response = { plane: args.plane, offset: args.offset, filename: artifact.filename, mimeType: artifact.mimeType, bytes: artifact.bytes, shapeCount: artifact.shapeCount };
      if (typeof args.outputPath === "string" && args.outputPath.trim()) {
        const destination = await resolveMcpWritePath(args.outputPath, { overwrite: args.overwrite === true });
        writeFileSync(destination, bytes, { flag: args.overwrite === true ? "w" : "wx" });
        return { ...response, savedTo: path.resolve(args.outputPath) };
      }
      return { ...response, svg: bytes.toString("utf8") };
    }
    case "sketchforge_export_scene": {
      // An SVG is drawn on the server from the stored project; the editor
      // bridge has no such export, so this one takes the REST path.
      const artifact = args.format === "svg" || args.format === "dxf"
        ? await restRequest("POST", "/exports", {
          query: { projectId: args.projectId },
          body: {
            format: args.format,
            ...(args.view === undefined ? {} : { view: args.view }),
            ...(args.section === undefined ? {} : { section: args.section }),
            ...(args.shapeIds === undefined ? {} : { shapeIds: args.shapeIds }),
            ...(args.name === undefined ? {} : { name: args.name }),
          },
          baseUrl,
        })
        : await bridgeCommand("export_scene", args, 60000, baseUrl);
      if (typeof args.outputPath === "string" && args.outputPath.trim()) {
        const destination = await resolveMcpWritePath(args.outputPath, { overwrite: args.overwrite === true });
        writeFileSync(destination, Buffer.from(artifact.base64, "base64"), { flag: args.overwrite === true ? "w" : "wx" });
        return { filename: artifact.filename, mimeType: artifact.mimeType, bytes: artifact.bytes, shapeCount: artifact.shapeCount, savedTo: path.resolve(args.outputPath) };
      }
      return artifact;
    }
    case "sketchforge_validate_scene":
      return bridgeCommand("validate_scene", args, 60000, baseUrl);
    case "sketchforge_check_interference":
      return restRequest("POST", "/interference", {
        query: { projectId: args.projectId },
        body: { ...(Array.isArray(args.ids) && args.ids.length ? { ids: args.ids } : {}), ...(args.clearance === undefined ? {} : { clearance: args.clearance }) },
        baseUrl,
      });
    case "sketchforge_list_macros":
      return listMacros();
    case "sketchforge_run_macro":
      return runMacroByName(args, { environment: { ...process.env, SKETCHFORGE_URL: baseUrl } });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function normalizedServerUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be an absolute http:// or https:// SketchForge server URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("url must be an absolute http:// or https:// SketchForge server URL without embedded credentials.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export async function callTool(name, args = {}) {
  const { url, ...toolArgs } = args || {};
  if (name === "sketchforge_import_stl" && typeof url === "string" && url.trim()) {
    throw new Error("sketchforge_import_stl is only available in local mode; omit url.");
  }
  if (["sketchforge_list_projects", "sketchforge_create_project", "sketchforge_import_project"].includes(name) && typeof url === "string" && url.trim()) {
    throw new Error(`${name} is only available in local mode; omit url.`);
  }
  if (typeof url === "string" && url.trim()) {
    return callRemoteTool(name, toolArgs, normalizedServerUrl(url.trim()));
  }
  if (name === "sketchforge_list_macros") return listMacros();
  if (name === "sketchforge_run_macro") return runMacroByName(toolArgs);
  return callLocalEngineTool(name, toolArgs);
}
