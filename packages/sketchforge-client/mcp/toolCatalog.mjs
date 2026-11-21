/** Declares every editor and local-engine tool. Pure data: safe to load in any host. */

import {
  CREATE_SHAPE_KINDS,
  EDITOR_SHAPE_KINDS,
  LOCAL_SHAPE_KINDS,
  LOCAL_SOLID_KINDS,
  LOCAL_STORED_KINDS,
  STEP_KINDS,
  TAPER_KINDS,
} from "./createShapeKinds.mjs";

/** What a drawing shows, as `POST /exports` and the engine name it. Kept in step by `localMcpEngine.test.ts`. */
const PROJECTION_LAYOUTS = ["multiview", "front", "back", "top", "bottom", "left", "right", "iso"];
const SECTION_PLANES = ["xy", "xz", "yz"];


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
  color: { type: "string", description: "Color for the result, stored as given as create_shape stores its color, such as #2a9d8f (default the first solid's color)." },
};

const urlProperty = { type: "string", description: "Optional SketchForge server URL. Omit to work offline with local project files." };
const projectIdProperty = { type: "string", description: "The project id." };
const PARAMETER_DIMENSIONS = ["length", "angle", "unitless"];
const WORKS_BOTH_WAYS = "Works offline or against a server when url is supplied.";
const REFUSAL_FORMAT = "A refusal ends its first line with [code]; a second line, when present, is JSON detail.";

export const engineTools = [
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
    description: `Create a parameterized shape, extruded sketch, revolve, or standard screw thread in SketchForge. Local mode (no url) accepts ${LOCAL_SHAPE_KINDS.join(", ")}; the kind description says which of those it can measure and export. An editor (url) builds ${EDITOR_SHAPE_KINDS.join(", ")}. sketch is editor-only. Each parameter's description names the kinds it applies to.`,
    inputSchema: {
      ...editorTargetSchema,
      required: ["kind"],
      properties: {
        ...editorTargetSchema.properties,
        kind: {
          type: "string",
          enum: CREATE_SHAPE_KINDS,
          description: [
            `Local mode builds ${LOCAL_SOLID_KINDS.join(", ")} as solids that measure and export as STL.`,
            "A roundRoof's height may be at most half its width; a taller one fails to build.",
            `${LOCAL_STORED_KINDS.join(", ")} are stored only: local mode records the parameters but cannot measure or export them; open the project in an editor for those.`,
            `STEP export holds only ${STEP_KINDS.join(", ")}; export the other solids as STL.`,
            "revolve there means a plain revolve: no pitch, no coreRadius, one closed profile region with straight edges, and not resized unevenly across its axis; any other revolve, like a thread, exports as STL only. A plain revolve is in STEP only when exported by the server or local mode, from its exact solid; an open editor's own STEP export skips it.",
            "sketch is editor-only: it needs an open editor (url), and local mode refuses it.",
            `An editor builds only ${EDITOR_SHAPE_KINDS.join(", ")}.`,
          ].join(" "),
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
        sweepAngle: { type: "number", description: "For kind revolve with no pitch: how far round to revolve, in degrees (±360). x/z place the axis of revolution, so a partial sweep lies to one side of them; the result's x/z is its box centre, and local mode reports the axis as revolveAxis." },
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
        sides: { type: "number", description: "Number of flat sides around the axis, at least 3. For cylinder: default 96, which builds a true round cylinder; fewer builds a prism. For pyramid: default 4, a rectangular base; any other count is a regular polygon base. A cone and roundRoof are always round, whatever sides says. For kind revolve/thread: facets per full turn of the sweep, 3-512 (default 64). On a 150 mm ring 64 facets are about 7.4 mm wide and 256 about 1.8 mm; the triangle count grows with it." },
        quality: { type: "number", description: "For kind revolve/thread: how finely curved segments of the profile are sampled, 1-10 (default 6). An outline of [x, z] points is all straight segments, so it changes nothing there; raise sides to smooth the turn." },
        steps: { type: "number", description: "For sphere and halfSphere: display mesh segments around and over the surface (at least 4, default 32). The measured and exported solid is a true curved surface whatever steps says." },
        bevel: {
          type: "number",
          description: "For tube and ring: wall thickness in mm, measured inward from the outer radius (default 4). It is clamped to at least 0.1 and at most the smaller outer radius less 0.1, so the bore never closes: on a 20 mm wide tube, any bevel above 9.9 builds a 9.9 mm wall. A 20x20x10 tube with bevel 4 has a 6 mm inner radius. For text: edge rounding in mm (default 0).",
        },
        segments: { type: "number", description: "For text: curve segments per glyph outline (at least 1, default 2)." },
        topRadius: { type: "number", description: "For cone: radius of the top in mm (default 0, a point)." },
        baseRadius: { type: "number", description: "For cone: recorded base radius in mm (default half the width). It does not change the solid: a cone stands on half its width, so set width and depth to size the base." },
        taperTopWidth: { type: "number", description: `For ${TAPER_KINDS.join(", ")} in local mode: footprint width at the top of the extrusion in mm (default width). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it.` },
        taperTopDepth: { type: "number", description: `For ${TAPER_KINDS.join(", ")} in local mode: footprint depth at the top of the extrusion in mm (default depth). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it.` },
        taperBottomWidth: { type: "number", description: `For ${TAPER_KINDS.join(", ")} in local mode: footprint width at the bottom of the extrusion in mm (default width). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it.` },
        taperBottomDepth: { type: "number", description: `For ${TAPER_KINDS.join(", ")} in local mode: footprint depth at the bottom of the extrusion in mm (default depth). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it.` },
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
    description: "Read one stored shape's volume, surface area, center of mass, bounds and validity, with provenance identifying the geometry source and whether precision is exact or tessellated. A group of solids is measured as the union of its children. Exact shapes are measured by the CAD kernel; closed mesh-sourced shapes are measured directly from their triangles, counting every shell and subtracting enclosed voids, and a mesh that does not close is left to the kernel, which refuses it. Works offline or against a server when url is supplied.",
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
  {
    name: "sketchforge_list_parameters",
    description: `List the project's named parameters: name, expression, dimension, resolved value (null for a stale entry) and error, if any. bindingIssues lists shape bindings that no longer resolve. ${REFUSAL_FORMAT} ${WORKS_BOTH_WAYS}`,
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: { url: urlProperty, projectId: projectIdProperty },
    },
  },
  {
    name: "sketchforge_set_parameter",
    description: [
      "Create a parameter, or change the expression or dimension of an existing one.",
      "Send expression and dimension to create. An existing name is overwritten, not refused; created says which happened. Either one alone changes an existing parameter.",
      "A bare number takes the dimension's unit, so 3 in a length parameter is 3 mm.",
      "The reply has created, the parameter, the whole table, and the shapes the change rebuilt.",
      REFUSAL_FORMAT,
      "Codes: invalid_expression (bad syntax, an unknown name, the wrong dimension or a cycle; expressionError has the span and any cycle path), parameter_not_found (a change to a name that does not exist), invalid_request (a bad name or dimension, or an empty or over-long expression), limit_exceeded (the table is full), shape_locked (a bound shape is locked; detail names shapeId and fields), geometry_failed (a bound sketch cannot be solved; detail names shapeId and constraintIds).",
      WORKS_BOTH_WAYS,
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["projectId", "name"],
      properties: {
        url: urlProperty,
        projectId: projectIdProperty,
        name: { type: "string", description: "Parameter name: a letter or underscore, then letters, digits or underscores." },
        expression: { type: "string", description: 'For example "2", "3 mm", "wall * 2 + 1" or "max(wall, 2)". Units: mm, cm, m, in, ft, deg, rad.' },
        dimension: { type: "string", enum: PARAMETER_DIMENSIONS, description: "length values are in mm and angle values in degrees." },
      },
    },
  },
  {
    name: "sketchforge_rename_parameter",
    description: `Rename a parameter, rewriting every parameter expression and shape binding that uses it. ${REFUSAL_FORMAT} Codes: parameter_not_found, parameter_exists (newName is taken), invalid_request (newName is not a valid name). ${WORKS_BOTH_WAYS}`,
    inputSchema: {
      type: "object",
      required: ["projectId", "name", "newName"],
      properties: {
        url: urlProperty,
        projectId: projectIdProperty,
        name: { type: "string", description: "The current name." },
        newName: { type: "string", description: "The new name." },
      },
    },
  },
  {
    name: "sketchforge_delete_parameter",
    description: `Delete a parameter that nothing uses. ${REFUSAL_FORMAT} Codes: parameter_not_found; parameter_in_use while anything references it, with dependents (parameter names), shapeDependents (shapeId and fields), sketchConstraintDependents (shapeId and constraintIds) and configurationDependents (configuration names) to change or clear first. ${WORKS_BOTH_WAYS}`,
    inputSchema: {
      type: "object",
      required: ["projectId", "name"],
      properties: { url: urlProperty, projectId: projectIdProperty, name: { type: "string", description: "The parameter to delete." } },
    },
  },
  {
    name: "sketchforge_set_shape_expression",
    description: [
      "Bind one field of a stored shape to a parameter expression and apply its value, or pass expression null to clear the binding and keep the current number.",
      "A changed parameter then rebuilds the shape. Bindable fields: x, z, elevation, width, depth, height, rotation, rotationX, rotationZ, kind parameters such as sides or bevel, revolve.startAngle, revolve.sweepAngle and the other revolve settings, draftPrismAngle and faceDraft.angle.",
      "The reply has the shape, as GET /api/v1/shapes reports it, and the revision. Repeating the stored expression writes nothing.",
      REFUSAL_FORMAT,
      "Codes: unapplicable_fields (this shape cannot bind the field), invalid_expression (detail names shapeId and field, with expressionError, or value, min and max for a result out of range), shape_not_found, shape_locked (detail names shapeId and fields).",
      WORKS_BOTH_WAYS,
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId", "field", "expression"],
      properties: {
        url: urlProperty,
        projectId: projectIdProperty,
        shapeId: { type: "string", description: "The shape id." },
        field: { type: "string", description: 'The field to bind, such as "width" or "revolve.sweepAngle".' },
        expression: { type: ["string", "null"], description: 'For example "wall * 5". null clears the binding.' },
      },
    },
  },
  {
    name: "sketchforge_bind_sketch_constraint",
    description: [
      "Bind one dimensional constraint of a stored shape's sketch (distance, radius, diameter or angle) to a parameter expression, re-solve the sketch and rebuild the shape; or pass expression null to unbind it and keep its value.",
      "A changed parameter then re-solves the sketch. shapeId is the sketch output or its sketchSourceId.",
      "The reply has the rebuilt shape, as GET /api/v1/shapes reports it, the constraint as { id, kind, value, expression }, and the revision.",
      REFUSAL_FORMAT,
      "Codes: invalid_expression (bad syntax, an unknown name, the wrong dimension, or outOfRange; detail names shapeId and constraintId), unapplicable_fields (the constraint cannot bind, the sketch cannot be rebuilt, or conflictingBinding: a bound size of the same output drives that dimension; detail lists those fields), invalid_request (no such constraintId, or a bad body), geometry_failed (the sketch cannot be solved; detail lists constraintIds), shape_not_found, shape_locked.",
      WORKS_BOTH_WAYS,
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["projectId", "shapeId", "constraintId", "expression"],
      properties: {
        url: urlProperty,
        projectId: projectIdProperty,
        shapeId: { type: "string", description: "The sketch output shape, or its sketchSourceId." },
        constraintId: { type: "string", description: 'The constraint id in the sketch profile, such as "width".' },
        expression: { type: ["string", "null"], description: 'For example "w * 2". null removes the binding.' },
      },
    },
  },
];
