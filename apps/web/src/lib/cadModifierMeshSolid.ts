import type { OcctKernel } from "occt-wasm";
import { LocalizedError } from "@/i18n/LocalizedError";
import type { CadModifierMeshPart } from "./cadModifierTypes";
import { cadShapeIsValid } from "./cadModifierBoolean";
import { MeshShellSolidError, meshDataFromIndexed, nestedMeshShellSolid } from "./engine/meshShellSolids";

/** An ASCII STL of indexed triangles, which is the form OCCT imports a mesh in. */
function asciiStl(positions: ArrayLike<number>, indices: ArrayLike<number>) {
  const lines = new Array<string>(indices.length / 3 + 2);
  lines[0] = "solid sketchforge";
  for (let offset = 0, face = 1; offset + 2 < indices.length; offset += 3, face += 1) {
    const ai = indices[offset] * 3;
    const bi = indices[offset + 1] * 3;
    const ci = indices[offset + 2] * 3;
    const ax = positions[ai];
    const ay = positions[ai + 1];
    const az = positions[ai + 2];
    const bx = positions[bi];
    const by = positions[bi + 1];
    const bz = positions[bi + 2];
    const cx = positions[ci];
    const cy = positions[ci + 1];
    const cz = positions[ci + 2];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    lines[face] = `facet normal ${nx} ${ny} ${nz}\n outer loop\n  vertex ${ax} ${ay} ${az}\n  vertex ${bx} ${by} ${bz}\n  vertex ${cx} ${cy} ${cz}\n endloop\nendfacet`;
  }
  lines[lines.length - 1] = "endsolid sketchforge";
  return lines.join("\n");
}

/** One closed shell's triangles sewn and healed into a solid, loosening the tolerance until it closes. */
function sewnMeshSolid(cad: OcctKernel, positions: ArrayLike<number>, indices: ArrayLike<number>) {
  const imported = cad.importStl(asciiStl(positions, indices));
  let shape = cad.fixShape(imported);
  if (cad.isSolid(shape)) {
    try {
      shape = cad.healSolid(shape, 1e-4);
      shape = cad.fixFaceOrientations(shape);
      shape = cad.removeDegenerateEdges(shape);
      shape = cad.unifySameDomain(shape);
    } catch {
      // Fall through to face sewing when the imported solid cannot be healed directly.
    }
    if (cad.isSolid(shape) && cadShapeIsValid(cad, shape)) return shape;
  }

  const faces = cad.getSubShapes(imported, "face");
  if (faces.length === 0) throw new LocalizedError("errors.cadModifier.noClosedFaces");
  for (const tolerance of [1e-5, 1e-4, 1e-3, 1e-2]) {
    try {
      let candidate = cad.sewAndSolidify(faces, tolerance);
      candidate = cad.fixShape(candidate);
      if (cad.isSolid(candidate)) candidate = cad.healSolid(candidate, tolerance);
      candidate = cad.fixFaceOrientations(candidate);
      candidate = cad.removeDegenerateEdges(candidate);
      candidate = cad.unifySameDomain(candidate);
      if (cad.isSolid(candidate) && cadShapeIsValid(cad, candidate)) return candidate;
    } catch {
      // Try the next tolerance. Curved tessellations can need looser vertex sewing.
    }
  }
  throw new LocalizedError("errors.cadModifier.meshNotManifold");
}

/** Sequential indices for a shell's flat triangle corners. */
function cornerIndices(positions: number[]) {
  return Uint32Array.from({ length: positions.length / 3 }, (_, index) => index);
}

/**
 * The solid a stored mesh part's triangles bound, for the CAD modifier worker.
 *
 * A mesh of several closed shells -- a group that sealed a hole inside a
 * solid, an imported hollow STL -- is sewn one shell at a time and put back
 * together by nesting, exactly as the server does (#501, #527). Sewn all at
 * once, OCCT found a shell inside a shell and the editor refused the part as
 * not manifold. Shells that overlap without nesting are refused: no reading of
 * them gives the mesh's own volume.
 */
export function meshPartSolid(cad: OcctKernel, part: CadModifierMeshPart) {
  const { positions, indices } = part;
  if (!positions || !indices) throw new LocalizedError("errors.cadModifier.noMeshData");
  try {
    const nested = nestedMeshShellSolid(cad, meshDataFromIndexed(positions, indices), (shell) => sewnMeshSolid(cad, shell, cornerIndices(shell)));
    if (nested !== null) return nested;
  } catch (error) {
    if (!(error instanceof MeshShellSolidError)) throw error;
    throw new LocalizedError(error.reason === "shells-overlap" ? "errors.cadModifier.meshShellsOverlap" : "errors.cadModifier.meshNotManifold");
  }
  return sewnMeshSolid(cad, positions, indices);
}
