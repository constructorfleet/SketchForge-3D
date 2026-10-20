/**
 * STEP import on the OCCT kernel directly, rather than through brepjs.
 *
 * `stepImport.ts` reads a STEP file with brepjs: `importSTEP`, `rotate`, then
 * `mesh`. That works for the files anyone had tried, and fails on a real
 * assembly. Measured on a 74 MB FreeCAD AP214 export of a Raspberry Pi 5 board
 * (45,689 faces, 2,689 solids):
 *
 * | step                               | brepjs                        | this kernel path |
 * | ---------------------------------- | ----------------------------- | ---------------- |
 * | read the file                      | ok, 20.5s                     | ok, 20.5s        |
 * | rotate Z-up to Y-up                | ok, 1.6s                      | ok               |
 * | tessellate                         | **memory access out of bounds** | ok, 5.0s, 674,520 triangles |
 *
 * It is not a memory ceiling: the module grows to 4 GB, the failure is the same
 * under Node as in a browser, and coarsening `linearDeflection` from 0.1 to 1.0
 * does not move it -- a heap that was merely full would have. The kernel's own
 * `tessellate` meshes the identical shape, whole or per solid. So the mesher
 * above the kernel is the thing that cannot do it, and this module skips it.
 *
 * Node-only, because it uses the server kernel. The browser keeps the brepjs
 * path, which is all a static export has.
 */
import { LocalizedError } from "./support/i18n/LocalizedError.js";
import { withCadKernel } from "./serverCadKernel.js";
import { importedShapeFromTriangleSoup } from "./stlImport.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

/** Tessellation fine enough for a board, coarse enough for an assembly. */
const IMPORT_TESSELLATION = { linearDeflection: 0.1, angularDeflection: 0.5 } as const;

/**
 * Above this, the exact geometry is left out and only the mesh is kept.
 *
 * Re-exporting the model to STEP text is what fills `importedMesh.brepStep`,
 * and the text is far larger than the file it came from: the 74 MB Raspberry Pi
 * assembly comes back as **202.7 MB**. That string would be stored in the
 * project, which autosave writes on every edit -- a measured 48 ms for a small
 * project, and that is before adding 200 MB of text to it. An assembly this
 * size is imported as a mesh, and keeping the exact geometry for one is a
 * separate piece of work: the right answer is to store the *source* text with
 * the frame it was placed into, rather than a fresh export, and that changes
 * what the consumers of `brepStep` have to understand.
 */
const EXACT_GEOMETRY_LIMITS = { solids: 200, sourceBytes: 8 * 1024 * 1024 } as const;

const X_AXIS = { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } as const;

export type StepImportSummary = {
  shape: WorkplaneShape;
  /** How many separate solids the file held, which is what makes it an assembly. */
  solids: number;
  triangles: number;
  /**
   * Whether the exact B-rep was kept alongside the mesh. False for an assembly
   * past `EXACT_GEOMETRY_LIMITS`, so a caller can say why a later fillet or
   * STEP export of this shape works from triangles.
   */
  exactGeometry: boolean;
};

export async function importedShapeFromStepOnKernel(fileName: string, stepText: string): Promise<StepImportSummary> {
  if (!stepText.trim()) throw new LocalizedError("errors.step.readFailed", { detail: "the file was empty" });

  return withCadKernel(async (cad) => {
    let imported;
    try {
      imported = cad.importStep(stepText);
    } catch (error) {
      throw new LocalizedError("errors.step.readFailed", { detail: messageOf(error) });
    }

    const solids = cad.getSubShapes(imported, "solid");

    // Tessellated *before* any kernel transform, and deliberately. `rotate`
    // copies the whole B-rep, so rotating first means two 74 MB models in the
    // kernel at once -- and that is what exhausts it: the same file tessellates
    // in 5s when nothing has been copied, and dies with "memory access out of
    // bounds" when the rotation went first. Both the old brepjs path and my own
    // first attempt rotated first, and both failed here.
    let mesh;
    try {
      mesh = cad.tessellate(imported, IMPORT_TESSELLATION);
    } catch (error) {
      throw new LocalizedError("errors.step.meshFailed", { detail: messageOf(error) });
    }
    if (mesh.triangleCount < 1) throw new LocalizedError("errors.step.noSolidGeometry");

    // The kernel hands back indexed triangles; the shape builder takes a soup.
    // STEP/CAD space is Z-up and SketchForge is Y-up, so the triangles are
    // turned here rather than the solid: (x, y, z) -> (x, z, -y) is exactly the
    // -90 degrees about X that the solid would have been given, and it costs a
    // multiply-free swap per vertex instead of a copy of the model.
    const positions: number[] = [];
    const normals: number[] = [];
    const hasNormals = mesh.normals.length === mesh.positions.length;
    for (let index = 0; index < mesh.indices.length; index += 1) {
      const vertex = mesh.indices[index] * 3;
      positions.push(mesh.positions[vertex], mesh.positions[vertex + 2], -mesh.positions[vertex + 1]);
      if (hasNormals) normals.push(mesh.normals[vertex], mesh.normals[vertex + 2], -mesh.normals[vertex + 1]);
    }

    const shape = importedShapeFromTriangleSoup(fileName, positions, hasNormals ? normals : undefined, "step");

    // `importedShapeFromTriangleSoup` recentres the mesh on x/z and rests it on
    // y = 0, so the stored exact geometry has to move by the same offset or the
    // two frames disagree -- the mismatch #53 found and fixed for treatments.
    const bounds = meshBounds(positions);
    const worthKeepingExact = solids.length <= EXACT_GEOMETRY_LIMITS.solids
      && stepText.length <= EXACT_GEOMETRY_LIMITS.sourceBytes;
    if (shape.importedMesh && bounds && worthKeepingExact) {
      try {
        // Only now is the solid turned and moved, to match the frame the mesh
        // was recentred into. This is the step that can exhaust the kernel on a
        // large assembly, so it comes last and its failure costs only the exact
        // geometry: a project that cannot be imported at all is worse than one
        // whose imported mesh has no B-rep behind it.
        const turned = cad.rotate(imported, X_AXIS, -Math.PI / 2);
        const centred = cad.translate(
          turned,
          -(bounds.minX + bounds.maxX) / 2,
          -bounds.minY,
          -(bounds.minZ + bounds.maxZ) / 2,
        );
        shape.importedMesh.brepStep = cad.exportStep(centred);
      } catch {
        // Left without exact geometry on purpose. The mesh is still correct.
      }
    }

    return {
      shape,
      solids: solids.length,
      triangles: mesh.triangleCount,
      exactGeometry: Boolean(shape.importedMesh?.brepStep),
    };
  });
}

function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const described = String(error);
  return described === "[object WebAssembly.Exception]" ? "the CAD kernel refused the file" : described;
}

function meshBounds(positions: number[]) {
  if (positions.length < 9) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    maxX = Math.max(maxX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    minZ = Math.min(minZ, positions[index + 2]);
    maxZ = Math.max(maxZ, positions[index + 2]);
  }
  return { minX, minY, minZ, maxX, maxZ };
}
