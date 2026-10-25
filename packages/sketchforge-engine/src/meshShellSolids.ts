/**
 * A solid from a mesh made of several closed shells (#501, #527).
 *
 * OCCT sews one shell into one solid. A watertight mesh with a sealed internal
 * void -- a float, a pressure vessel, a group that sealed a hole inside a solid
 * -- or with several separate bodies has more than one shell, and sewing all of
 * its triangles at once gets a shell inside a shell that no one solid can be
 * made of. So each shell is sewn on its own and the solids are put back
 * together by nesting.
 *
 * Shared by the server's exact paths and the editor's CAD modifier worker, so
 * the two agree on which meshes are solids. Each brings its own sewing, since
 * the worker heals what it sews and the server does not, and each words the
 * refusal for its own audience from the `reason` here.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { meshSolidShells, type MeshSolidShell } from "./meshMassProperties.js";
import { MeshShellsOverlapError } from "./meshShellOverlap.js";
import type { MeshData } from "./meshTransform.js";

/**
 * Why several shells made no solid: the kernel's assembly was not a valid
 * solid, or the shells overlap without nesting so no reading of them is right.
 */
export type MeshShellSolidFailure = "not-solid" | "shells-overlap";

export class MeshShellSolidError extends Error {
  readonly reason: MeshShellSolidFailure;
  constructor(reason: MeshShellSolidFailure) {
    super(reason === "shells-overlap"
      ? "The mesh has closed bodies that overlap without one enclosing the other."
      : "The mesh's closed shells did not assemble into a valid solid.");
    this.name = "MeshShellSolidError";
    this.reason = reason;
  }
}

/**
 * How far, as a fraction of all the shells' volume together, the assembled
 * solid may stray from the mesh's own. Sewing a tessellated curve may move it
 * by up to the loosest sewing tolerance; an overlap misread as a void moves it
 * by the overlap itself or more.
 */
export const SHELL_VOLUME_TOLERANCE = 1e-3;

/** A mesh of indexed triangles, as the editor holds one, in the form the shell analysis reads. */
export function meshDataFromIndexed(positions: ArrayLike<number>, indices: ArrayLike<number>): MeshData {
  const vertices: [number, number, number][] = [];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    vertices.push([positions[index], positions[index + 1], positions[index + 2]]);
  }
  const faces: [number, number, number][] = [];
  for (let index = 0; index + 2 < indices.length; index += 3) {
    faces.push([indices[index], indices[index + 1], indices[index + 2]]);
  }
  return { name: "mesh", vertices, faces };
}

/**
 * The solid a mesh of several closed shells bounds, or `null` when it is one
 * shell (or not closed at all) and the caller should sew it whole as before.
 *
 * `sewShell` turns one shell's flat triangle corners into a solid, throwing
 * whatever its caller throws for a shell that will not close.
 */
export function nestedMeshShellSolid(
  cad: OcctKernel,
  mesh: MeshData,
  sewShell: (positions: number[]) => ShapeHandle,
): ShapeHandle | null {
  let shells: MeshSolidShell[] | null;
  try {
    shells = meshSolidShells(mesh);
  } catch (error) {
    // Bodies that overlap without nesting are found from the triangles (#529), before any sewing.
    if (error instanceof MeshShellsOverlapError) throw new MeshShellSolidError("shells-overlap");
    throw error;
  }
  if (!shells || shells.length <= 1) return null;
  return solidFromMeshShells(cad, shells, sewShell);
}

function isValidShape(cad: OcctKernel, shape: ShapeHandle) {
  try {
    return Boolean(cad.isValid(shape));
  } catch {
    return false;
  }
}

/**
 * Depth by depth from the outside in: the outermost bodies fused, each layer of
 * voids cut out of what encloses it, each body floating in a void fused back.
 * A shell at depth d lies inside one at depth d - 1, so every step only ever
 * works inside the region the step before it settled.
 *
 * Depth assumes the shells nest. Separate bodies that overlap without one
 * enclosing the other -- common in an imported STL nobody unioned -- break
 * that: a body poking into another reads as its void, and the assembly is
 * quietly the wrong solid. `meshSolidShells` refuses those from the triangles
 * before anything is sewn (#529); the mesh's own signed volume stays as the
 * last check: a correctly read nesting assembles to exactly it, so a solid that
 * does not is refused rather than returned.
 */
function solidFromMeshShells(cad: OcctKernel, shells: MeshSolidShell[], sewShell: (positions: number[]) => ShapeHandle) {
  const byDepth = new Map<number, ShapeHandle[]>();
  for (const shell of shells) {
    const solid = sewShell(shell.positions);
    byDepth.set(shell.depth, [...(byDepth.get(shell.depth) ?? []), solid]);
  }
  const deepest = Math.max(...byDepth.keys());
  const union = (solids: ShapeHandle[]) => (solids.length === 1 ? solids[0] : cad.fuseAll(solids));
  let result = union(byDepth.get(0) ?? []);
  for (let depth = 1; depth <= deepest; depth += 1) {
    const layer = byDepth.get(depth);
    if (!layer?.length) continue;
    result = depth % 2 === 1 ? cad.cut(result, union(layer)) : cad.fuse(result, union(layer));
  }
  const solids = cad.getSubShapes(result, "solid");
  if (solids.length === 0 || !isValidShape(cad, result)) throw new MeshShellSolidError("not-solid");
  const meshVolume = shells.reduce((sum, shell) => sum + shell.volume, 0);
  const scale = shells.reduce((sum, shell) => sum + Math.abs(shell.volume), 0);
  if (!(meshVolume > 0) || Math.abs(cad.getVolume(result) - meshVolume) > SHELL_VOLUME_TOLERANCE * scale) {
    throw new MeshShellSolidError("shells-overlap");
  }
  return solids.length === 1 ? solids[0] : result;
}
