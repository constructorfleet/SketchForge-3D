/**
 * What the editor sends the CAD worker for an exact cut (upstream #118, #111).
 *
 * The worker cannot be handed `WorkplaneShape`s and left to work out where they
 * sit, because a shape's placement is the editor's business and a worker has no
 * scene. So this turns a selection into the same `CadModifierMeshPart` list the
 * edge modifier already sends -- one entry per operand, marked `hole` or not --
 * with a third way of describing an operand alongside the existing two:
 *
 *   - `brep`, for a shape that already carries exact geometry from an earlier
 *     CAD operation. Placed by `cadBrepTransformForShape`, as the edge modifier
 *     places it.
 *   - `positions`/`indices`, for an imported mesh. There is nothing exact to
 *     build from; the worker sews the triangles and the *other* operand still
 *     gets a true surface.
 *   - `exact`, new here: the shape itself, for the worker to build from its
 *     parameters. This is what makes a cylinder a cylinder and keeps a taper a
 *     taper.
 *
 * A selection with one operand this cannot describe is declined whole, and the
 * editor falls back to its mesh booleans. Half a cut is worse than a mesh cut.
 */

import { cadBrepTransformForShape } from "./cadBakeMetadata.js";
import type { CadModifierExactPart, CadModifierMeshPart } from "./support/cadModifierTypes.js";
import { cutterShapeForBoolean } from "./cutterPadding.js";
import { EXACT_SOLID_KINDS } from "./cadSolids.js";
import { worldMeshForShape } from "./serverShapeGroups.js";
import { planTaper } from "./stepProfiles.js";
import { shapeDepth, shapeHasTaper, shapeWidth } from "./workplaneShapes.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

const MIN_EXACT_BOOLEAN_DIMENSION = 0.0001;
const EXACT_SOLID_KIND_SET: ReadonlySet<string> = new Set<string>(EXACT_SOLID_KINDS);

function shapeIsMirrored(shape: WorkplaneShape) {
  return Boolean(shape.mirrorX || shape.mirrorY || shape.mirrorZ);
}

/**
 * Whether the kernel can build this shape from its parameters.
 *
 * A mirror is excluded deliberately rather than for want of trying: the exact
 * builders bake a shape's rotation in as they build it, and a mirror has to be
 * applied *before* that rotation to mean what the editor draws. Mirrored
 * operands therefore stay on the mesh path, where `transformMesh` applies both
 * in the right order.
 */
export function shapeHasExactBooleanSolid(shape: WorkplaneShape) {
  if (shapeIsMirrored(shape)) return false;
  // A group that is only a record has already been expanded into its children
  // by the caller; one still carrying children here is a nested group whose
  // placement this does not reproduce.
  if (shape.groupedShapes?.length && !shape.importedMesh) return false;
  if (!EXACT_SOLID_KIND_SET.has(shape.kind)) return false;
  if (shapeHasTaper(shape) && planTaper(shape).kind === "skip") return false;
  return [shapeWidth(shape), shapeDepth(shape), shape.height].every(
    (value) => Number.isFinite(value) && value > MIN_EXACT_BOOLEAN_DIMENSION,
  );
}

/**
 * The move that puts an exactly built operand where it stands.
 *
 * OCCT takes an affine transform as three row-major rows of (basis, offset).
 * The rotation is already baked into the solid, so this is only the translation
 * onto the workplane -- which keeps it a rigid move, and `cad.transform` fast.
 */
export function exactBooleanPlacement(shape: WorkplaneShape): number[] {
  return [1, 0, 0, shape.x, 0, 1, 0, shape.elevation ?? 0, 0, 0, 1, shape.z];
}

function meshPartFromWorldMesh(shape: WorkplaneShape): CadModifierMeshPart | null {
  const mesh = worldMeshForShape(shape);
  if (!mesh || mesh.faces.length === 0) return null;
  const positions = new Float32Array(mesh.faces.length * 9);
  const indices = new Uint32Array(mesh.faces.length * 3);
  let corner = 0;
  for (const face of mesh.faces) {
    for (const vertexIndex of face) {
      const vertex = mesh.vertices[vertexIndex];
      if (!vertex) return null;
      positions[corner * 3] = vertex[0];
      positions[corner * 3 + 1] = vertex[1];
      positions[corner * 3 + 2] = vertex[2];
      indices[corner] = corner;
      corner += 1;
    }
  }
  return { positions, indices, hole: Boolean(shape.hole) };
}

function exactBooleanPart(shape: WorkplaneShape): CadModifierMeshPart | null {
  const hole = Boolean(shape.hole);
  if (shape.cadBrep && shape.cadBrepFrame) {
    return { brep: shape.cadBrep, brepTransform: cadBrepTransformForShape(shape), hole };
  }
  if (shape.importedMesh && shape.importedMesh.positions.length >= 9) {
    return meshPartFromWorldMesh(shape);
  }
  if (!shapeHasExactBooleanSolid(shape)) return null;
  const exact: CadModifierExactPart = { shape, transform: exactBooleanPlacement(shape) };
  return { exact, hole };
}

export type ExactCutRequest = {
  parts: CadModifierMeshPart[];
  solids: WorkplaneShape[];
  holes: WorkplaneShape[];
};

/**
 * The worker request for cutting this selection exactly, or null to decline.
 *
 * Holes go in unpadded. The mesh path grows every cutter by `CUTTER_PADDING`
 * because a mesh CSG resolves two coplanar facets unpredictably; OCCT does not
 * need that dodge, and applying it anyway would sink a flush pocket a twentieth
 * of a millimetre below the depth that was asked for.
 */
export function exactCutPartsForSelection(selection: WorkplaneShape[]): ExactCutRequest | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0) return null;

  const parts: CadModifierMeshPart[] = [];
  for (const shape of [...solids, ...holes]) {
    const part = exactBooleanPart(shape.hole ? cutterShapeForBoolean(shape, "exact") : shape);
    if (!part) return null;
    parts.push(part);
  }
  return { parts, solids, holes };
}

/** Buffers in an exact-cut request that can be handed to the worker rather than copied. */
export function exactCutRequestTransfer(parts: CadModifierMeshPart[]): Transferable[] {
  return parts.flatMap((part) => (part.positions && part.indices ? [part.positions.buffer, part.indices.buffer] : []));
}

export type ExactCutResultGeometry = {
  normals: Float32Array;
  brep: string;
};

/**
 * The exact result's geometry recorded on the shape the cut produced.
 *
 * `cadBrep` is what a later fillet, chamfer or STEP export of the cut part
 * reads, so the cylinder this cut made stays a cylinder instead of coming back
 * as the triangles that were drawn for it. `cadBrepFrame` says which frame the
 * BREP is in, so the two can be put back together after the shape is moved or
 * resized -- the same pair the edge modifier stores.
 */
export function withExactBooleanBrep(group: WorkplaneShape, result: ExactCutResultGeometry): WorkplaneShape {
  const stored = group.importedMesh;
  const width = group.width ?? group.size;
  const depth = group.depth ?? group.size;
  return {
    ...group,
    importedMesh: stored
      ? {
          ...stored,
          normals: result.normals.length === stored.positions.length ? Array.from(result.normals) : undefined,
        }
      : stored,
    cadBrep: result.brep,
    cadBrepFrame: { x: group.x, z: group.z, elevation: group.elevation ?? 0, width, depth, height: group.height },
    cadPrimitiveFrame: undefined,
    cadDisplayEdges: undefined,
    cadDisplayEdgesVersion: undefined,
  };
}
