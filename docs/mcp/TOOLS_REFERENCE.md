---
slug: /docs/mcp/TOOLS_REFERENCE
title: MCP tool reference
audience: MCP users
owner: MCP
sources:
  - packages/sketchforge-client/mcp/**
---

# MCP tool reference

Generated from the running `tools/list` registry in `packages/sketchforge-client/mcp/server.mjs`.
Regenerate with `node scripts/generate-mcp-reference.mjs`; `--check` verifies that this file matches the current public registry.

The server currently exposes 40 tools. Input schemas below are the exact JSON Schema values advertised over MCP.

## sketchforge_list_projects

### Description

List projects stored in SKETCHFORGE_PROJECTS_DIR for offline MCP use.

### Input schema

```json
{
  "type": "object",
  "properties": {}
}
```
## sketchforge_create_project

### Description

Create an empty project in the local SKETCHFORGE_PROJECTS_DIR.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string"
    }
  },
  "required": [
    "name"
  ]
}
```
## sketchforge_import_project

### Description

Import a local .skf file as a new project in SKETCHFORGE_PROJECTS_DIR. File reads are confined to SKETCHFORGE_MCP_FILES_DIR, or SKETCHFORGE_PROJECTS_DIR when unset; if both are unset, paths are unrestricted.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "description": "Path to a .skf under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set."
    },
    "name": {
      "type": "string"
    }
  },
  "required": [
    "filePath"
  ]
}
```
## sketchforge_list_editors

### Description

List SketchForge editor tabs that are currently open and heartbeating, including editorNumber and projectName.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    }
  }
}
```
## sketchforge_read_scene

### Description

Read the current scene and exact object dimensions from local project files by default, or from an editor when a server url is supplied.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "includeRawShapes": {
      "type": "boolean",
      "description": "Include raw WorkplaneShape JSON. Can be large for imported meshes."
    },
    "shapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Limit the response to these object ids (including rawShapes)."
    },
    "excludeShapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Omit these object ids, useful for large reference meshes."
    },
    "includeRawShapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Include raw geometry only for these ids; takes precedence over includeRawShapes."
    }
  }
}
```
## sketchforge_list_objects

### Description

List all objects in the local project by default, or in the editor when a server url is supplied, with exact dimensions, position, rotation, and object ids.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    }
  }
}
```
## sketchforge_select_objects

### Description

Select objects by id in the SketchForge editor.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "ids"
  ]
}
```
## sketchforge_mirror_objects

### Description

Mirror objects across the center plane of their combined bounds, using the editor's mirror behavior.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Object ids; defaults to the current selection."
    },
    "axis": {
      "type": "string",
      "enum": [
        "x",
        "y",
        "z"
      ]
    }
  },
  "required": [
    "axis"
  ]
}
```
## sketchforge_mirror_baked

### Description

Reflect exact parameter-built solids across their shared bounds plane and bake the result to BREP. Imported meshes, groups, and previously treated shapes are refused.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string"
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string"
      }
    },
    "axis": {
      "type": "string",
      "enum": [
        "x",
        "y",
        "z"
      ]
    }
  },
  "required": [
    "projectId",
    "ids",
    "axis"
  ]
}
```
## sketchforge_delete_objects

### Description

Delete objects by id, or delete the current selection when ids are omitted.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "id": {
      "type": "string"
    }
  }
}
```
## sketchforge_create_shape

### Description

Create a parameterized shape, extruded sketch, revolve, or standard screw thread in SketchForge. Local mode (no url) accepts box, cube, cylinder, cone, sphere, halfSphere, torus, tube, ring, polygon, pyramid, roof, roundRoof, wedge, icosahedron, text, loft, gear, revolve, thread; the kind description says which of those it can measure and export. An editor (url) builds box, cube, cylinder, text, loft, sketch, revolve, thread. sketch is editor-only. Each parameter's description names the kinds it applies to.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "kind": {
      "type": "string",
      "enum": [
        "box",
        "cube",
        "cylinder",
        "cone",
        "sphere",
        "halfSphere",
        "torus",
        "tube",
        "ring",
        "polygon",
        "pyramid",
        "roof",
        "roundRoof",
        "wedge",
        "icosahedron",
        "text",
        "loft",
        "gear",
        "revolve",
        "thread",
        "sketch"
      ],
      "description": "Local mode builds box, cube, cylinder, cone, sphere, halfSphere, torus, tube, ring, polygon, pyramid, roof, roundRoof, wedge, loft, revolve as solids that measure and export as STL. A roundRoof's height may be at most half its width; a taller one fails to build. thread exports as STL but cannot be measured. icosahedron, text, gear are stored only: local mode records the parameters but cannot measure or export them; open the project in an editor for those. STEP export holds only box, cube, cylinder, cone, sphere; export the other solids as STL. sketch is editor-only: it needs an open editor (url), and local mode refuses it. An editor builds only box, cube, cylinder, text, loft, sketch, revolve, thread."
    },
    "profile": {
      "type": "array",
      "description": "For kind sketch: a closed 2D outline to extrude, as [x, z] pairs. For kind revolve: the closed outline to revolve, where x is distance from axis and z runs along it.",
      "items": {
        "type": "array",
        "items": {
          "type": "number"
        },
        "minItems": 2,
        "maxItems": 2
      }
    },
    "pitch": {
      "type": "number",
      "description": "For kind revolve/thread: axial rise per turn in mm. 0 is a plain revolve; negative is a left-hand thread."
    },
    "turns": {
      "type": "number",
      "description": "For kind revolve/thread: how many full turns to sweep (default 8 for a thread)."
    },
    "diameter": {
      "type": "number",
      "description": "For kind thread: outside diameter in mm, for a size the catalog does not list. The 60-degree ISO profile follows from this and the pitch."
    },
    "length": {
      "type": "number",
      "description": "For kind thread: how long the thread should be in mm, instead of giving turns."
    },
    "hole": {
      "type": "boolean",
      "description": "For kind thread: cut the form wider by a clearance so a bolt of that size fits, and mark the shape as a hole so grouping it with a solid taps that solid."
    },
    "clearance": {
      "type": "number",
      "description": "For kind thread with hole: how much wider to cut, per side, in mm (default 0.2 for printed parts)."
    },
    "startAngle": {
      "type": "number",
      "description": "For kind revolve: rotation the sweep starts at, in degrees."
    },
    "sweepAngle": {
      "type": "number",
      "description": "For kind revolve with no pitch: how far round to revolve, in degrees (±360)."
    },
    "name": {
      "type": "string"
    },
    "color": {
      "type": "string"
    },
    "x": {
      "type": "number"
    },
    "z": {
      "type": "number"
    },
    "elevation": {
      "type": "number"
    },
    "width": {
      "type": "number",
      "description": "For loft, this is the bottom end's width."
    },
    "depth": {
      "type": "number",
      "description": "For loft, this is the bottom end's depth."
    },
    "height": {
      "type": "number"
    },
    "size": {
      "type": [
        "number",
        "string"
      ],
      "description": "A number sets width, depth and height at once. For kind thread it may instead be a catalog designation carrying its own pitch: \"M2\" to \"M20\" metric coarse, or \"#4-40\" to \"1/2-13\" imperial UNC (default M8)."
    },
    "rotation": {
      "type": "number"
    },
    "rotationX": {
      "type": "number"
    },
    "rotationZ": {
      "type": "number"
    },
    "sides": {
      "type": "number",
      "description": "Number of flat sides around the axis, at least 3. For cylinder: default 96, which builds a true round cylinder; fewer builds a prism. For pyramid: default 4, a rectangular base; any other count is a regular polygon base. A cone and roundRoof are always round, whatever sides says."
    },
    "steps": {
      "type": "number",
      "description": "For sphere and halfSphere: display mesh segments around and over the surface (at least 4, default 32). The measured and exported solid is a true curved surface whatever steps says."
    },
    "bevel": {
      "type": "number",
      "description": "For tube and ring: wall thickness in mm, measured inward from the outer radius (default 4). It is clamped to at least 0.1 and at most the smaller outer radius less 0.1, so the bore never closes: on a 20 mm wide tube, any bevel above 9.9 builds a 9.9 mm wall. A 20x20x10 tube with bevel 4 has a 6 mm inner radius. For text: edge rounding in mm (default 0)."
    },
    "segments": {
      "type": "number",
      "description": "For text: curve segments per glyph outline (at least 1, default 2)."
    },
    "topRadius": {
      "type": "number",
      "description": "For cone: radius of the top in mm (default 0, a point)."
    },
    "baseRadius": {
      "type": "number",
      "description": "For cone: recorded base radius in mm (default half the width). It does not change the solid: a cone stands on half its width, so set width and depth to size the base."
    },
    "taperTopWidth": {
      "type": "number",
      "description": "For box, cube, cylinder in local mode: footprint width at the top of the extrusion in mm (default width). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it."
    },
    "taperTopDepth": {
      "type": "number",
      "description": "For box, cube, cylinder in local mode: footprint depth at the top of the extrusion in mm (default depth). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it."
    },
    "taperBottomWidth": {
      "type": "number",
      "description": "For box, cube, cylinder in local mode: footprint width at the bottom of the extrusion in mm (default width). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it."
    },
    "taperBottomDepth": {
      "type": "number",
      "description": "For box, cube, cylinder in local mode: footprint depth at the bottom of the extrusion in mm (default depth). Other kinds store it, but measuring or exporting a tapered one is refused. An editor ignores it."
    },
    "teeth": {
      "type": "number",
      "description": "For gear: tooth count (default 12)."
    },
    "toothSize": {
      "type": "number",
      "description": "For gear: radial tooth height in mm (default 2.5)."
    },
    "toothWidth": {
      "type": "number",
      "description": "For gear: tooth width in mm (default 0.54 of the tooth pitch, clamped between 0.12 and 0.82 of it)."
    },
    "centerHoleSize": {
      "type": "number",
      "description": "For gear: centre hole size in mm (default 6, clamped so it stays inside the tooth roots; 0 for none)."
    },
    "gearType": {
      "type": "string",
      "enum": [
        "spur",
        "helical",
        "bevel"
      ],
      "description": "For gear: tooth form (default spur)."
    },
    "helixAngle": {
      "type": "number",
      "description": "For gear with gearType helical: helix angle in degrees (default 22.5)."
    },
    "text": {
      "type": "string",
      "description": "For text: the characters to extrude (default TEXT)."
    },
    "font": {
      "type": "string",
      "description": "For text: font name (default Multilanguage)."
    },
    "loftBottomShape": {
      "type": "string",
      "enum": [
        "Oval",
        "Rectangle",
        "Triangle",
        "Pentagon",
        "Hexagon"
      ],
      "description": "loft only. Defaults to Rectangle."
    },
    "loftTopShape": {
      "type": "string",
      "enum": [
        "Oval",
        "Rectangle",
        "Triangle",
        "Pentagon",
        "Hexagon"
      ],
      "description": "loft only. Defaults to Oval."
    },
    "loftTopWidth": {
      "type": "number",
      "description": "loft only. Independent of the bottom's width, like a cone's top radius. Defaults to matching width."
    },
    "loftTopDepth": {
      "type": "number",
      "description": "loft only. Independent of the bottom's depth. Defaults to matching depth."
    },
    "loftBottomRotation": {
      "type": "number",
      "description": "loft only. Bottom end rotation in degrees."
    },
    "loftTopRotation": {
      "type": "number",
      "description": "loft only. Top end rotation in degrees."
    },
    "loftSegments": {
      "type": "number",
      "description": "loft only. Angular resolution, 8-128."
    },
    "loftLayers": {
      "type": "number",
      "description": "loft only. Vertical resolution, 2-80."
    }
  },
  "required": [
    "kind"
  ]
}
```
## sketchforge_import_mesh

### Description

Import a triangle mesh into SketchForge from raw position and optional normal arrays.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "name": {
      "type": "string"
    },
    "color": {
      "type": "string"
    },
    "x": {
      "type": "number"
    },
    "z": {
      "type": "number"
    },
    "elevation": {
      "type": "number"
    },
    "width": {
      "type": "number"
    },
    "depth": {
      "type": "number"
    },
    "height": {
      "type": "number"
    },
    "positions": {
      "type": "array",
      "items": {
        "type": "number"
      }
    },
    "normals": {
      "type": "array",
      "items": {
        "type": "number"
      }
    }
  },
  "required": [
    "positions"
  ]
}
```
## sketchforge_import_file

### Description

Import an STL, OBJ, or SVG file from the MCP host filesystem into SketchForge. The source filename supplies the shape name; color and placement use importer defaults. In local mode provide projectId and filePath; with url, the file is sent to POST /api/v1/imports. File reads are confined to SKETCHFORGE_MCP_FILES_DIR, or SKETCHFORGE_PROJECTS_DIR when unset; if both are unset, paths are unrestricted.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "filePath"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string"
    },
    "filePath": {
      "type": "string",
      "description": "Path to an .stl, .obj, or .svg file under the configured MCP files root; unrestricted when no root is set."
    }
  }
}
```
## sketchforge_import_stl

### Description

Local-only compatibility alias for sketchforge_import_file. Accepts STL, OBJ, or SVG files. Optional name, color, and placement fields override the imported shape. A remote url is not supported.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "filePath"
  ],
  "properties": {
    "projectId": {
      "type": "string"
    },
    "filePath": {
      "type": "string",
      "description": "Path to an .stl, .obj, or .svg file under the configured MCP files root; unrestricted when no root is set."
    },
    "name": {
      "type": "string"
    },
    "color": {
      "type": "string"
    },
    "x": {
      "type": "number"
    },
    "z": {
      "type": "number"
    },
    "elevation": {
      "type": "number"
    }
  }
}
```
## sketchforge_update_object

### Description

Update one object's exact dimensions, position, color, name, hole state, or rotations.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "color": {
      "type": "string"
    },
    "faceColors": {
      "type": "object",
      "description": "Optional colors keyed by stable face IDs from sketchforge_list_faces, such as {'face_abc':'#ff0000'}. Numeric face indexes remain accepted for older projects."
    },
    "hole": {
      "type": "boolean"
    },
    "x": {
      "type": "number"
    },
    "z": {
      "type": "number"
    },
    "elevation": {
      "type": "number"
    },
    "width": {
      "type": "number"
    },
    "depth": {
      "type": "number"
    },
    "height": {
      "type": "number"
    },
    "size": {
      "type": "number"
    },
    "rotation": {
      "type": "number"
    },
    "rotationX": {
      "type": "number"
    },
    "rotationZ": {
      "type": "number"
    }
  },
  "required": [
    "id"
  ]
}
```
## sketchforge_pattern_objects

### Description

Repeat SketchForge objects in a row or around a ring, the way the editor's Repeat panel does. Makes the copies; sketchforge_distribute_objects only re-spaces objects that already exist.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Object ids to repeat. If omitted, uses the current selection."
    },
    "kind": {
      "type": "string",
      "enum": [
        "linear",
        "circular"
      ],
      "description": "linear=a row; circular=a ring about a centre. Default linear."
    },
    "count": {
      "type": "number",
      "description": "Total copies including the original, so 4 adds 3 (2-200). Default 4."
    },
    "stepX": {
      "type": "number",
      "description": "For kind linear: centre-to-centre step along X in mm. This is a pitch, not a gap."
    },
    "stepZ": {
      "type": "number",
      "description": "For kind linear: centre-to-centre step along Z in mm."
    },
    "centerX": {
      "type": "number",
      "description": "For kind circular: X of the point to turn about."
    },
    "centerZ": {
      "type": "number",
      "description": "For kind circular: Z of the point to turn about."
    },
    "sweepAngle": {
      "type": "number",
      "description": "For kind circular: how far round to spread the copies, in degrees. 360 divides evenly so the last does not land on the first; a partial sweep puts one copy at each end. Default 360."
    },
    "rotateCopies": {
      "type": "boolean",
      "description": "For kind circular: whether each copy turns to follow the ring (default true). A spoke or vane needs it; a bolt hole does not."
    }
  }
}
```
## sketchforge_distribute_objects

### Description

Spread three or more SketchForge objects evenly along an axis, the way the editor's Distribute buttons do. The outermost two keep their places and define the span.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Object ids to distribute. If omitted, uses the current selection."
    },
    "axis": {
      "type": "string",
      "enum": [
        "x",
        "z"
      ],
      "description": "Axis to spread along. Omit to use whichever axis the objects are already most spread along."
    },
    "spacing": {
      "type": "string",
      "enum": [
        "gaps",
        "centers"
      ],
      "description": "gaps=equal clear space between objects (default); centers=equal centre-to-centre pitch."
    }
  }
}
```
## sketchforge_align_objects

### Description

Align two or more SketchForge objects using the same alignment logic as the editor Alignment button.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Object ids to align. If omitted, uses the current selection."
    },
    "anchorId": {
      "type": "string",
      "description": "Optional object id to keep fixed as the alignment reference."
    },
    "axis": {
      "type": "string",
      "enum": [
        "x",
        "y",
        "z"
      ],
      "description": "x=left/right, z=front/back, y=bottom/top."
    },
    "target": {
      "type": "string",
      "enum": [
        "min",
        "center",
        "max"
      ],
      "description": "Which side/center to align."
    }
  },
  "required": [
    "axis",
    "target"
  ]
}
```
## sketchforge_group_objects

### Description

Group objects by id using SketchForge's normal grouping/boolean pipeline.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "ids"
  ]
}
```
## sketchforge_ungroup_objects

### Description

Ungroup one or more grouped objects by id and preserve their edited geometry.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "id": {
      "type": "string"
    }
  }
}
```
## sketchforge_boolean_cut

### Description

Cut solids with hole objects. Provide solidIds and holeIds; the result replaces the operands.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "solidIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "holeIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "solidIds",
    "holeIds"
  ]
}
```
## sketchforge_separate_parts

### Description

Separate one disconnected multi-part object into independent objects.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "id": {
      "type": "string"
    }
  }
}
```
## sketchforge_explode_step_assembly

### Description

Explode an imported STEP assembly into independent exact solids. Limited to 200 solids and 8 MiB source files.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string"
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "shapeId": {
      "type": "string"
    }
  },
  "required": [
    "projectId",
    "shapeId"
  ]
}
```
## sketchforge_list_edges

### Description

List real CAD edge ids for one object so a later chamfer/fillet can target specific edges.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "id": {
      "type": "string"
    },
    "sharpAngle": {
      "type": "number"
    }
  },
  "required": [
    "id"
  ]
}
```
## sketchforge_apply_edge_treatment

### Description

Apply chamfer or fillet to specific edge ids returned by sketchforge_list_edges.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "id": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "chamfer",
        "fillet"
      ]
    },
    "edgeIds": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "type": "number"
          }
        },
        {
          "type": "string",
          "enum": [
            "all"
          ]
        }
      ]
    },
    "allEdges": {
      "type": "boolean"
    },
    "amount": {
      "type": "number"
    },
    "chamferAngle": {
      "type": "number"
    },
    "sharpAngle": {
      "type": "number"
    },
    "quality": {
      "type": "string",
      "enum": [
        "draft",
        "standard",
        "fine"
      ]
    },
    "preserveEdgeSize": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "kind",
    "edgeIds",
    "amount"
  ]
}
```
## sketchforge_inspect_errors

### Description

Inspect the editor notice, last MCP error, and active edge modifier error.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    }
  }
}
```
## sketchforge_capture_image

### Description

Capture a PNG image from current/home/top/bottom/front/back/right/left view. Editor mode captures the live viewport. Local project mode rasterises the kernel's hidden-line drawing of the stored geometry: a named face is that one view, home and current are the four-view grid. Prefer sketchforge_project_view for the SVG itself.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "face": {
      "type": "string",
      "enum": [
        "current",
        "home",
        "top",
        "bottom",
        "front",
        "back",
        "right",
        "left"
      ]
    }
  }
}
```
## sketchforge_export_scene

### Description

Export selected objects or the whole scene as STL, OBJ, 3MF, STEP, SKF, a ZIP kit, SVG drawings, or section DXF. DXF needs section {plane, offset}. Set outputPath to save on the MCP host; writes are confined to SKETCHFORGE_MCP_FILES_DIR, or SKETCHFORGE_PROJECTS_DIR when unset. If both are unset, paths are unrestricted. Existing files require overwrite: true.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "format": {
      "type": "string",
      "enum": [
        "stl",
        "obj",
        "3mf",
        "step",
        "skf",
        "zip",
        "svg",
        "dxf"
      ]
    },
    "view": {
      "type": "string",
      "enum": [
        "multiview",
        "front",
        "back",
        "top",
        "bottom",
        "left",
        "right",
        "iso"
      ],
      "description": "For svg only: one named view, or the multiview grid (default)."
    },
    "section": {
      "type": "object",
      "description": "For svg or dxf section export.",
      "properties": {
        "plane": {
          "type": "string",
          "enum": [
            "xy",
            "xz",
            "yz"
          ]
        },
        "offset": {
          "type": "number"
        }
      },
      "required": [
        "plane",
        "offset"
      ]
    },
    "shapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional object ids."
    },
    "name": {
      "type": "string"
    },
    "outputPath": {
      "type": "string",
      "description": "Destination path under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set."
    },
    "overwrite": {
      "type": "boolean",
      "description": "Set true to replace an existing output file."
    }
  },
  "required": [
    "format"
  ]
}
```
## sketchforge_project_view

### Description

Draw a stored project as an SVG by the CAD kernel's hidden-line removal: true curves, hidden edges dashed, a gnomon per view and the overall size. The multiview grid (front, top, right, iso) is the readable picture of the geometry; a single view is a 2D drawing of that face. Works offline or against a server when url is supplied.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "The server-side project id."
    },
    "view": {
      "type": "string",
      "enum": [
        "multiview",
        "front",
        "back",
        "top",
        "bottom",
        "left",
        "right",
        "iso"
      ],
      "description": "One named view, or the multiview grid (default)."
    },
    "shapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional object ids; defaults to the current selection, or the whole scene when nothing is selected."
    },
    "name": {
      "type": "string",
      "description": "Optional base name for the file."
    },
    "outputPath": {
      "type": "string",
      "description": "Optional destination path under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set. SVG text is returned inline otherwise."
    },
    "overwrite": {
      "type": "boolean",
      "description": "Set true to replace an existing output file."
    }
  }
}
```
## sketchforge_section_view

### Description

Return an exact CAD section drawing as SVG by cutting the stored solids with one axis-aligned plane in drawing coordinates. offset is the coordinate of the omitted axis, in millimetres. Works offline or against a server when url is supplied.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "plane",
    "offset"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "The project id."
    },
    "plane": {
      "type": "string",
      "enum": [
        "xy",
        "xz",
        "yz"
      ],
      "description": "Plane in drawing coordinates; XY omits Z, XZ omits Y, and YZ omits X."
    },
    "offset": {
      "type": "number",
      "description": "Coordinate of the omitted axis in millimetres; must intersect the selected scene."
    },
    "shapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional object ids; defaults to the current selection, or the whole scene when nothing is selected."
    },
    "name": {
      "type": "string",
      "description": "Optional base name for the file."
    },
    "outputPath": {
      "type": "string",
      "description": "Optional destination path under SKETCHFORGE_MCP_FILES_DIR (or SKETCHFORGE_PROJECTS_DIR when unset); unrestricted if neither is set. SVG text is returned inline otherwise."
    },
    "overwrite": {
      "type": "boolean",
      "description": "Set true to replace an existing output file."
    }
  }
}
```
## sketchforge_validate_scene

### Description

Check triangle topology, conservative AABB clearance bounds, and exact Manifold intersection volumes for overlapping scene objects.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "shapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "excludeShapeIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```
## sketchforge_check_interference

### Description

Check exact OCCT surface gaps and overlap volumes between visible, non-cutter solids. Clearance is in millimetres. The report refuses the whole request above 128 shapes or 512 AABB candidate pairs; narrow ids or reduce clearance. Works offline or against a server.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "Project id in SKETCHFORGE_PROJECTS_DIR when running the MCP in local mode."
    },
    "editorNumber": {
      "type": "number",
      "description": "The 5-digit SketchForge editor number from sketchforge_list_editors."
    },
    "editorId": {
      "type": "string",
      "description": "Optional internal editor id. Prefer editorNumber for human-directed use."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Command timeout in milliseconds. Defaults to 15000."
    },
    "ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional shape ids; defaults to all visible non-cutter solids."
    },
    "clearance": {
      "type": "number",
      "minimum": 0,
      "description": "Maximum exact surface gap to report, in mm (default 0)."
    }
  }
}
```
## sketchforge_list_faces

### Description

List a stored project shape's CAD faces with stable IDs and compatibility indexes, plus the direction name each one can be opened by. Use the stable ID to assign a face color; use the index for treatments, measurements, and shell openings. Works offline or against a server when url is supplied.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "shapeId"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "The server-side project id."
    },
    "shapeId": {
      "type": "string",
      "description": "The id of the shape to read."
    }
  }
}
```
## sketchforge_measure_shape

### Description

Measure every edge and face of a stored project shape from its exact CAD geometry: edge length, the radius and diameter of a circular edge or arc, face area, and a cylindrical face's radius. Exact (OCCT), so a round hole has a real radius rather than the chord length of a facet. A measurement that is not meaningful for the entity -- the radius of a straight edge, of an ellipse, or of a cone whose radius changes along it -- comes back null with a reason in radiusUnavailable. Works offline or against a server when url is supplied.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "shapeId"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "The server-side project id."
    },
    "shapeId": {
      "type": "string",
      "description": "The id of the shape to measure."
    }
  }
}
```
## sketchforge_measure_between

### Description

The exact minimum distance between two CAD entities in a stored project, and the angle between them when both are flat faces. Each end names a shape and either the whole solid, or one edge or face by the index the measurement listing gave it. Distance is measured between the real surfaces where the shapes sit, so two round posts 5mm apart at their nearest walls read 5 -- not the gap between their bounding boxes. Works offline or against a server when url is supplied.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "from",
    "to"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "The server-side project id."
    },
    "from": {
      "type": "object",
      "required": [
        "shapeId"
      ],
      "properties": {
        "shapeId": {
          "type": "string",
          "description": "The shape this end is part of."
        },
        "entity": {
          "type": "string",
          "enum": [
            "shape",
            "edge",
            "face"
          ],
          "description": "What to measure to. 'shape' is the whole solid and takes no index; 'edge' and 'face' need one."
        },
        "index": {
          "type": "number",
          "description": "Which edge or face, by the index the measurement listing gave it."
        }
      }
    },
    "to": {
      "type": "object",
      "required": [
        "shapeId"
      ],
      "properties": {
        "shapeId": {
          "type": "string",
          "description": "The shape this end is part of."
        },
        "entity": {
          "type": "string",
          "enum": [
            "shape",
            "edge",
            "face"
          ]
        },
        "index": {
          "type": "number"
        }
      }
    }
  }
}
```
## sketchforge_shape_properties

### Description

Read one stored shape's volume, surface area, center of mass, bounds and validity, with provenance identifying the geometry source and whether precision is exact or tessellated. Works offline or against a server when url is supplied.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "shapeId"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "The project id."
    },
    "shapeId": {
      "type": "string",
      "description": "The shape id."
    }
  }
}
```
## sketchforge_estimate_wall_thickness

### Description

Estimate wall thickness from a 5 by 5 UV sample grid on each face. This is a screening estimate and may miss thin regions between samples; it is not a certified minimum-thickness result.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "shapeId"
  ],
  "properties": {
    "url": {
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "shapeId": {
      "type": "string"
    }
  }
}
```
## sketchforge_hollow_shape

### Description

Hollow a stored project shape out to a wall of a given thickness, optionally leaving faces open so a box becomes a tray. Exact (OCCT), so the result still exports to STEP and can still be filleted. A sphere, torus, cone or round-walled tube cannot be hollowed at any thickness. Works offline or against a server when url is supplied.

### Input schema

```json
{
  "type": "object",
  "required": [
    "projectId",
    "shapeId",
    "thickness"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to work offline with local project files."
    },
    "projectId": {
      "type": "string",
      "description": "The server-side project id."
    },
    "shapeId": {
      "type": "string",
      "description": "The id of the shape to hollow."
    },
    "thickness": {
      "type": "number",
      "description": "Wall thickness in mm, measured inwards. Must be well under half the part's smallest span."
    },
    "openFaces": {
      "type": "array",
      "description": "Faces to leave open. Direction names (\"top\", \"bottom\", \"left\", \"right\", \"front\", \"back\") or face indexes from sketchforge_list_faces. Omit for a sealed hollow.",
      "items": {
        "type": [
          "string",
          "number"
        ]
      }
    }
  }
}
```
## sketchforge_list_macros

### Description

List the macro scripts an operator has installed in SKETCHFORGE_MACRO_DIR. These are the only macros sketchforge_run_macro will run.

### Input schema

```json
{
  "type": "object",
  "properties": {}
}
```
## sketchforge_run_macro

### Description

Run one installed macro by name, offline by default or against an optional SketchForge server URL. Parameters are the macro's own declared parameters. Only files already present in SKETCHFORGE_MACRO_DIR can be run; code cannot be passed in.

### Input schema

```json
{
  "type": "object",
  "required": [
    "macro"
  ],
  "properties": {
    "url": {
      "type": "string",
      "description": "Optional SketchForge server URL. Omit to run against local project files."
    },
    "macro": {
      "type": "string",
      "description": "A file name from sketchforge_list_macros."
    },
    "params": {
      "type": "object",
      "description": "The macro's parameters, as name/value pairs of numbers, strings or booleans."
    },
    "projectId": {
      "type": "string",
      "description": "The project to build in, for a macro declaring project: target."
    },
    "timeoutMs": {
      "type": "number",
      "description": "How long to let the macro run. Defaults to 120000."
    }
  }
}
```
