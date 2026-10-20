/**
 * The cut itself, run on the exact kernel (upstream issues #118 and #111).
 *
 * The editor's booleans have always been mesh booleans: a shape is tessellated,
 * handed to `three-bvh-csg` or to Manifold, and the triangles that come back
 * are the result. That is why a negative cylinder leaves a broken mesh (#118)
 * and why a tapered cutter's hole loses its slope (#111) -- a tessellation has
 * no cylinder and no sloped plane in it, only facets, and a mesh CSG resolves
 * two coplanar facets however it happens to.
 *
 * The browser already carries OCCT for fillets and chamfers, so the cut can be
 * done on true surfaces instead. This module is the kernel half of that: it
 * takes solids and holes as kernel handles and returns the exact result, plus
 * the mesh and the BREP a shape stores afterwards.
 *
 * Kernel-agnostic on purpose. It is called from the CAD modifier worker in the
 * browser and from Node in the tests, which is what lets the geometry be
 * checked against closed-form volumes rather than against a screenshot.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type { CadModifierExactPart, CadModifierMeshPart } from "@/lib/cadModifierTypes";
import { exactSolidForShape } from "@/lib/engine/cadSolids";

/** Linear deflection for the mesh drawn from an exact cut. Matches the server's. */
export const EXACT_BOOLEAN_MESH_DEFLECTION = 0.1;

const IDENTITY_CAD_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function isPlacementTransform(transform: number[] | undefined): transform is number[] {
  return Boolean(transform?.length === 12 && transform.every(Number.isFinite));
}

function isIdentityPlacement(transform: number[]) {
  return transform.every((value, index) => Math.abs(value - IDENTITY_CAD_TRANSFORM[index]) < 1e-9);
}

/**
 * One operand built exactly, where it stands in the project.
 *
 * `exactSolidForShape` builds the shape in its own frame -- centred in X and Z,
 * base on y = 0 -- with its rotation already baked in, so the placement left to
 * apply is the move onto the workplane.
 */
export function exactPartSolid(cad: OcctKernel, part: CadModifierExactPart): ShapeHandle {
  const solid = exactSolidForShape(cad, part.shape);
  if (!isPlacementTransform(part.transform) || isIdentityPlacement(part.transform)) {
    return solid;
  }
  return cad.transform(solid, part.transform);
}

function singleSolid(cad: OcctKernel, shape: ShapeHandle) {
  if (cad.isSolid(shape)) return shape;
  const solids = cad.getSubShapes(shape, "solid");
  return solids.length === 1 ? solids[0] : shape;
}

/** Why an exact cut could not be run, for the caller to fall back on the mesh path. */
export class ExactBooleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactBooleanError";
  }
}

/**
 * Every solid fused, with every hole taken out of the result.
 *
 * Fusing before cutting is what makes a multi-solid cut mean what it reads as:
 * a hole spanning two touching plates goes through both, rather than through
 * whichever one happened to be cut first.
 *
 * `solidFor` builds one operand. The worker passes its own reconstruction,
 * which also knows how to rebuild a stored BREP or sew an imported mesh; a test
 * passes `exactPartSolid` directly.
 */
export type ExactCut = {
  cut: ShapeHandle;
  /** Volume of the fused solids before the holes were taken out. */
  fusedVolume: number;
  /** Volume left afterwards. Equal to `fusedVolume` when no hole met the solid. */
  cutVolume: number;
};

export function exactCutFromParts(
  cad: OcctKernel,
  parts: CadModifierMeshPart[],
  solidFor: (part: CadModifierMeshPart) => ShapeHandle,
): ExactCut {
  const solids = parts.filter((part) => !part.hole).map(solidFor);
  const holes = parts.filter((part) => part.hole).map(solidFor);
  if (solids.length === 0) throw new ExactBooleanError("An exact cut needs at least one solid.");
  if (holes.length === 0) throw new ExactBooleanError("An exact cut needs at least one hole.");

  const fused = singleSolid(cad, solids.length === 1 ? solids[0] : cad.fuseAll(solids));
  const fusedVolume = cad.getVolume(fused);
  const cut = singleSolid(cad, cad.cutAll(fused, holes));
  if (cad.getSubShapes(cut, "face").length === 0) {
    throw new ExactBooleanError("Those holes remove the whole solid.");
  }
  // The volumes travel with the result because the caller has to know whether
  // the cut did anything: a hole that misses its solid leaves the solid whole,
  // and the editor treats that as a failed cut rather than silently grouping.
  return { cut, fusedVolume, cutVolume: cad.getVolume(cut) };
}

export type ExactCutMesh = {
  /** World-space triangle corners, three per triangle, the way a mesh shape stores them. */
  positions: Float32Array;
  normals: Float32Array;
  triangleCount: number;
  /** The exact result, recentred into the frame the result shape will sit in. */
  brep: string;
};

/**
 * The mesh to draw and the BREP to keep.
 *
 * Both are kept for the same reason the edge modifier keeps both: the viewport
 * draws triangles, but a later fillet or a STEP export of the cut part has to
 * read true surfaces, or the cylinder this cut just made correctly comes back
 * as ninety-six planes.
 *
 * The BREP is stored in the result's own frame -- centred in X and Z, base on
 * y = 0 -- because that is the frame a mesh shape's positions are stored in,
 * and `cadBrepFrame` is what puts the two back together.
 */
export function meshedExactCut(cad: OcctKernel, result: ShapeHandle): ExactCutMesh {
  const mesh = cad.meshShape(result, { linearDeflection: EXACT_BOOLEAN_MESH_DEFLECTION });
  const triangleCount = Math.floor(mesh.indices.length / 3);
  const positions = new Float32Array(mesh.indices.length * 3);
  const normals = new Float32Array(mesh.indices.length * 3);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < mesh.indices.length; corner += 1) {
    const source = mesh.indices[corner] * 3;
    const target = corner * 3;
    const x = mesh.positions[source];
    const y = mesh.positions[source + 1];
    const z = mesh.positions[source + 2];
    positions[target] = x;
    positions[target + 1] = y;
    positions[target + 2] = z;
    normals[target] = mesh.normals[source];
    normals[target + 1] = mesh.normals[source + 1];
    normals[target + 2] = mesh.normals[source + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  if (triangleCount === 0 || ![minX, minY, minZ, maxX, maxZ].every(Number.isFinite)) {
    throw new ExactBooleanError("The exact cut produced no usable geometry.");
  }

  const centred = cad.translate(result, -(minX + maxX) / 2, -minY, -(minZ + maxZ) / 2);
  return { positions, normals, triangleCount, brep: cad.toBREP(centred) };
}
