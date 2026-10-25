---
owner: "MCP"
audience: "MCP users"
title: "SketchForge MCP"
slug: "/docs/skills/sketchforge-mcp-skill/SKILL"
name: sketchforge-mcp-skill
description: Control a live local SketchForge editor through its MCP server. Use when Codex needs to list currently open SketchForge editor tabs, target a tab by editorNumber/projectName, read the current scene, list or select objects, create boxes/cubes/cylinders/sketch extrusions, update dimensions/position/rotation, align objects, group/ungroup/cut/separate parts, list exact CAD edge ids, apply chamfer/fillet to specific edges, inspect editor errors, or capture viewport images from view-cube angles.
---

# SketchForge MCP

## Quick Start

Use this skill only with a local SketchForge app running in development mode.

1. Start SketchForge from the repo:

<!-- runnable-exempt: This starts the local development server for the user; it is an operational npm script, not a maintained standalone example. -->
```bash
npm run dev
```

2. Open an editor tab at `http://localhost:3000/?editor=1`.

3. Configure your MCP client to start the stdio server:

<!-- runnable-exempt: This installs the published MCP command for the user; it depends on npm registry state and is not repository-owned source. -->
```bash
npx -y -p @constructorfleet/sketchforge3d sketchforge-mcp
```

From a checkout of the repository, `npm run mcp:sketchforge` runs the same
bridge without the download.

The MCP server talks to the app through `/api/sketchforge-mcp`. Open editor tabs heartbeat into that route and receive commands from it. Production and Docker/static builds intentionally return 404 for the MCP route.

For a complete executable example that creates, reads, and exports a temporary local project, see [MCP examples](../../mcp/EXAMPLES.md).

## Local Project Tools

When no `url` is supplied, project tools read and write files under `SKETCHFORGE_PROJECTS_DIR`. Use `sketchforge_list_projects`, `sketchforge_create_project`, and `sketchforge_import_project` to find or prepare projects; `sketchforge_read_scene`, `sketchforge_list_objects`, and `sketchforge_shape_properties` to inspect them; and `sketchforge_create_shape`, `sketchforge_import_file`, `sketchforge_import_stl`, and the other mutation tools to change them. The `sketchforge_import_stl` alias is local-only and accepts an STL, OBJ, or SVG file plus optional name, color, and placement overrides. `sketchforge_export_scene` can save STL, OBJ, 3MF, STEP, SKF, ZIP, SVG, or DXF output.

Import and export file paths must resolve under `SKETCHFORGE_MCP_FILES_DIR`, or under `SKETCHFORGE_PROJECTS_DIR` when the file root is unset. Existing export files are preserved unless `overwrite: true` is supplied. If neither root is configured, paths are unrestricted for compatibility. `sketchforge_import_stl` does not accept `url`; use `sketchforge_import_file` for imports through a configured server URL.

## Client Compatibility

Codex can use this folder as a skill and the MCP server as tools. Install the folder under `~/.codex/skills/sketchforge-mcp-skill` and configure the MCP server in Codex.

Claude Desktop does not read Codex skills, but it can use the same `sketchforge-mcp` server through Claude's `mcpServers` JSON config -- `docs/mcp/claude-desktop-config.example.json` is a ready-made entry. Use the repository README for client setup examples.

## Targeting Editors

Always call `sketchforge_list_editors` first when the user mentions multiple projects, tabs, or a number like `49536`.

Use `editorNumber` for follow-up commands. It is a 5-digit per-tab number stored in browser `sessionStorage`, so two open SketchForge tabs have different numbers. The list also includes `projectName`, `projectId`, URL, shape count, selected count, notice, and last error.

If only one editor is open, commands may omit `editorNumber`; the server will target the sole live editor.

## Core Workflow

Read scene/object state before modifying geometry:

```text
sketchforge_list_editors
sketchforge_read_scene({ editorNumber })
sketchforge_list_objects({ editorNumber })
```

For object edits, use exact object `id` values from the scene. Do not invent object names; names are helpful labels only.

Useful tools:

- `sketchforge_select_objects`: select ids in the live editor.
- `sketchforge_delete_objects`: delete ids in the live editor, or delete the current selection when ids are omitted.
- `sketchforge_create_shape`: create `box`, `cube`, `cylinder`, or `sketch`.
- `sketchforge_import_mesh`: import STL-style mesh data into the editor.
- `sketchforge_update_object`: set exact dimensions, position, color, name, hole state, and `rotation`/`rotationX`/`rotationZ`.
- `sketchforge_align_objects`: align two or more ids using the same logic as the editor Alignment button.
- `sketchforge_group_objects`: group selected ids using the normal SketchForge group/boolean path.
- `sketchforge_boolean_cut`: pass `solidIds` and `holeIds`; the result replaces the operands.
- `sketchforge_ungroup_objects`: restore grouped children while preserving edited child geometry.
- `sketchforge_separate_parts`: split disconnected parts in one object.
- `sketchforge_inspect_errors`: read the editor notice, edge modifier error, and last MCP error.

## Edge Features

Chamfer and fillet are separate edge-treatment operations in SketchForge. Do not fake a chamfer/fillet with cylinders or extra decorative geometry. Cylinders are only appropriate when the requested shape itself has a circular/rounded 2D footprint, such as rounded tray corners or a cylindrical peg.

For chamfer/fillet, never guess edge ids.

1. Call `sketchforge_list_edges({ editorNumber, id, sharpAngle })`.
2. Use returned `selectableEdgeIds` or inspect returned edge geometry.
3. Call `sketchforge_apply_edge_treatment({ editorNumber, id, kind, edgeIds, amount, chamferAngle })`.

`edgeIds` can be an array of numeric ids or `"all"`. `kind` is `chamfer` or `fillet`. The app commits the result through normal history, so undo/redo works.

## Images

Use `sketchforge_capture_image` for viewport PNGs. `face` can be `current`, `home`, `top`, `bottom`, `front`, `back`, `right`, or `left`. In editor mode these use the same camera/view-cube orientation logic as the editor UI; in local project mode the PNG is a rasterised hidden-line drawing of the stored geometry, with `home` and `current` giving a four-view grid. Use `sketchforge_project_view` for that drawing as SVG text -- `view` is `multiview` (front, top, right and iso, with a gnomon per panel and the overall size) or any one named view -- which reads without vision.

Use `sketchforge_section_view` for exact contours cut through the model. Give it `plane` (`xy`, `xz`, or `yz`) and the coordinate `offset` in millimetres; the plane must intersect the selected geometry. Use `outputPath` when the SVG should be saved instead of returned inline.

## Visual Verification

After creating or heavily modifying an object, use vision when available. Capture at least one useful viewport image with `sketchforge_capture_image`; for 3D geometry, prefer `home` plus any needed orthographic-style faces such as `top`, `front`, or `right`. Inspect the rendered result against the user's requirements before saying the task is done.

Do not rely only on numeric scene data when the user asked for a physical object. Use numeric checks for dimensions and visual checks for whether the model reads correctly.

## Safety

This bridge is local-development only. If a command fails, call `sketchforge_inspect_errors` before retrying. For geometry operations that can be expensive, set a larger `timeoutMs` on the tool call.
