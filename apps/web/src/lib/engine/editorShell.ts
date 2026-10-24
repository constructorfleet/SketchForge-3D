import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { LocalizedError, type ErrorKey } from "@/i18n/LocalizedError";
import { CadShellError, shellSolid, type CadShellRefusal } from "@/lib/engine/cadShell";
import { meshShapeWithFaceGroups } from "@/lib/engine/cadFaceMesh";

export type EditorShellRequest = {
  thickness: number;
  openFaces: ReadonlyArray<number | string>;
};

export type EditorShellResult = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  /** Triangle start, triangle count and B-rep face index triples, for face colours. */
  faceGroups: number[];
  faceCount: number;
  /** Measured on the exact solids, so the caller can say how much material went. */
  volume: number;
  sourceVolume: number;
  brep: string;
};

/** Each refusal the shared shell code can give, as the editor says it. */
const REFUSAL_KEYS: Record<CadShellRefusal, ErrorKey> = {
  thickness: "errors.cadModifier.shell.thicknessInvalid",
  "no-volume": "errors.cadModifier.shell.noVolume",
  "no-faces": "errors.cadModifier.shell.noVolume",
  "face-index": "errors.cadModifier.shell.faceIndexInvalid",
  direction: "errors.cadModifier.shell.noFlatFace",
  "no-flat-face": "errors.cadModifier.shell.noFlatFace",
  "every-face-open": "errors.cadModifier.shell.everyFaceOpen",
  "too-thick": "errors.cadModifier.shell.tooThick",
  "cannot-offset": "errors.cadModifier.shell.cannotOffset",
};

/**
 * Hollow `solid` in the editor's CAD worker, with the code the REST endpoint
 * uses, and mesh the result for the viewport.
 *
 * The solid stands where the shape stands, so the directions are the
 * workplane's: a shape's rotation is already in its geometry, as on the REST
 * path. Every refusal comes back as a `LocalizedError`, so the notice is in
 * the person's language rather than the API's English.
 */
export function buildEditorShell(cad: OcctKernel, solid: ShapeHandle, request: EditorShellRequest): EditorShellResult {
  let hollow: ReturnType<typeof shellSolid>;
  try {
    hollow = shellSolid(cad, solid, request);
  } catch (error) {
    if (error instanceof CadShellError) throw new LocalizedError(REFUSAL_KEYS[error.reason]);
    throw error;
  }
  let brep: string;
  try {
    brep = cad.toBREP(hollow.solid);
  } catch {
    // As on the REST path: a hollowed loft can pass every check and then fail
    // to write out, and there is nothing to keep.
    throw new LocalizedError("errors.cadModifier.shell.unreadable");
  }
  const mesh = meshShapeWithFaceGroups(cad, hollow.solid, { linearDeflection: 0.035, angularDeflection: 0.16 });
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleCount: mesh.triangleCount,
    faceGroups: mesh.faceGroups,
    faceCount: cad.getSubShapes(hollow.solid, "face").length,
    volume: hollow.volume,
    sourceVolume: hollow.sourceVolume,
    brep,
  };
}
