/**
 * Hollowing a solid on the server, with a wall of a given thickness.
 *
 * This is the operation a 3D print needs most: a solid box weighs 8 grams of
 * filament and a 2 mm-walled one weighs two, and a box with its top face left
 * open is a tray. The hollowing itself is `cadShell.ts`, which the editor's
 * CAD worker shares; this module is the Node side of it.
 *
 * Node-only, and built on the same footing as the fillet endpoint: the shape is
 * rebuilt as true geometry rather than meshed, and the result is stored with
 * its exact BREP alongside the triangles, so a hollowed part still exports to
 * STEP and can still be filleted afterwards.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { withCadKernel } from "./serverCadKernel.js";
import { exactPlainSketchRevolveSolid, isPlainFullTurnSketchRevolve, meshedCadResult, orientedSolidForShape, ServerCadError, type ServerCadResult } from "./serverCadOperations.js";
import { CadShellError, describeShellFaces, shellSolid, type CadShellFace } from "./cadShell.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export { FACE_DIRECTION_NAMES, faceOutwardNormal, type FaceDirection } from "./cadShell.js";

export type ServerCadFace = CadShellFace & {
  /** App-owned identity, stable across listings and persisted when referenced. */
  id: string;
};

export type ServerCadShellRequest = {
  /** Wall thickness in mm, measured inwards from the surface. */
  thickness: number;
  /** Faces to leave open, as direction names or indexes from the face listing. */
  openFaces?: ReadonlyArray<number | string>;
};

function faceSummaries(cad: OcctKernel, solid: ShapeHandle, shape: WorkplaneShape, preferStoredIds = true): ServerCadFace[] {
  const described = describeShellFaces(cad, solid);
  const storedIds = preferStoredIds && shape.faceIds?.length === described.length ? shape.faceIds : undefined;
  return described.map((face) => ({
    index: face.index,
    id: storedIds?.[face.index] ?? `face_${encodeURIComponent(shape.id)}_${face.index}`,
    surfaceType: face.surfaceType,
    area: face.area,
    centroid: face.centroid,
    normal: face.normal,
    facing: face.facing,
  }));
}

/** A shape's faces, numbered as a shell request refers to them by index. */
export function shapeFaces(shape: WorkplaneShape, options: { topology?: "exact" } = {}): Promise<ServerCadFace[]> {
  return withCadKernel((cad) => {
    if (options.topology === "exact" && isPlainFullTurnSketchRevolve(shape)) {
      if (shape.faceColors && Object.keys(shape.faceColors).length > 0) {
        throw new ServerCadError("Exact revolve face listing is unavailable while legacy face colors are stored.");
      }
      const exact = exactPlainSketchRevolveSolid(cad, shape.sketchProfile!, shape.sketchRevolve, shape);
      return faceSummaries(cad, exact, shape, false);
    }
    return faceSummaries(cad, orientedSolidForShape(cad, shape), shape);
  });
}

/** What a result OCCT built but cannot write out means, which is nothing good. */
const UNREADABLE =
  "The hollowed solid came out of OCCT in a state it cannot read back, so it has not been stored. Try a different wall thickness.";

/**
 * Hollow a shape out and return the exact result with a mesh of it.
 *
 * Both halves are kept, as for a fillet: the BREP is what STEP export and any
 * later treatment work from, and the mesh is what the viewport draws.
 */
export function applyShell(shape: WorkplaneShape, request: ServerCadShellRequest): Promise<ServerCadResult> {
  if (!Number.isFinite(request.thickness) || request.thickness <= 0) {
    return Promise.reject(new ServerCadError("The wall thickness must be greater than zero.", 400));
  }

  return withCadKernel((cad) => {
    const solid = orientedSolidForShape(cad, shape);
    let hollow: ShapeHandle;
    try {
      hollow = shellSolid(cad, solid, request).solid;
    } catch (error) {
      // The same refusal, said the way the REST API says it.
      if (error instanceof CadShellError) throw new ServerCadError(error.message, error.status);
      throw error;
    }
    try {
      return meshedCadResult(cad, hollow, shape);
    } catch {
      // A hollowed loft reaches this: the solid passes every check OCCT can
      // answer and then `toBREP` reads past the end of its own memory. There
      // is nothing to store, so this has to be a refusal rather than a 500.
      throw new ServerCadError(UNREADABLE);
    }
  });
}
