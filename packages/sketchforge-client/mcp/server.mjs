#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpReadPath, resolveMcpWritePath } from "./filesystemPaths.mjs";
import { listMacros, macroTools, runMacroByName } from "./macroTools.mjs";
import { callLocalEngineTool } from "./localEngine.mjs";


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
/** What a drawing shows, as `POST /exports` and the engine name it. Kept in step by `localMcpEngine.test.ts`. */
const PROJECTION_LAYOUTS = ["multiview", "front", "back", "top", "bottom", "left", "right", "iso"];
const SECTION_PLANES = ["xy", "xz", "yz"];

/**
 * The kinds `sketchforge_create_shape` advertises. Local mode builds them through
 * the engine's `addShapes`, which takes its parameter table
 * (`REQUESTABLE_SHAPE_KINDS`) plus `revolve` and `thread`; `sketch` extrudes a
 * drawn outline with the editor's CAD kernel and is editor-only. Kept in step
 * with the engine by `mcpCreateShapeKinds.test.ts`.
 */
const LOCAL_SHAPE_KINDS = [
  "box", "cube", "cylinder", "cone", "sphere", "halfSphere", "torus",
  "tube", "ring", "polygon", "pyramid", "roof", "roundRoof", "wedge",
  "icosahedron", "text", "loft", "gear", "revolve", "thread",
];
const EDITOR_SHAPE_KINDS = ["box", "cube", "cylinder", "text", "loft", "sketch", "revolve", "thread"];
const CREATE_SHAPE_KINDS = [...LOCAL_SHAPE_KINDS, "sketch"];

const editorTargetSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
    projectId: { type: "string", description: "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode." },
    editorNumber: { type: "number", description: "The 5-digit SketchForge editor number from sketchforge_list_editors." },
    editorId: { type: "string", description: "Optional internal editor id. Prefer editorNumber for human-directed use." },
    timeoutMs: { type: "number", description: "Command timeout in milliseconds. Defaults to 15000." },
  },
};
const localProjectSchema = { type: "object", properties: {} };
/** What group_objects and boolean_cut may name and colour the shape they leave behind. */
const resultAttributeProperties = {
  name: { type: "string", description: "Name for the result (default \"Group\")." },
  color: { type: "string", description: "Hex color for the result, such as #2a9d8f (default the first solid's color)." },
};

const tools = [
  {
    name: "sketchforge_list_projects",
    description: "List projects stored in SKETCHFORGE_PROJECTS_DIR for offline MCP use.",
    inputSchema: localProjectSchema,
  },
  {
    name: "sketchforge_create_project",
    description: "Create an empty project in the local SKETCHFORGE_PROJECTS_DIR.",
    inputSchema: { ...localProjectSchema, required: ["name"], properties: { name: { type: "string" } } },
  },
  {
    name: "sketchforge_import_project",
    description: "Import a local .skf file as a new project in SKETCHFORGE_PROJECTS_DIR. File reads are confined to SKETCHFORGE_MCP_FILES_DIR, or SKETCHFORGE_PROJECTS_DIR when unset; if both are unset, paths are unrestricted.",
    inputSchema: { ...localProjectSchema, required: ["filePath"], properties: { filePath: { type: "string", description: "Path to a .skf under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set." }, name: { type: "string" } } },
  },
  {
    name: "sketchforge_list_editors",
    description: "List SketchForge editor tabs that are currently open and heartbeating, including editorNumber and projectName.",
    inputSchema: { ...editorTargetSchema, properties: { url: editorTargetSchema.properties.url } },
  },
  {
    name: "sketchforge_read_scene",
    description: "Read the current scene and exact object dimensions from local project files by default, or from an editor when a server url is supplied.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        includeRawShapes: { type: "boolean", description: "Include raw WorkplaneShape JSON. Can be large for imported meshes." },
        shapeIds: { type: "array", items: { type: "string" }, description: "Limit the response to these object ids (including rawShapes)." },
        excludeShapeIds: { type: "array", items: { type: "string" }, description: "Omit these object ids, useful for large reference meshes." },
        includeRawShapeIds: { type: "array", items: { type: "string" }, description: "Include raw geometry only for these ids; takes precedence over includeRawShapes." },
      },
    },
  },
  {
    name: "sketchforge_list_objects",
    description: "List all objects in the local project by default, or in the editor when a server url is supplied, with exact dimensions, position, rotation, and object ids.",
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
    name: "sketchforge_mirror_objects",
    description: "Mirror objects across the center plane of their combined bounds, using the editor's mirror behavior.",
    inputSchema: { ...editorTargetSchema, required: ["axis"], properties: { ...editorTargetSchema.properties, ids: { type: "array", items: { type: "string" }, description: "Object ids; defaults to the current selection." }, axis: { type: "string", enum: ["x", "y", "z"] } } },
  },
  {
    name: "sketchforge_mirror_baked",
    description: "Reflect exact parameter-built solids across their shared bounds plane and bake the result to BREP. Imported meshes, groups, and previously treated shapes are refused.",
    inputSchema: { ...editorTargetSchema, required: ["projectId", "ids", "axis"], properties: { ...editorTargetSchema.properties, projectId: { type: "string" }, ids: { type: "array", minItems: 1, items: { type: "string" } }, axis: { type: "string", enum: ["x", "y", "z"] } } },
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
    description: `Create a parameterized shape, extruded sketch, revolve, or standard screw thread in SketchForge. Local mode (no url) builds ${LOCAL_SHAPE_KINDS.join(", ")}. An editor (url) builds ${EDITOR_SHAPE_KINDS.join(", ")}. sketch is editor-only. Each parameter's description names the kinds it applies to.`,
    inputSchema: {
      ...editorTargetSchema,
      required: ["kind"],
      properties: {
        ...editorTargetSchema.properties,
        kind: {
          type: "string",
          enum: CREATE_SHAPE_KINDS,
          description: `Local mode builds every kind except sketch. sketch is editor-only: it needs an open editor (url), and local mode refuses it. An editor builds only ${EDITOR_SHAPE_KINDS.join(", ")}.`,
        },
        profile: {
          type: "array",
          description: "For kind sketch: a closed 2D outline to extrude, as [x, z] pairs. For kind revolve: the closed outline to revolve, where x is distance from axis and z runs along it.",
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        },
        pitch: { type: "number", description: "For kind revolve/thread: axial rise per turn in mm. 0 is a plain revolve; negative is a left-hand thread." },
        turns: { type: "number", description: "For kind revolve/thread: how many full turns to sweep (default 8 for a thread)." },
        diameter: { type: "number", description: "For kind thread: outside diameter in mm, for a size the catalog does not list. The 60-degree ISO profile follows from this and the pitch." },
        length: { type: "number", description: "For kind thread: how long the thread should be in mm, instead of giving turns." },
        hole: {
          type: "boolean",
          description: "Any kind: create the shape as a hole (a cutter), so grouping it with a solid cuts it out of that solid without a separate update_object call. For kind thread it also cuts the form wider by a clearance so a bolt of that size fits, which taps the solid.",
        },
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
        sides: { type: "number", description: "For cylinder, cone, pyramid and roundRoof: number of sides around the axis (at least 3, default 96)." },
        steps: { type: "number", description: "For sphere and halfSphere: number of segments around and over the surface (at least 4, default 32)." },
        bevel: {
          type: "number",
          description: "For tube and ring: wall thickness in mm, measured inward from the outer radius (minimum 0.1, default 4). A 20x20x10 tube with bevel 4 has a 6 mm inner radius. For text: edge rounding in mm (default 0).",
        },
        segments: { type: "number", description: "For text: curve segments per glyph outline (at least 1, default 2)." },
        topRadius: { type: "number", description: "For cone: radius of the top in mm (default 0, a point)." },
        baseRadius: { type: "number", description: "For cone: radius of the base in mm (default half the width)." },
        taperTopWidth: { type: "number", description: "Every kind but gear: footprint width at the top of the extrusion in mm (default width)." },
        taperTopDepth: { type: "number", description: "Every kind but gear: footprint depth at the top of the extrusion in mm (default depth)." },
        taperBottomWidth: { type: "number", description: "Every kind but gear: footprint width at the bottom of the extrusion in mm (default width)." },
        taperBottomDepth: { type: "number", description: "Every kind but gear: footprint depth at the bottom of the extrusion in mm (default depth)." },
        teeth: { type: "number", description: "For gear: tooth count (default 12)." },
        toothSize: { type: "number", description: "For gear: radial tooth height in mm (default 2.5)." },
        toothWidth: { type: "number", description: "For gear: tooth width in mm (default 0.54 of the tooth pitch, clamped between 0.12 and 0.82 of it)." },
        centerHoleSize: { type: "number", description: "For gear: centre hole size in mm (default 6, clamped so it stays inside the tooth roots; 0 for none)." },
        gearType: { type: "string", enum: ["spur", "helical", "bevel"], description: "For gear: tooth form (default spur)." },
        helixAngle: { type: "number", description: "For gear with gearType helical: helix angle in degrees (default 22.5)." },
        text: { type: "string", description: "For text: the characters to extrude (default TEXT)." },
        font: { type: "string", description: "For text: font name (default Multilanguage)." },
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
    name: "sketchforge_import_file",
    description: "Import an STL, OBJ, or SVG file from the MCP host filesystem into SketchForge. The source filename supplies the shape name; color and placement use importer defaults. In local mode provide projectId and filePath; with url, the file is sent to POST /api/v1/imports. File reads are confined to SKETCHFORGE_MCP_FILES_DIR, or SKETCHFORGE_PROJECTS_DIR when unset; if both are unset, paths are unrestricted.",
    inputSchema: {
      type: "object",
      required: ["projectId", "filePath"],
      properties: {
        url: editorTargetSchema.properties.url,
        projectId: { type: "string" },
        filePath: { type: "string", description: "Path to an .stl, .obj, or .svg file under the configured MCP files root; unrestricted when no root is set." },
      },
    },
  },
  {
    name: "sketchforge_import_stl",
    description: "Local-only compatibility alias for sketchforge_import_file. Accepts STL, OBJ, or SVG files. Optional name, color, and placement fields override the imported shape. A remote url is not supported.",
    inputSchema: {
      type: "object",
      required: ["projectId", "filePath"],
      properties: {
        projectId: { type: "string" },
        filePath: { type: "string", description: "Path to an .stl, .obj, or .svg file under the configured MCP files root; unrestricted when no root is set." },
        name: { type: "string" },
        color: { type: "string" },
        x: { type: "number" },
        z: { type: "number" },
        elevation: { type: "number" },
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
        faceColors: { type: "object", description: "Optional colors keyed by stable face IDs from sketchforge_list_faces, such as {'face_abc':'#ff0000'}. Numeric face indexes remain accepted for older projects." },
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
    description: "Group objects by id using SketchForge's normal grouping/boolean pipeline. A selection holding a hole comes back cut. Optional name and color are set on the result.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["ids"],
      properties: {
        ...editorTargetSchema.properties,
        ids: { type: "array", items: { type: "string" } },
        ...resultAttributeProperties,
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
    description: "Cut solids with hole objects. Provide solidIds and holeIds; the result replaces the operands. Optional name and color are set on the result.",
    inputSchema: {
      ...editorTargetSchema,
      required: ["solidIds", "holeIds"],
      properties: {
        ...editorTargetSchema.properties,
        solidIds: { type: "array", items: { type: "string" } },
        holeIds: { type: "array", items: { type: "string" } },
        ...resultAttributeProperties,
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
    name: "sketchforge_explode_step_assembly",
    description: "Explode an imported STEP assembly into independent exact solids. Limited to 200 solids and 8 MiB source files.",
    inputSchema: { ...editorTargetSchema, required: ["projectId", "shapeId"], properties: { ...editorTargetSchema.properties, projectId: { type: "string" }, shapeId: { type: "string" } } },
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
    description: "Capture a PNG image from current/home/top/bottom/front/back/right/left view. Editor mode captures the live viewport. Local project mode rasterises the kernel's hidden-line drawing of the stored geometry: a named face is that one view, home and current are the four-view grid. Prefer sketchforge_project_view for the SVG itself.",
    inputSchema: {
      ...editorTargetSchema,
      properties: {
        ...editorTargetSchema.properties,
        face: { type: "string", enum: ["current", "home", "top", "bottom", "front", "back", "right", "left"] },
        featureAngle: { type: "number", minimum: 0, maximum: 180, description: "Crease angle in degrees for mesh shapes (imported, mesh-derived, boolean results): an edge between two triangles is drawn only where they meet at more than this, besides boundaries and silhouettes. Default 30; 0 draws every edge that is not flat. Exact solids ignore it. Local project mode only; the live editor viewport ignores it." },
      },
    },
  },
  {
    name: "sketchforge_export_scene",
    description: "Export selected objects or the whole scene as STL, OBJ, 3MF, STEP, SKF, a ZIP kit, SVG drawings, or section DXF. DXF needs section {plane, offset}. Set outputPath to save on the MCP host; writes are confined to SKETCHFORGE_MCP_FILES_DIR, or SKETCHFORGE_PROJECTS_DIR when unset. If both are unset, paths are unrestricted. Existing files require overwrite: true.",
    inputSchema: { ...editorTargetSchema, required: ["format"], properties: { ...editorTargetSchema.properties, format: { type: "string", enum: ["stl", "obj", "3mf", "step", "skf", "zip", "svg", "dxf"] }, view: { type: "string", enum: PROJECTION_LAYOUTS, description: "For svg only: one named view, or the multiview grid (default)." }, section: { type: "object", description: "For svg or dxf section export.", properties: { plane: { type: "string", enum: ["xy", "xz", "yz"] }, offset: { type: "number" } }, required: ["plane", "offset"] }, shapeIds: { type: "array", items: { type: "string" }, description: "Optional object ids." }, name: { type: "string" }, outputPath: { type: "string", description: "Destination path under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set." }, overwrite: { type: "boolean", description: "Set true to replace an existing output file." } } },
  },
  {
    name: "sketchforge_project_view",
    description: "Draw a stored project as an SVG by the CAD kernel's hidden-line removal: true curves, hidden edges dashed, a gnomon per view and the overall size. Mesh shapes are drawn by feature edges (see featureAngle), silhouettes and boundaries rather than every triangle. The multiview grid (front, top, right, iso) is the readable picture of the geometry; a single view is a 2D drawing of that face. Works offline or against a server when url is supplied.",
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
        projectId: { type: "string", description: "The server-side project id." },
        view: { type: "string", enum: PROJECTION_LAYOUTS, description: "One named view, or the multiview grid (default)." },
        featureAngle: { type: "number", minimum: 0, maximum: 180, description: "Crease angle in degrees for mesh shapes (imported, mesh-derived, boolean results): an edge between two triangles is drawn only where they meet at more than this, besides boundaries and silhouettes. Default 30; 0 draws every edge that is not flat. Exact solids ignore it." },
        shapeIds: { type: "array", items: { type: "string" }, description: "Optional object ids; defaults to the current selection, or the whole scene when nothing is selected." },
        name: { type: "string", description: "Optional base name for the file." },
        outputPath: { type: "string", description: "Optional destination path under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set. SVG text is returned inline otherwise." },
        overwrite: { type: "boolean", description: "Set true to replace an existing output file." },
      },
    },
  },
  {
    name: "sketchforge_section_view",
    description: "Return a CAD section drawing as SVG by cutting the stored solids with one axis-aligned plane in drawing coordinates. offset is the coordinate of the omitted axis, in millimetres. Exact shapes are cut by the OCCT kernel; mesh shapes (imported STL/OBJ and other mesh-backed shapes) are sliced directly, up to 2,000,000 triangles across the selection -- pass shapeIds to section fewer shapes when over that. Works offline or against a server when url is supplied.",
    inputSchema: {
      type: "object",
      required: ["projectId", "plane", "offset"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
        projectId: { type: "string", description: "The project id." },
        plane: { type: "string", enum: SECTION_PLANES, description: "Plane in drawing coordinates; XY omits Z, XZ omits Y, and YZ omits X." },
        offset: { type: "number", description: "Coordinate of the omitted axis in millimetres; must intersect the selected scene." },
        shapeIds: { type: "array", items: { type: "string" }, description: "Optional object ids; defaults to the current selection, or the whole scene when nothing is selected." },
        name: { type: "string", description: "Optional base name for the file." },
        outputPath: { type: "string", description: "Optional destination path under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set. SVG text is returned inline otherwise." },
        overwrite: { type: "boolean", description: "Set true to replace an existing output file." },
      },
    },
  },
  {
    name: "sketchforge_validate_scene",
    description: "Check triangle topology, conservative AABB clearance bounds, and exact Manifold intersection volumes for overlapping scene objects.",
    inputSchema: { ...editorTargetSchema, properties: { ...editorTargetSchema.properties, shapeIds: { type: "array", items: { type: "string" } }, excludeShapeIds: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "sketchforge_check_interference",
    description: "Check exact OCCT surface gaps and overlap volumes between visible, non-cutter solids. Clearance is in millimetres. The report refuses the whole request above 128 shapes or 512 AABB candidate pairs; narrow ids or reduce clearance. Works offline or against a server.",
    inputSchema: { ...editorTargetSchema, properties: { ...editorTargetSchema.properties, ids: { type: "array", items: { type: "string" }, description: "Optional shape ids; defaults to all visible non-cutter solids." }, clearance: { type: "number", minimum: 0, description: "Maximum exact surface gap to report, in mm (default 0)." } } },
  },
  // CAD operations use the local engine by default and the server API when a URL is supplied.
  {
    name: "sketchforge_list_faces",
    description: "List a stored project shape's CAD faces with stable IDs and compatibility indexes, plus the direction name each one can be opened by. Use the stable ID to assign a face color; use the index for treatments, measurements, and shell openings. Works offline or against a server when url is supplied.",
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
        projectId: { type: "string", description: "The server-side project id." },
        shapeId: { type: "string", description: "The id of the shape to read." },
      },
    },
  },
  // Measuring uses exact CAD geometry in either the local engine or server API.
  {
    name: "sketchforge_measure_shape",
    description: "Measure every edge and face of a stored project shape from its exact CAD geometry: edge length, the radius and diameter of a circular edge or arc, face area, and a cylindrical face's radius. Exact (OCCT), so a round hole has a real radius rather than the chord length of a facet. A measurement that is not meaningful for the entity -- the radius of a straight edge, of an ellipse, or of a cone whose radius changes along it -- comes back null with a reason in radiusUnavailable. Works offline or against a server when url is supplied.",
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
        projectId: { type: "string", description: "The server-side project id." },
        shapeId: { type: "string", description: "The id of the shape to measure." },
      },
    },
  },
  {
    name: "sketchforge_measure_between",
    description: "The exact minimum distance between two CAD entities in a stored project, and the angle between them when both are flat faces. Each end names a shape and either the whole solid, or one edge or face by the index the measurement listing gave it. Distance is measured between the real surfaces where the shapes sit, so two round posts 5mm apart at their nearest walls read 5 -- not the gap between their bounding boxes. Works offline or against a server when url is supplied.",
    inputSchema: {
      type: "object",
      required: ["projectId", "from", "to"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
        projectId: { type: "string", description: "The server-side project id." },
        from: {
          type: "object",
          required: ["shapeId"],
          properties: {
            shapeId: { type: "string", description: "The shape this end is part of." },
            entity: {
              type: "string",
              enum: ["shape", "edge", "face"],
              description: "What to measure to. 'shape' is the whole solid and takes no index; 'edge' and 'face' need one.",
            },
            index: { type: "number", description: "Which edge or face, by the index the measurement listing gave it." },
          },
        },
        to: {
          type: "object",
          required: ["shapeId"],
          properties: {
            shapeId: { type: "string", description: "The shape this end is part of." },
            entity: { type: "string", enum: ["shape", "edge", "face"] },
            index: { type: "number" },
          },
        },
      },
    },
  },
  {
    name: "sketchforge_shape_properties",
    description: "Read one stored shape's volume, surface area, center of mass, bounds and validity, with provenance identifying the geometry source and whether precision is exact or tessellated. A group of solids is measured as the union of its children. Exact shapes are measured by the CAD kernel; mesh-sourced shapes are measured directly from their triangles, counting every shell and subtracting enclosed voids, and report isValid false when the mesh is not closed. Works offline or against a server when url is supplied.",
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
        projectId: { type: "string", description: "The project id." },
        shapeId: { type: "string", description: "The shape id." },
      },
    },
  },
  {
    name: "sketchforge_estimate_wall_thickness",
    description: "Estimate wall thickness from a 5 by 5 UV sample grid on each face. This is a screening estimate and may miss thin regions between samples; it is not a certified minimum-thickness result.",
    inputSchema: { type: "object", required: ["projectId", "shapeId"], properties: { url: { type: "string" }, projectId: { type: "string" }, shapeId: { type: "string" } } },
  },
  {
    name: "sketchforge_hollow_shape",
    description: "Hollow a stored project shape out to a wall of a given thickness, optionally leaving faces open so a box becomes a tray. Exact (OCCT), so the result still exports to STEP and can still be filleted. A sphere, torus, cone or round-walled tube cannot be hollowed at any thickness. Works offline or against a server when url is supplied.",
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId", "thickness"],
      properties: {
        url: { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." },
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

async function callTool(name, args = {}) {
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
        textContent({ face: value.face, ...(value.view === undefined ? {} : { view: value.view }), bytesApprox: value.bytesApprox }),
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
