import { writeFileSync } from "node:fs";
import path from "node:path";

const projectsDir = process.env.SKETCHFORGE_PROJECTS_DIR;
let backend;
let enginePackagePromise;

async function getBackend() {
  if (!projectsDir) throw new Error("Set SKETCHFORGE_PROJECTS_DIR to a directory containing SketchForge project files.");
  if (!backend) {
    enginePackagePromise ??= import("@sketchforge/engine");
    const { createEngine, directoryProjectStore } = await enginePackagePromise;
    const store = directoryProjectStore(projectsDir);
    backend = { store, engine: createEngine(store), package: await enginePackagePromise };
  }
  return backend;
}

function requireProjectId(args) {
  if (typeof args.projectId !== "string" || !args.projectId.trim()) {
    throw new Error("projectId is required in local mode. Use a project id from the configured project directory.");
  }
  return args.projectId;
}

async function unwrap(result) {
  if (result.ok) return result.value;
  throw new Error(`Engine operation failed: ${JSON.stringify(result.failure)}`);
}

function objectSummary(shape) {
  const { id, name, kind, x, z, elevation, width, depth, height, rotation, rotationX, rotationZ, color, hole, locked, group, features } = shape;
  return { id, name, kind, x, z, elevation, width, depth, height, rotation, rotationX, rotationZ, color, hole, locked, ...(group ? { group } : {}), ...(features ? { features } : {}) };
}

function stlBytesFromPositions(positions) {
  if (!Array.isArray(positions) || positions.length === 0 || positions.length % 9 !== 0 || !positions.every(Number.isFinite)) {
    throw new Error("positions must contain finite XYZ coordinates for one or more complete triangles.");
  }
  const facets = [];
  for (let i = 0; i < positions.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(i, i + 9);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    facets.push(` facet normal ${nx / length} ${ny / length} ${nz / length}\n  outer loop\n   vertex ${ax} ${ay} ${az}\n   vertex ${bx} ${by} ${bz}\n   vertex ${cx} ${cy} ${cz}\n  endloop\n endfacet`);
  }
  return new TextEncoder().encode(`solid SketchForge MCP\n${facets.join("\n")}\nendsolid SketchForge MCP\n`);
}

async function readScene(args) {
  const id = requireProjectId(args);
  const { engine } = await getBackend();
  const project = await unwrap(await engine.project(id));
  const allow = Array.isArray(args.shapeIds) ? new Set(args.shapeIds) : null;
  const deny = new Set(Array.isArray(args.excludeShapeIds) ? args.excludeShapeIds : []);
  const shapes = project.shapes.filter((shape) => (!allow || allow.has(shape.id)) && !deny.has(shape.id));
  const rawIds = Array.isArray(args.includeRawShapeIds) ? new Set(args.includeRawShapeIds) : null;
  return {
    projectId: project.projectId,
    name: project.name,
    createdAt: project.createdAt,
    revision: project.revision,
    snapGrid: project.snapGrid,
    workspace: project.workspace,
    shapeCount: shapes.length,
    objects: shapes.map(objectSummary),
    ...(args.includeRawShapes === true || rawIds ? {
      rawShapes: shapes.filter((shape) => rawIds ? rawIds.has(shape.id) : args.includeRawShapes === true),
    } : {}),
  };
}

async function exportScene(args) {
  const id = requireProjectId(args);
  const { store, package: enginePackage } = await getBackend();
  const document = await store.read(id);
  if (!document) throw new Error(`Project not found: ${id}`);
  const shapes = Array.isArray(args.shapeIds) ? document.shapes.filter((shape) => args.shapeIds.includes(shape.id)) : document.shapes;
  if (args.format === "skf") {
    const bytes = await enginePackage.exportSkfProject({
      projectId: id, projectName: document.projectName, createdAt: document.createdAt, modifiedAt: Date.now(),
      shapes, history: document.history, historyIndex: document.historyIndex, assets: document.assets,
      workspace: document.workspace, snapGrid: document.snapGrid, placementElevation: document.placementElevation,
      placementWorkplane: document.placementWorkplane, sketchPlacementWorkplane: document.sketchPlacementWorkplane,
    });
    const artifact = { filename: `${args.name || document.projectName}.skf`, mimeType: "application/vnd.sketchforge.project+zip", bytes: bytes.byteLength, shapeCount: shapes.length, base64: Buffer.from(bytes).toString("base64") };
    if (typeof args.outputPath === "string" && args.outputPath.trim()) {
      const destination = path.resolve(args.outputPath);
      writeFileSync(destination, bytes);
      return { ...artifact, base64: undefined, savedTo: destination };
    }
    return artifact;
  }
  if (args.format === "step") {
    const result = await enginePackage.exportShapesToStep(shapes.filter((shape) => shape.hidden !== true));
    const artifact = { filename: `${args.name || document.projectName}.step`, mimeType: "model/step", bytes: result.blob.size, exportedCount: result.exportedCount, skipped: result.skipped, base64: Buffer.from(await result.blob.arrayBuffer()).toString("base64") };
    if (typeof args.outputPath === "string" && args.outputPath.trim()) {
      const destination = path.resolve(args.outputPath);
      writeFileSync(destination, Buffer.from(artifact.base64, "base64"));
      return { ...artifact, base64: undefined, savedTo: destination };
    }
    return artifact;
  }
  throw new Error(`Local export currently supports SKF and STEP; ${args.format} needs the editor export adapter.`);
}

export async function callLocalEngineTool(name, args = {}) {
  if (["sketchforge_list_editors", "sketchforge_select_objects", "sketchforge_mirror_objects", "sketchforge_inspect_errors", "sketchforge_capture_image", "sketchforge_validate_scene"].includes(name)) {
    throw new Error(`${name} needs an open SketchForge editor and is unavailable in local mode.`);
  }
  const id = requireProjectId(args);
  const { engine } = await getBackend();
  switch (name) {
    case "sketchforge_read_scene":
    case "sketchforge_list_objects":
      return readScene(args);
    case "sketchforge_create_shape":
      return unwrap(await engine.addShapes(id, [args]));
    case "sketchforge_import_mesh": {
      const imported = await unwrap(await engine.importMesh(id, {
        fileName: `${args.name || "Imported mesh"}.stl`,
        bytes: stlBytesFromPositions(args.positions),
        mediaType: "model/stl",
      }));
      const changes = Object.fromEntries(["name", "color", "x", "z", "elevation"].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
      return Object.keys(changes).length ? unwrap(await engine.changeShape(id, imported.shape.id, changes)) : imported;
    }
    case "sketchforge_update_object": {
      const { id: shapeId, projectId, ...changes } = args;
      return unwrap(await engine.changeShape(id, shapeId, changes));
    }
    case "sketchforge_delete_objects": {
      const ids = args.ids ?? (args.id ? [args.id] : []);
      const removed = [];
      for (const shapeId of ids) removed.push(await unwrap(await engine.removeShape(id, shapeId)));
      return { removed };
    }
    case "sketchforge_align_objects":
      return unwrap(await engine.align(id, args));
    case "sketchforge_distribute_objects":
      return unwrap(await engine.distribute(id, args));
    case "sketchforge_pattern_objects":
      return unwrap(await engine.pattern(id, { ...args, kind: args.kind ?? "linear", count: args.count ?? 4 }));
    case "sketchforge_group_objects":
      return unwrap(await engine.group(id, args.ids));
    case "sketchforge_ungroup_objects": {
      const results = [];
      for (const shapeId of args.ids ?? (args.id ? [args.id] : [])) results.push(await unwrap(await engine.ungroup(id, shapeId)));
      return { results };
    }
    case "sketchforge_boolean_cut":
      return unwrap(await engine.cut(id, { solidIds: args.solidIds, holeIds: args.holeIds }));
    case "sketchforge_separate_parts":
      return unwrap(await engine.separate(id, args.id));
    case "sketchforge_list_edges":
      return unwrap(await engine.edges(id, args.shapeId ?? args.id));
    case "sketchforge_list_faces":
      return unwrap(await engine.faces(id, args.shapeId));
    case "sketchforge_measure_shape":
      return unwrap(await engine.measurements(id, args.shapeId));
    case "sketchforge_measure_between":
      return unwrap(await engine.measureBetween(id, args.from, args.to));
    case "sketchforge_apply_edge_treatment":
      return unwrap(await engine.treat(id, args.id, {
        kind: args.kind,
        amount: args.amount,
        angle: args.chamferAngle,
        edges: args.allEdges || args.edgeIds === "all" ? undefined : args.edgeIds,
      }));
    case "sketchforge_hollow_shape":
      return unwrap(await engine.shell(id, args.shapeId, { thickness: args.thickness, openFaces: args.openFaces }));
    case "sketchforge_export_scene":
      return exportScene(args);
    default:
      throw new Error(`${name} needs an open SketchForge editor and is unavailable in local mode.`);
  }
}
