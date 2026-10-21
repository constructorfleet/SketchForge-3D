import { writeFileSync } from "node:fs";
import path from "node:path";

const projectsDir = process.env.SKETCHFORGE_PROJECTS_DIR;
let backend;
let enginePackagePromise;
let selectedObjectIds = [];

async function getBackend() {
  if (!projectsDir) throw new Error("Set SKETCHFORGE_PROJECTS_DIR to a directory containing SketchForge project files.");
  if (!backend) {
    enginePackagePromise ??= import("@constructorfleet/sketchforge-engine");
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
  const requestedIds = Array.isArray(args.shapeIds) && args.shapeIds.length ? args.shapeIds : selectedObjectIds;
  const artifact = await enginePackage.exportProjectScene(document, {
    format: args.format,
    shapeIds: requestedIds.length ? requestedIds : undefined,
    name: args.name,
  });
  const bytes = artifact.data;
  const response = {
    format: artifact.format,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    bytes: bytes.byteLength,
    shapeCount: artifact.shapeCount,
    ...(artifact.exportedCount === undefined ? {} : { exportedCount: artifact.exportedCount }),
    ...(artifact.skipped === undefined ? {} : { skipped: artifact.skipped }),
    base64: Buffer.from(bytes).toString("base64"),
  };
  if (typeof args.outputPath === "string" && args.outputPath.trim()) {
    const destination = path.resolve(args.outputPath);
    writeFileSync(destination, bytes);
    return { ...response, base64: undefined, savedTo: destination };
  }
  return response;
}

async function validateScene(args) {
  const id = requireProjectId(args);
  const { engine, package: enginePackage } = await getBackend();
  const project = await unwrap(await engine.project(id));
  const requested = Array.isArray(args.shapeIds) && args.shapeIds.length ? new Set(args.shapeIds) : null;
  const excluded = new Set(Array.isArray(args.excludeShapeIds) ? args.excludeShapeIds : []);
  const shapes = project.shapes.filter((shape) => (!requested || requested.has(shape.id)) && !excluded.has(shape.id) && !shape.hidden && !shape.hole);
  const records = await Promise.all(shapes.map(async (shape) => {
    try {
      const [mesh] = await enginePackage.meshProjectShapes([shape]);
      if (!mesh) throw new Error("No mesh could be generated.");
      const bounds = mesh.vertices.reduce((b, [x,y,z]) => ({ minX: Math.min(b.minX,x), maxX: Math.max(b.maxX,x), minY: Math.min(b.minY,y), maxY: Math.max(b.maxY,y), minZ: Math.min(b.minZ,z), maxZ: Math.max(b.maxZ,z) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
      const topology = enginePackage.analyzeMeshTopology(mesh.vertices, mesh.faces);
      return { id: shape.id, name: shape.name, mesh, bounds, topology };
    } catch (error) {
      return { id: shape.id, name: shape.name, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const topology = records.map(({ id: objectId, name, topology: report, error }) => error ? { id: objectId, name, error } : { id: objectId, name, ...report });
  const validRecords = records.filter((record) => record.mesh);
  const clearances = [];
  const intersectionPairs = [];
  for (let i = 0; i < validRecords.length; i += 1) for (let j = i + 1; j < validRecords.length; j += 1) {
    const a = validRecords[i].bounds, b = validRecords[j].bounds;
    const gaps = [Math.max(0, b.minX-a.maxX, a.minX-b.maxX), Math.max(0, b.minY-a.maxY, a.minY-b.maxY), Math.max(0, b.minZ-a.maxZ, a.minZ-b.maxZ)];
    clearances.push({ fromId: validRecords[i].id, toId: validRecords[j].id, lowerBound: Math.hypot(...gaps), overlappingBounds: gaps.every((gap) => gap === 0) });
    if (gaps.every((gap) => gap === 0)) intersectionPairs.push([validRecords[i], validRecords[j]]);
  }
  const intersections = [];
  if (intersectionPairs.length) {
    const { default: manifoldModule } = await import("manifold-3d");
    const runtime = await manifoldModule();
    runtime.setup();
    const asSolid = (mesh) => {
      const meshData = new runtime.Mesh({
        numProp: 3,
        vertProperties: Float32Array.from(mesh.vertices.flat()),
        triVerts: Uint32Array.from(mesh.faces.flat()),
        tolerance: 0.0001,
      });
      meshData.merge();
      return { meshData, solid: runtime.Manifold.ofMesh(meshData) };
    };
    for (const [left, right] of intersectionPairs) {
      let a, b, overlap;
      try {
        a = asSolid(left.mesh); b = asSolid(right.mesh);
        overlap = a.solid.intersect(b.solid);
        const status = overlap.status();
        if (status !== "NoError") throw new Error(`Manifold status ${status}`);
        const volume = Math.max(0, overlap.volume());
        intersections.push({ fromId: left.id, toId: right.id, volume, intersects: volume > 1e-6 });
      } catch (error) {
        intersections.push({ fromId: left.id, toId: right.id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        overlap?.delete(); a?.solid?.delete(); b?.solid?.delete();
      }
    }
  }
  return { objectsChecked: shapes.length, topology, clearances, intersections, clearanceMethod: "AABB lower bound; conservative, not exact surface distance.", intersectionMethod: "Manifold intersection volume for overlapping AABB pairs; unsupported or invalid meshes report an error per pair." };
}

async function captureScene(args) {
  const id = requireProjectId(args);
  const { engine, package: enginePackage } = await getBackend();
  const project = await unwrap(await engine.project(id));
  const shapes = project.shapes.filter((shape) => !shape.hidden && !shape.hole);
  const meshes = await enginePackage.meshProjectShapes(shapes);
  const face = ["home", "top", "bottom", "front", "back", "right", "left"].includes(args.face) ? args.face : "home";
  const direction = {
    top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
  }[face] ?? [1, 1, 1];
  const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const camera = unit(direction);
  const right = face === "top" ? [1, 0, 0] : face === "bottom" ? [-1, 0, 0] : unit([camera[2], 0, -camera[0]]);
  const up = face === "top" || face === "bottom" ? [0, 0, -1] : unit([
    camera[1] * right[2] - camera[2] * right[1],
    camera[2] * right[0] - camera[0] * right[2],
    camera[0] * right[1] - camera[1] * right[0],
  ]);
  const all = meshes.flatMap((mesh, meshIndex) => mesh.faces.map((faceIndices) => ({
    meshIndex,
    points: faceIndices.map((index) => mesh.vertices[index]),
  })));
  const projectPoint = (point) => [point[0] * right[0] + point[1] * right[1] + point[2] * right[2], point[0] * up[0] + point[1] * up[1] + point[2] * up[2]];
  const projected = all.map((triangle) => ({ ...triangle, projected: triangle.points.map(projectPoint), depth: triangle.points.reduce((sum, point) => sum + point.reduce((d, value, i) => d + value * camera[i], 0), 0) / 3 }));
  const extent = projected.flatMap((triangle) => triangle.projected);
  const minX = extent.length ? Math.min(...extent.map((p) => p[0])) : -1;
  const maxX = extent.length ? Math.max(...extent.map((p) => p[0])) : 1;
  const minY = extent.length ? Math.min(...extent.map((p) => p[1])) : -1;
  const maxY = extent.length ? Math.max(...extent.map((p) => p[1])) : 1;
  const width = 960, height = 720, margin = 56;
  const scale = Math.min((width - margin * 2) / Math.max(maxX - minX, 1), (height - margin * 2) / Math.max(maxY - minY, 1));
  const screen = ([x, y]) => [width / 2 + (x - (minX + maxX) / 2) * scale, height / 2 - (y - (minY + maxY) / 2) * scale];
  const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  const draw = projected.sort((a, b) => a.depth - b.depth).map(({ meshIndex, points, projected: coordinates }) => {
    const [a,b,c] = points;
    const u = b.map((v,i) => v-a[i]), v = c.map((value,i) => value-a[i]);
    const normal = unit([u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]);
    const light = unit([0.3, 0.8, 0.6]);
    const shade = Math.round(0.55 + 0.4 * Math.max(0, normal.reduce((sum, value, i) => sum + value*light[i], 0)));
    const color = shapes[meshIndex]?.color ?? "#6f8fa8";
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : "#6f8fa8";
    const channels = [1,3,5].map((index) => Math.min(255, Math.round(parseInt(hex.slice(index,index+2),16)*shade)).toString(16).padStart(2,"0"));
    const pointsText = coordinates.map((point) => screen(point).join(",")).join(" ");
    return `<polygon points="${pointsText}" fill="#${channels.join("")}" stroke="#34495a" stroke-width="0.65" stroke-linejoin="round"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f5f7f9"/><text x="28" y="36" font-family="sans-serif" font-size="16" fill="#40515e">${xml(project.projectName)} · ${face}</text>${draw}</svg>`;
  const sharp = (await import("sharp")).default;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { face, bytesApprox: png.byteLength, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
}

export async function callLocalEngineTool(name, args = {}) {
  if (["sketchforge_list_editors", "sketchforge_inspect_errors"].includes(name)) {
    throw new Error(`${name} needs an open SketchForge editor and is unavailable in local mode.`);
  }
  const id = requireProjectId(args);
  const { engine, package: enginePackage } = await getBackend();
  switch (name) {
    case "sketchforge_read_scene":
    case "sketchforge_list_objects":
      return readScene(args);
    case "sketchforge_create_shape":
      return unwrap(await engine.addShapes(id, [args]));
    case "sketchforge_select_objects": {
      const project = await unwrap(await engine.project(id));
      const requested = Array.isArray(args.ids) ? args.ids : args.id ? [args.id] : [];
      selectedObjectIds = requested.filter((shapeId) => project.shapes.some((shape) => shape.id === shapeId));
      return { selectedIds: selectedObjectIds, objects: project.shapes.filter((shape) => selectedObjectIds.includes(shape.id)).map(objectSummary) };
    }
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
      const ids = args.ids ?? (args.id ? [args.id] : selectedObjectIds);
      const removed = [];
      for (const shapeId of ids) removed.push(await unwrap(await engine.removeShape(id, shapeId)));
      return { removed };
    }
    case "sketchforge_align_objects":
      return unwrap(await engine.align(id, { ...args, ids: args.ids?.length ? args.ids : selectedObjectIds }));
    case "sketchforge_distribute_objects":
      return unwrap(await engine.distribute(id, { ...args, ids: args.ids?.length ? args.ids : selectedObjectIds }));
    case "sketchforge_pattern_objects":
      return unwrap(await engine.pattern(id, { ...args, ids: args.ids?.length ? args.ids : selectedObjectIds, kind: args.kind ?? "linear", count: args.count ?? 4 }));
    case "sketchforge_group_objects":
      return unwrap(await engine.group(id, args.ids?.length ? args.ids : selectedObjectIds));
    case "sketchforge_ungroup_objects": {
      const results = [];
      for (const shapeId of args.ids ?? (args.id ? [args.id] : selectedObjectIds)) results.push(await unwrap(await engine.ungroup(id, shapeId)));
      return { results };
    }
    case "sketchforge_boolean_cut": {
      if (args.solidIds && args.holeIds) return unwrap(await engine.cut(id, { solidIds: args.solidIds, holeIds: args.holeIds }));
      const project = await unwrap(await engine.project(id));
      const selected = project.shapes.filter((shape) => selectedObjectIds.includes(shape.id));
      return unwrap(await engine.cut(id, {
        solidIds: selected.filter((shape) => !shape.hole).map((shape) => shape.id),
        holeIds: selected.filter((shape) => shape.hole).map((shape) => shape.id),
      }));
    }
    case "sketchforge_separate_parts":
      return unwrap(await engine.separate(id, args.id ?? selectedObjectIds[0]));
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
    case "sketchforge_validate_scene":
      return validateScene(args);
    case "sketchforge_capture_image":
      return captureScene(args);
    case "sketchforge_mirror_objects": {
      const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : selectedObjectIds;
      if (!ids.length || !["x", "y", "z"].includes(args.axis)) throw new Error("mirror_objects requires object ids or a local selection, and axis x, y, or z.");
      const project = await unwrap(await engine.project(id));
      const selected = project.shapes.filter((shape) => ids.includes(shape.id));
      if (!selected.length) throw new Error("No matching objects to mirror.");
      const { nextShapes, moved: count } = enginePackage.mirrorShapes(project.shapes, ids, args.axis);
      const moved = [];
      for (const shape of selected) {
        if (shape.locked) continue;
        const reflected = nextShapes.find((item) => item.id === shape.id);
        const changes = Object.fromEntries(["x", "z", "elevation", "rotation", "rotationX", "rotationZ", "mirrorX", "mirrorY", "mirrorZ"].filter((key) => reflected[key] !== shape[key]).map((key) => [key, reflected[key]]));
        moved.push(unwrap(await engine.changeShape(id, shape.id, changes)));
      }
      return { moved: count, axis: args.axis, objects: moved };
    }
    default:
      throw new Error(`${name} needs an open SketchForge editor and is unavailable in local mode.`);
  }
}
