import type { WorkplaneShape } from "./domain/sketchforge.js";
import { getFaces, getHashCode } from "brepjs";
import { LocalizedError } from "./support/i18n/LocalizedError.js";
import { importedShapeFromTriangleSoup } from "./stlImport.js";
import { loadBrepWithOcct } from "./support/lib/brepKernel.js";

const STEP_EXTENSIONS = new Set(["step", "stp"]);

export function isStepFile(fileName: string): boolean {
  return STEP_EXTENSIONS.has(fileName.split(".").pop()?.toLowerCase() ?? "");
}

export async function importedShapeFromStep(fileName: string, buffer: ArrayBuffer): Promise<WorkplaneShape> {
  const brep = await loadBrepWithOcct();

  const imported = await brep.importSTEP(new Blob([buffer]));
  if (!imported.ok) {
    throw new LocalizedError("errors.step.readFailed", { detail: String(imported.error.message ?? imported.error) });
  }

  // STEP/CAD space is Z-up; SketchForge is Y-up. Rotating −90° about X maps CAD
  // +Z (up) to SketchForge +Y — the inverse of the exporter's +90°·X. Rigid
  // kernel ops (rotate/translate) are used throughout normalization because they
  // preserve the exact geometry; a matrix transform here corrupts later export.
  const flipped = brep.rotate(imported.value, -90, { axis: [1, 0, 0] });
  // brepjs's mesher gives up on a real assembly where the kernel underneath it
  // does not: a 74 MB FreeCAD export of 45,689 faces reads and rotates here in
  // 22s and then dies with "memory access out of bounds", while the kernel's
  // own `tessellate` meshes the identical shape in 5s. It is not a heap
  // ceiling -- the module grows to 4 GB and coarsening the deflection does not
  // move it. So say what happened instead of surfacing a WebAssembly trap:
  // `stepImportKernel.ts` is the path that can do it, and it needs a server.
  let tess;
  try {
    tess = brep.mesh(flipped);
  } catch (error) {
    throw new LocalizedError("errors.step.meshFailed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (tess.vertices.length < 9) {
    throw new LocalizedError("errors.step.noSolidGeometry");
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const hasNormals = tess.normals.length === tess.vertices.length;
  const faceIndexByHash = new Map(getFaces(flipped).map((face, index) => [getHashCode(face), index]));
  const faceGroups: number[] = [];
  for (const group of tess.faceGroups) {
    const index = faceIndexByHash.get(group.faceId);
    if (index !== undefined) faceGroups.push(group.start, group.count, index);
  }
  for (let i = 0; i < tess.triangles.length; i += 1) {
    const v = tess.triangles[i] * 3;
    positions.push(tess.vertices[v], tess.vertices[v + 1], tess.vertices[v + 2]);
    if (hasNormals) {
      normals.push(tess.normals[v], tess.normals[v + 1], tess.normals[v + 2]);
    }
  }

  // importedShapeFromTriangleSoup recenters the mesh to x/z-centered, bottom at
  // y=0. Recenter the stored B-Rep by the same offset so the exact geometry and
  // the displayed mesh share one local frame, and the editor's transforms apply
  // identically to both.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const normalized = brep.translate(flipped, [-(minX + maxX) / 2, -minY, -(minZ + maxZ) / 2]);
  const exported = brep.exportSTEP(normalized);
  const stepText = exported.ok ? await exported.value.text() : undefined;

  const shape = importedShapeFromTriangleSoup(fileName, positions, hasNormals ? normals : undefined, "step");
  if (shape.importedMesh && faceGroups.length) shape.importedMesh.faceGroups = faceGroups;
  if (shape.importedMesh && stepText) {
    shape.importedMesh.brepStep = stepText;
  }
  return shape;
}
