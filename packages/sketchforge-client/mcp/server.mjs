#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listMacros, macroTools, runMacroByName } from "./macroTools.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

/**
 * The version this bridge reports is the package's, read at startup rather than
 * written here: it ships inside `@constructorfleet/sketchforge3d`, whose version
 * tracks the app's, and a client that logs a hand-written number would say
 * something untrue after the first release.
 */
const version = (() => {
  try {
    const manifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const MCP_ROUTE = "/api/sketchforge-mcp";
const baseUrl = process.env.SKETCHFORGE_URL || DEFAULT_BASE_URL;

const editorTargetSchema = {
  type: "object",
  properties: {
    editorNumber: { type: "number", description: "The 5-digit SketchForge editor number from sketchforge_list_editors." },
    editorId: { type: "string", description: "Optional internal editor id. Prefer editorNumber for human-directed use." },
    timeoutMs: { type: "number", description: "Command timeout in milliseconds. Defaults to 15000." },
  },
};

const tools = [
  {
    name: "sketchforge_list_editors",
    description: "List SketchForge editor tabs that are currently open and heartbeating, including editorNumber and projectName.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sketchforge_read_scene",
    description: "Read the current scene, selection, workspace units, and exact object dimensions from an open SketchForge editor.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        includeRawShapes: { type: "boolean", description: "Include raw WorkplaneShape JSON. Can be large for imported meshes." },
      },
    },
  },
  {
    name: "sketchforge_list_objects",
    description: "List all current objects available in the editor with exact dimensions, position, rotation, and object ids.",
    inputSchema: editorTargetSchema,
  },
  {
    name: "sketchforge_select_objects",
    description: "Select objects by id in the SketchForge editor.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["ids"],
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "sketchforge_delete_objects",
    description: "Delete objects by id, or delete the current selection when ids are omitted.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" } },
        id: { type: "string" },
      },
    },
  },
  {
    name: "sketchforge_create_shape",
    description: "Create a box/cube, cylinder, loft, simple extruded sketch, revolve, or standard screw thread in SketchForge.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["kind"],
      properties: {
        ...editorTargetSchema.properties,
        kind: { type: "string", enum: ["box", "cube", "cylinder", "sketch", "loft", "revolve", "thread"] },
        profile: {
          type: "array",
          description: "For kind revolve: the closed outline to revolve, as [x, z] pairs. x is the distance from the axis, z runs along it. A triangle makes a thread, a rectangle a tube, a polygon a spring.",
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        },
        pitch: { type: "number", description: "For kind revolve/thread: axial rise per turn in mm. 0 is a plain revolve; negative is a left-hand thread." },
        turns: { type: "number", description: "For kind revolve/thread: how many full turns to sweep (default 8 for a thread)." },
        diameter: { type: "number", description: "For kind thread: outside diameter in mm, for a size the catalog does not list. The 60-degree ISO profile follows from this and the pitch." },
        length: { type: "number", description: "For kind thread: how long the thread should be in mm, instead of giving turns." },
        hole: { type: "boolean", description: "For kind thread: cut the form wider by a clearance so a bolt of that size fits, and mark the shape as a hole so grouping it with a solid taps that solid." },
        clearance: { type: "number", description: "For kind thread with hole: how much wider to cut, per side, in mm (default 0.2 for printed parts)." },
        startAngle: { type: "number", description: "For kind revolve: rotation the sweep starts at, in degrees." },
        sweepAngle: { type: "number", description: "For kind revolve with no pitch: how far round to revolve, in degrees (±360)." },
        name: { type: "string" },
        color: { type: "string" },
        x: { type: "number" },
        z: { type: "number" },
        elevation: { type: "number" },
        width: { type: "number", description: "For loft, this is the bottom end's width." },
        depth: { type: "number", description: "For loft, this is the bottom end's depth." },
        height: { type: "number" },
        size: {
          type: ["number", "string"],
          description: 'A number sets width, depth and height at once. For kind thread it may instead be a catalog designation carrying its own pitch: "M2" to "M20" metric coarse, or "#4-40" to "1/2-13" imperial UNC (default M8).',
        },
        rotation: { type: "number" },
        rotationX: { type: "number" },
        rotationZ: { type: "number" },
        sides: { type: "number" },
        loftBottomShape: { type: "string", enum: ["Oval", "Rectangle", "Triangle", "Pentagon", "Hexagon"], description: "loft only. Defaults to Rectangle." },
        loftTopShape: { type: "string", enum: ["Oval", "Rectangle", "Triangle", "Pentagon", "Hexagon"], description: "loft only. Defaults to Oval." },
        loftTopWidth: { type: "number", description: "loft only. Independent of the bottom's width, like a cone's top radius. Defaults to matching width." },
        loftTopDepth: { type: "number", description: "loft only. Independent of the bottom's depth. Defaults to matching depth." },
        loftBottomRotation: { type: "number", description: "loft only. Bottom end rotation in degrees." },
        loftTopRotation: { type: "number", description: "loft only. Top end rotation in degrees." },
        loftSegments: { type: "number", description: "loft only. Angular resolution, 8-128." },
        loftLayers: { type: "number", description: "loft only. Vertical resolution, 2-80." },
      },
    },
  },
  {
    name: "sketchforge_import_mesh",
    description: "Import a triangle mesh into SketchForge from raw position and optional normal arrays.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["positions"],
      properties: {
        ...editorTargetSchema.properties,
        name: { type: "string" },
        color: { type: "string" },
        x: { type: "number" },
        z: { type: "number" },
        elevation: { type: "number" },
        width: { type: "number" },
        depth: { type: "number" },
        height: { type: "number" },
        positions: { type: "array", items: { type: "number" } },
        normals: { type: "array", items: { type: "number" } },
      },
    },
  },
  {
    name: "sketchforge_update_object",
    description: "Update one object's exact dimensions, position, color, name, hole state, or rotations.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["id"],
      properties: {
        ...editorTargetSchema.properties,
        id: { type: "string" },
        name: { type: "string" },
        color: { type: "string" },
        hole: { type: "boolean" },
        x: { type: "number" },
        z: { type: "number" },
        elevation: { type: "number" },
        width: { type: "number" },
        depth: { type: "number" },
        height: { type: "number" },
        size: { type: "number" },
        rotation: { type: "number" },
        rotationX: { type: "number" },
        rotationZ: { type: "number" },
      },
    },
  },
  {
    name: "sketchforge_pattern_objects",
    description: "Repeat SketchForge objects in a row or around a ring, the way the editor's Repeat panel does. Makes the copies; sketchforge_distribute_objects only re-spaces objects that already exist.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" }, description: "Object ids to repeat. If omitted, uses the current selection." },
        kind: { type: "string", enum: ["linear", "circular"], description: "linear=a row; circular=a ring about a centre. Default linear." },
        count: { type: "number", description: "Total copies including the original, so 4 adds 3 (2-200). Default 4." },
        stepX: { type: "number", description: "For kind linear: centre-to-centre step along X in mm. This is a pitch, not a gap." },
        stepZ: { type: "number", description: "For kind linear: centre-to-centre step along Z in mm." },
        centerX: { type: "number", description: "For kind circular: X of the point to turn about." },
        centerZ: { type: "number", description: "For kind circular: Z of the point to turn about." },
        sweepAngle: { type: "number", description: "For kind circular: how far round to spread the copies, in degrees. 360 divides evenly so the last does not land on the first; a partial sweep puts one copy at each end. Default 360." },
        rotateCopies: { type: "boolean", description: "For kind circular: whether each copy turns to follow the ring (default true). A spoke or vane needs it; a bolt hole does not." },
      },
    },
  },
  {
    name: "sketchforge_distribute_objects",
    description: "Spread three or more SketchForge objects evenly along an axis, the way the editor's Distribute buttons do. The outermost two keep their places and define the span.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" }, description: "Object ids to distribute. If omitted, uses the current selection." },
        axis: { type: "string", enum: ["x", "z"], description: "Axis to spread along. Omit to use whichever axis the objects are already most spread along." },
        spacing: { type: "string", enum: ["gaps", "centers"], description: "gaps=equal clear space between objects (default); centers=equal centre-to-centre pitch." },
      },
    },
  },
  {
    name: "sketchforge_align_objects",
    description: "Align two or more SketchForge objects using the same alignment logic as the editor Alignment button.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["axis", "target"],
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" }, description: "Object ids to align. If omitted, uses the current selection." },
        anchorId: { type: "string", description: "Optional object id to keep fixed as the alignment reference." },
        axis: { type: "string", enum: ["x", "y", "z"], description: "x=left/right, z=front/back, y=bottom/top." },
        target: { type: "string", enum: ["min", "center", "max"], description: "Which side/center to align." },
      },
    },
  },
  {
    name: "sketchforge_group_objects",
    description: "Group objects by id using SketchForge's normal grouping/boolean pipeline.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["ids"],
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "sketchforge_ungroup_objects",
    description: "Ungroup one or more grouped objects by id and preserve their edited geometry.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" } },
        id: { type: "string" },
      },
    },
  },
  {
    name: "sketchforge_boolean_cut",
    description: "Cut solids with hole objects. Provide solidIds and holeIds; the result replaces the operands.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["solidIds", "holeIds"],
      properties: {
        ...editorTargetSchema.properties,
        solidIds: { type: "array", items: { type: "string" } },
        holeIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "sketchforge_separate_parts",
    description: "Separate one disconnected multi-part object into independent objects.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        id: { type: "string" },
      },
    },
  },
  {
    name: "sketchforge_list_edges",
    description: "List real CAD edge ids for one object so a later chamfer/fillet can target specific edges.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["id"],
      properties: {
        ...editorTargetSchema.properties,
        id: { type: "string" },
        sharpAngle: { type: "number" },
      },
    },
  },
  {
    name: "sketchforge_apply_edge_treatment",
    description: "Apply chamfer or fillet to specific edge ids returned by sketchforge_list_edges.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["id", "kind", "edgeIds", "amount"],
      properties: {
        ...editorTargetSchema.properties,
        id: { type: "string" },
        kind: { type: "string", enum: ["chamfer", "fillet"] },
        edgeIds: {
          anyOf: [
            { type: "array", items: { type: "number" } },
            { type: "string", enum: ["all"] },
          ],
        },
        allEdges: { type: "boolean" },
        amount: { type: "number" },
        chamferAngle: { type: "number" },
        sharpAngle: { type: "number" },
        quality: { type: "string", enum: ["draft", "standard", "fine"] },
        preserveEdgeSize: { type: "boolean" },
      },
    },
  },
  {
    name: "sketchforge_inspect_errors",
    description: "Inspect the editor notice, last MCP error, and active edge modifier error.",
    inputSchema: editorTargetSchema,
  },
  {
    name: "sketchforge_capture_image",
    description: "Capture a PNG image of the editor viewport from current/home/top/bottom/front/back/right/left view.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        face: { type: "string", enum: ["current", "home", "top", "bottom", "front", "back", "right", "left"] },
      },
    },
  },
  // Hollowing runs on the headless REST API rather than in an editor tab: the
  // operation is server-side OCCT, and the editor has no action for it yet.
  {
    name: "sketchforge_list_faces",
    description: "List a stored project shape's CAD faces, with the direction name each one can be opened by, so a hollow can leave the right ones off. Works on a project on the server (REST API), not on an open editor tab.",
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId"],
      properties: {
        projectId: { type: "string", description: "The server-side project id." },
        shapeId: { type: "string", description: "The id of the shape to read." },
      },
    },
  },
  {
    name: "sketchforge_hollow_shape",
    description: "Hollow a stored project shape out to a wall of a given thickness, optionally leaving faces open so a box becomes a tray. Exact (OCCT), so the result still exports to STEP and can still be filleted. A sphere, torus, cone or round-walled tube cannot be hollowed at any thickness. Works on a project on the server (REST API), not on an open editor tab.",
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId", "thickness"],
      properties: {
        projectId: { type: "string", description: "The server-side project id." },
        shapeId: { type: "string", description: "The id of the shape to hollow." },
        thickness: { type: "number", description: "Wall thickness in mm, measured inwards. Must be well under half the part's smallest span." },
        openFaces: {
          type: "array",
          description: 'Faces to leave open. Direction names ("top", "bottom", "left", "right", "front", "back") or face indexes from sketchforge_list_faces. Omit for a sealed hollow.',
          items: { type: ["string", "number"] },
        },
      },
    },
  },
  // Macros drive the headless REST API rather than an editor tab, and run only
  // from the directory the operator configured.
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
async function restRequest(method, path, { query = {}, body } = {}) {
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

function bridgeUrl() {
  return new URL(MCP_ROUTE, baseUrl);
}

async function bridgeGet() {
  const response = await fetch(bridgeUrl());
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `SketchForge bridge returned HTTP ${response.status}`);
  }
  return payload;
}

async function bridgeCommand(action, args = {}, defaultTimeoutMs = 15000) {
  const { editorNumber, editorId, timeoutMs, ...params } = args || {};
  let targetNumber = typeof editorNumber === "number" ? editorNumber : undefined;
  let targetId = typeof editorId === "string" ? editorId : undefined;

  if (!targetNumber && !targetId) {
    const { editors = [] } = await bridgeGet();
    if (editors.length === 1) {
      targetNumber = editors[0].editorNumber;
    } else {
      throw new Error(editors.length === 0 ? "No open SketchForge editors found" : "Provide editorNumber because multiple SketchForge editors are open");
    }
  }

  const response = await fetch(bridgeUrl(), {
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

async function callTool(name, args) {
  switch (name) {
    case "sketchforge_list_editors":
      return bridgeGet();
    case "sketchforge_read_scene":
      return bridgeCommand("get_scene", args);
    case "sketchforge_list_objects":
      return bridgeCommand("list_objects", args);
    case "sketchforge_select_objects":
      return bridgeCommand("select_objects", args);
    case "sketchforge_delete_objects":
      return bridgeCommand("delete_objects", args);
    case "sketchforge_create_shape":
      return bridgeCommand("create_shape", args);
    case "sketchforge_import_mesh":
      return bridgeCommand("import_mesh", args, 60000);
    case "sketchforge_update_object":
      return bridgeCommand("update_object", args);
    case "sketchforge_align_objects":
      return bridgeCommand("align_objects", args);
    case "sketchforge_distribute_objects":
      return bridgeCommand("distribute_objects", args);
    case "sketchforge_pattern_objects":
      return bridgeCommand("pattern_objects", args);
    case "sketchforge_group_objects":
      return bridgeCommand("group_objects", args, 30000);
    case "sketchforge_ungroup_objects":
      return bridgeCommand("ungroup_objects", args);
    case "sketchforge_boolean_cut":
      return bridgeCommand("boolean_cut", args, 45000);
    case "sketchforge_separate_parts":
      return bridgeCommand("separate_parts", args);
    case "sketchforge_list_edges":
      return bridgeCommand("list_edges", args, 30000);
    case "sketchforge_apply_edge_treatment":
      return bridgeCommand("apply_edge_treatment", args, 60000);
    case "sketchforge_list_faces":
      return restRequest("GET", "/faces", { query: { projectId: args.projectId, shapeId: args.shapeId } });
    case "sketchforge_hollow_shape":
      return restRequest("POST", "/shell", {
        query: { projectId: args.projectId, shapeId: args.shapeId },
        body: {
          thickness: args.thickness,
          ...(args.openFaces === undefined ? {} : { openFaces: args.openFaces }),
        },
      });
    case "sketchforge_inspect_errors":
      return bridgeCommand("inspect_errors", args);
    case "sketchforge_capture_image":
      return bridgeCommand("capture_image", args, 30000);
    case "sketchforge_list_macros":
      return listMacros();
    case "sketchforge_run_macro":
      return runMacroByName(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function textContent(value) {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

function toolResult(value) {
  if (value?.dataUrl?.startsWith?.("data:image/png;base64,")) {
    return {
      content: [
        textContent({ face: value.face, bytesApprox: value.bytesApprox }),
        {
          type: "image",
          data: value.dataUrl.slice("data:image/png;base64,".length),
          mimeType: "image/png",
        },
      ],
    };
  }
  return { content: [textContent(value)] };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sketchforge-mcp", version },
      });
      return;
    }
    if (method === "notifications/initialized") {
      return;
    }
    if (method === "ping") {
      sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      if (typeof name !== "string") {
        sendError(id, -32602, "Expected tool name");
        return;
      }
      const result = await callTool(name, params?.arguments || {});
      sendResult(id, toolResult(result));
      return;
    }
    if (method === "resources/list") {
      sendResult(id, { resources: [] });
      return;
    }
    sendError(id, -32601, `Unknown method: ${method}`);
  } catch (error) {
    if (method === "tools/call") {
      sendResult(id, { isError: true, content: [textContent(error instanceof Error ? error.message : String(error))] });
      return;
    }
    sendError(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      void handleMessage(JSON.parse(trimmed));
    } catch (error) {
      sendError(null, -32700, error instanceof Error ? error.message : String(error));
    }
  });
});
