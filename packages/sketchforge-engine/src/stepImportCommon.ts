import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { createLocalId } from "./localIds.js";
import { LocalizedError } from "./support/i18n/LocalizedError.js";
import { importedShapeFromTriangleSoup } from "./stlImport.js";
import { stepComponentMetadata, stepShapeKey } from "./stepComponentMetadata.js";
import { MAX_EXPLODE_SOLIDS, MAX_EXPLODE_SOURCE_BYTES } from "./stepAssemblyExplode.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

const IMPORT_TESSELLATION = { linearDeflection: 0.1, angularDeflection: 0.5 } as const;

export type StepImportSummary = {
  shape: WorkplaneShape;
  solids: number;
  triangles: number;
  exactGeometry: boolean;
};

function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const described = String(error);
  return described === "[object WebAssembly.Exception]" ? "the CAD kernel refused the file" : described;
}

function meshBounds(positions: number[]) {
  if (positions.length < 9) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]!);
    maxX = Math.max(maxX, positions[index]!);
    minY = Math.min(minY, positions[index + 1]!);
    minZ = Math.min(minZ, positions[index + 2]!);
    maxZ = Math.max(maxZ, positions[index + 2]!);
  }
  return { minX, minY, minZ, maxX, maxZ };
}

function componentColorsByFace(cad: OcctKernel, metadataBySolid: Map<string, { color?: string }[]>, solids: ShapeHandle[], faces: ShapeHandle[]) {
  const colorsBySolid = new Map<string, string>();
  for (const [key, candidates] of metadataBySolid) {
    const colors = [...new Set(candidates.map(({ color }) => color).filter((color): color is string => Boolean(color)))];
    // Identical solids with conflicting labels cannot be associated by bounds
    // and volume alone, so leave those faces at the ordinary shape color.
    if (colors.length === 1 && candidates.every(({ color }) => color === colors[0])) colorsBySolid.set(key, colors[0]!);
  }

  const faceIndexByHash = new Map(faces.map((face, index) => [cad.hashCode(face, 2_147_483_647), index]));
  const colorsByFace = new Map<number, string>();
  for (const solid of solids) {
    const color = colorsBySolid.get(stepShapeKey(cad, solid));
    if (!color) continue;
    for (const face of cad.getSubShapes(solid, "face")) {
      const faceIndex = faceIndexByHash.get(cad.hashCode(face, 2_147_483_647));
      if (faceIndex !== undefined) colorsByFace.set(faceIndex, color);
    }
  }
  return colorsByFace;
}

/** Import STEP geometry and available XCAF component colors through one kernel seam. */
export async function importedShapeFromStepWithKernel(cad: OcctKernel, fileName: string, stepText: string): Promise<StepImportSummary> {
  if (!stepText.trim()) throw new LocalizedError("errors.step.readFailed", { detail: "the file was empty" });

  let imported: ShapeHandle;
  try {
    imported = cad.importStep(stepText);
  } catch (error) {
    throw new LocalizedError("errors.step.readFailed", { detail: messageOf(error) });
  }

  const solids = cad.getSubShapes(imported, "solid");
  let mesh;
  try {
    mesh = cad.meshShape(imported, IMPORT_TESSELLATION);
  } catch (error) {
    throw new LocalizedError("errors.step.meshFailed", { detail: messageOf(error) });
  }
  if (mesh.triangleCount < 1) throw new LocalizedError("errors.step.noSolidGeometry");

  const positions: number[] = [];
  const normals: number[] = [];
  const faceGroups: number[] = [];
  const faces = cad.getSubShapes(imported, "face");
  const faceIndexByHash = new Map(faces.map((face, index) => [cad.hashCode(face, 2_147_483_647), index]));
  for (let group = 0; group + 2 < (mesh.faceGroups?.length ?? 0); group += 3) {
    const start = mesh.faceGroups![group]!;
    const count = mesh.faceGroups![group + 1]!;
    const index = faceIndexByHash.get(mesh.faceGroups![group + 2]!);
    // `meshShape` reports triangle ranges in index units, while the stored
    // non-indexed mesh and viewport face groups count triangles.
    if (index !== undefined) faceGroups.push(start / 3, count / 3, index);
  }
  const hasNormals = mesh.normals.length === mesh.positions.length;
  for (let index = 0; index < mesh.indices.length; index += 1) {
    const vertex = mesh.indices[index]! * 3;
    positions.push(mesh.positions[vertex]!, mesh.positions[vertex + 2]!, -mesh.positions[vertex + 1]!);
    if (hasNormals) normals.push(mesh.normals[vertex]!, mesh.normals[vertex + 2]!, -mesh.normals[vertex + 1]!);
  }

  const shape = importedShapeFromTriangleSoup(fileName, positions, hasNormals ? normals : undefined, "step");
  if (shape.importedMesh && faceGroups.length) shape.importedMesh.faceGroups = faceGroups;
  const sourceBytes = new TextEncoder().encode(stepText).byteLength;
  const stepMetadataIsWithinBudget = solids.length <= MAX_EXPLODE_SOLIDS
    && sourceBytes <= MAX_EXPLODE_SOURCE_BYTES;
  const componentMetadata = stepMetadataIsWithinBudget ? stepComponentMetadata(cad, stepText) : undefined;
  const colorsByFace = componentMetadata
    ? componentColorsByFace(cad, componentMetadata.bySolid, solids, faces)
    : new Map<number, string>();
  if (componentMetadata?.assembly) shape.stepAssembly = componentMetadata.assembly;
  if (colorsByFace.size) {
    shape.faceIds = faces.map((_, index) => `face_${createLocalId(`${shape.id}-face-${index}`)}`);
    shape.faceColors = Object.fromEntries([...colorsByFace].map(([index, color]) => [shape.faceIds![index]!, color]));
  }

  const bounds = meshBounds(positions);
  const worthKeepingExact = solids.length <= MAX_EXPLODE_SOLIDS
    && sourceBytes <= MAX_EXPLODE_SOURCE_BYTES;
  if (shape.importedMesh && bounds && worthKeepingExact) {
    try {
      const turned = cad.rotate(imported, { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, -Math.PI / 2);
      const centred = cad.translate(turned, -(bounds.minX + bounds.maxX) / 2, -bounds.minY, -(bounds.minZ + bounds.maxZ) / 2);
      shape.importedMesh.brepStep = cad.exportStep(centred);
    } catch {
      // Exact geometry is optional; the correctly framed mesh remains importable.
    }
  }

  return { shape, solids: solids.length, triangles: mesh.triangleCount, exactGeometry: Boolean(shape.importedMesh?.brepStep) };
}
