import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { directoryProjectStore, createEngine } from "@sketchforge/engine";
import { macroFromModule, runMacro } from "../dist/index.js";

const root = process.env.SKETCHFORGE_PROJECTS_DIR;
if (!root) throw new Error("SKETCHFORGE_PROJECTS_DIR is required for local macro execution.");
const store = directoryProjectStore(path.resolve(root));
const engine = createEngine(store);
const unwrap = (result) => {
  if (result.ok) return result.value;
  throw new Error(`Engine operation failed: ${JSON.stringify(result.failure)}`);
};

async function projectSummary(record) {
  const project = unwrap(await engine.project(record.projectId));
  return {
    id: record.projectId,
    name: String(record.metadata.name ?? "Untitled design"),
    shapes: project.shapes.length,
    revision: project.revision,
    updatedAt: record.updatedAt,
    packageBytes: record.packageBytes,
  };
}

async function createProject(name) {
  const id = randomUUID();
  const now = Date.now();
  await writeFile(path.join(root, `${id}.json`), JSON.stringify({ name: String(name).slice(0, 80), createdAt: now, updatedAt: now, revision: 1 }));
  return { id, name: String(name).slice(0, 80), shapes: 0, revision: 1, updatedAt: now, packageBytes: 0 };
}

function projectHandle(id) {
  const read = async () => unwrap(await engine.project(id));
  const addMany = async (shapes) => unwrap(await engine.addShapes(id, shapes));
  const getEdges = async (shapeId) => unwrap(await engine.edges(id, shapeId));
  const withTriangleCount = (written) => ({ ...written, triangles: written.shape.importedMesh?.triangleCount ?? 0 });
  const treat = async (shapeId, treatment) => withTriangleCount(unwrap(await engine.treat(id, shapeId, treatment)));
  const shell = async (shapeId, request) => withTriangleCount(unwrap(await engine.shell(id, shapeId, request)));
  return {
    id,
    get: async () => {
      const project = await read();
      return { id, name: project.name, createdAt: project.createdAt, snapGrid: project.snapGrid, workspace: project.workspace, shapes: project.shapes };
    },
    listShapes: async () => (await read()).shapes,
    add: async (shape) => (await addMany([shape])).shapes[0],
    addMany,
    update: async (shapeId, changes) => unwrap(await engine.changeShape(id, shapeId, changes)),
    remove: (shapeId) => engine.removeShape(id, shapeId).then(unwrap),
    clear: async () => {
      const shapes = (await read()).shapes;
      for (const shape of shapes) await unwrap(await engine.removeShape(id, shape.id));
      return shapes.length;
    },
    edges: getEdges,
    filletableEdges: async (shapeId) => (await getEdges(shapeId)).filter((edge) => edge.filletable).map((edge) => edge.index),
    treat,
    fillet: (shapeId, radius, edges) => treat(shapeId, { kind: "fillet", amount: radius, ...(edges ? { edges } : {}) }),
    chamfer: (shapeId, distance, options = {}) => treat(shapeId, { kind: "chamfer", amount: distance, ...options }),
    faces: async (shapeId) => unwrap(await engine.faces(id, shapeId)),
    facesFacing: async (shapeId, direction) => (await unwrap(await engine.faces(id, shapeId))).filter((face) => face.direction === direction).map((face) => face.index),
    measurements: (shapeId) => engine.measurements(id, shapeId).then(unwrap),
    measureBetween: (from, to) => engine.measureBetween(id, from, to).then(unwrap),
    shell,
    hollow: (shapeId, thickness) => shell(shapeId, { thickness }),
    tray: (shapeId, thickness, openFaces) => shell(shapeId, { thickness, ...(openFaces ? { openFaces } : {}) }),
    align: (request) => engine.align(id, request).then(unwrap),
    alignTops: (ids, anchorId) => engine.align(id, { ids: [...ids], axis: "y", target: "max", ...(anchorId ? { anchorId } : {}) }).then(unwrap),
    distribute: (request) => engine.distribute(id, request).then(unwrap),
    pattern: (request) => engine.pattern(id, request).then(unwrap),
    row: (ids, count, stepX, stepZ = 0) => engine.pattern(id, { ids: [...ids], kind: "linear", count, stepX, stepZ }).then(unwrap),
    ring: (ids, count, center, options = {}) => engine.pattern(id, { ids: [...ids], kind: "circular", count, centerX: center.x, centerZ: center.z, ...options }).then(unwrap),
    importMesh: (request) => engine.importMesh(id, request).then(unwrap),
    cut: (request) => engine.cut(id, request).then(unwrap),
    group: (ids) => engine.group(id, [...ids]).then(unwrap),
    ungroup: (shapeId) => engine.ungroup(id, shapeId).then(unwrap),
    separate: (shapeId) => engine.separate(id, shapeId).then(unwrap),
  };
}

const client = {
  project: projectHandle,
  projects: {
    list: async () => Promise.all((await store.list()).map(projectSummary)),
    findByName: async (name) => (await Promise.all((await store.list()).map(projectSummary))).find((project) => project.name === name) ?? null,
    create: createProject,
    get: async (id) => projectHandle(id).get(),
    delete: async (id) => {
      const metadata = path.join(root, `${id}.json`);
      const file = path.join(root, `${id}.skf`);
      let deleted = false;
      for (const target of [metadata, file]) try { await unlink(target); deleted = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      return { deleted };
    },
  },
};
client.shapes = {
  list: async (id) => projectHandle(id).listShapes(),
  create: async (id, shape) => projectHandle(id).add(shape),
  createMany: async (id, shapes) => projectHandle(id).addMany(shapes),
  update: async (id, shapeId, changes) => projectHandle(id).update(shapeId, changes),
  delete: async (id, shapeId) => projectHandle(id).remove(shapeId),
  deleteAll: async (id) => projectHandle(id).clear(),
};

const argv = process.argv.slice(2);
const file = argv[0];
if (!file) throw new Error("Expected a macro file path.");
const options = { params: {}, targetProjectId: undefined };
for (const argument of argv.slice(1)) {
  if (argument === "--json") continue;
  if (argument.startsWith("--project=")) options.targetProjectId = argument.slice("--project=".length);
  else if (argument.startsWith("--")) {
    const [key, ...value] = argument.slice(2).split("=");
    options.params[key] = value.join("=");
  }
}
const module = await import(pathToFileURL(path.resolve(file)).href);
const definition = macroFromModule(module, path.basename(file).replace(/\.[cm]?[jt]s$/, ""));
const report = await runMacro(client, definition, options);
process.stdout.write(`${JSON.stringify(report)}\n`);
