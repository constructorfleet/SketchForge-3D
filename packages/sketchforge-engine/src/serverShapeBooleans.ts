/**
 * Boolean operations on stored shapes (upstream issue #55).
 *
 * This is how the app subtracts: a shape marked `hole: true` grouped with a
 * solid is a cut, and the group record keeps both operands so the cut stays
 * editable afterwards. The REST API could make a plate and a row of holes but
 * not take one out of the other, which left a parameterised bracket -- the
 * thing issue #55 asks for -- half-expressible.
 *
 * The editor does the cut on meshes in the browser, and pads every cutter by a
 * twentieth of a millimetre first, because a mesh CSG resolves two coplanar
 * faces unpredictably. OCCT does not need that dodge, so a hole cut here is the
 * size that was asked for rather than the size that happened to work.
 *
 * Node-only. Never import this from anything the browser bundles.
 */

import type { Matrix4 } from "three";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { withCadKernel } from "./serverCadKernel.js";
import { exactRevolveAngularDeflection, exactRevolveLocalSolid, hasExactRevolveSolid,localSolidForShape, meshedCadResult, solidFromMeshPositions, ServerCadError, cadResultIsValid } from "./serverCadOperations.js";
import { mirroredInShapeFrame, UnbuildableShapeError } from "./cadSolids.js";
import { createLocalId } from "./localIds.js";
import type { MeshData } from "./meshTransform.js";
import {
  boundsForPositions,
  expandGroupsForBoolean,
  groupedShapeFromSelection,
  meshShapeFromWorldPositions,
  restoreGroupedChildren,
  shapeAsGroupChild,
  shapePlacementMatrix,
  worldMeshForShape,
} from "./serverShapeGroups.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type GroupBuildOutcome =
  | {
    group: WorkplaneShape;
    /**
     * Set when no hole met the solid, so the "cut" removed nothing and the
     * group holds the solid whole.
     *
     * Reported rather than refused here, because this function's job is
     * geometry and the decision is the caller's: the HTTP routes turn it into
     * a refusal, matching the editor -- whose own comment is "the mesh paths
     * treat that as a failed cut rather than a group, and so does this" --
     * while a test can use a hole that deliberately misses to observe where
     * the placed solid lands, which is how the rotation regression in #54 is
     * measured.
     */
    cutRemovedNothing?: boolean;
  }
  | { error: string; status: number };

/** OCCT takes an affine transform as three row-major rows of (basis, offset); THREE stores its matrix by column. */
function rowMajorTransform(matrix: Matrix4) {
  const e = matrix.elements;
  return [
    e[0], e[4], e[8], e[12],
    e[1], e[5], e[9], e[13],
    e[2], e[6], e[10], e[14],
  ];
}

function meshTrianglePositions(mesh: MeshData) {
  const positions: number[] = [];
  for (const face of mesh.faces) {
    for (const vertexIndex of face) {
      const vertex = mesh.vertices[vertexIndex];
      if (vertex) positions.push(vertex[0], vertex[1], vertex[2]);
    }
  }
  return positions;
}

/**
 * The shape as a solid where it stands in the project.
 *
 * A shape carrying a mesh is taken from that mesh, already placed: its stored
 * triangles are the only description of it the project has, and they are what
 * the editor's own booleans consume, so a shape cut here comes out the shape it
 * looks like on screen. Everything else is built exactly from its parameters
 * and then moved into place.
 */
/**
 * The shape as an exact solid, where the shape actually sits.
 *
 * Exported because measuring the distance between two shapes needs the same
 * placement a boolean between them would use. Both have to be the real one: the
 * rotation is applied exactly once here (see `localSolidForShape` for the double
 * rotation this split fixed), and a mirrored shape goes through
 * `generalTransform` because a reflection is not a rigid placement.
 */
export function placedSolidForShape(cad: OcctKernel, shape: WorkplaneShape): ShapeHandle {
  // A plain revolve is stored as its sweep's mesh, but its profile describes
  // it exactly (#523). It is built in the mesh's own frame and placed the way
  // the mesh is, with the mirror applied exactly about the same centre rather
  // than through `generalTransform`, so its faces stay analytic.
  const revolve = exactRevolveLocalSolid(cad, shape);
  if (revolve) {
    const mirrored = mirroredInShapeFrame(cad, revolve, shape, { x: 0, y: shape.height / 2, z: 0 });
    const rigid = { ...shape, mirrorX: false, mirrorY: false, mirrorZ: false };
    return cad.transform(mirrored, rowMajorTransform(shapePlacementMatrix(rigid)));
  }
  const mesh = worldMeshForShape(shape);
  if (mesh) return solidFromMeshPositions(cad, meshTrianglePositions(mesh));
  if (isGroupRecord(shape)) return groupRecordSolid(cad, shape);

  let solid: ShapeHandle;
  try {
    solid = localSolidForShape(cad, shape);
  } catch (error) {
    if (error instanceof UnbuildableShapeError) throw new ServerCadError(error.message);
    throw error;
  }
  const matrix = rowMajorTransform(shapePlacementMatrix(shape));
  // A mirror reflects, which no rigid placement can express, so those shapes
  // go the long way round and lose their analytic surfaces in the process.
  return shape.mirrorX || shape.mirrorY || shape.mirrorZ
    ? cad.generalTransform(solid, matrix)
    : cad.transform(solid, matrix);
}

/**
 * A plain revolve's exact solid where it stands, as BREP text, or null for any
 * other shape: what the STEP exporter writes for a revolve instead of skipping
 * it as a mesh with no B-rep source (#523).
 */
export function placedExactRevolveBrep(shape: WorkplaneShape): Promise<string | null> {
  if (!hasExactRevolveSolid(shape)) return Promise.resolve(null);
  return withCadKernel((cad) => cad.toBREP(placedSolidForShape(cad, shape)));
}

function singleSolid(cad: OcctKernel, shape: ShapeHandle) {
  if (cad.isSolid(shape)) return shape;
  const solids = cad.getSubShapes(shape, "solid");
  return solids.length === 1 ? solids[0] : shape;
}

/**
 * Whether the shape is a group held only as a record of its children.
 *
 * Grouping solids with no hole among them stores the children and nothing
 * else, in the editor and here alike, so there is no mesh or BREP to read.
 */
export function isGroupRecord(shape: WorkplaneShape) {
  return Boolean(shape.groupedShapes?.length) && !shape.cadBrep && !worldMeshForShape(shape);
}

/**
 * A group record as the one solid it stands for: its children, put back where
 * they appear, fused (#500).
 *
 * Built when asked for rather than baked when grouping, because the record is
 * what the editor stores and reads, and what ungrouping takes apart. Each child
 * goes back through `placedSolidForShape`, so an exact child stays exact, a
 * mesh child is sewn from its triangles, and a group nested inside is fused
 * the same way. A group of holes is the region it removes, so it fuses too.
 *
 * A member hidden inside the group is left out, because the editor does not
 * draw it either: what is measured and exported is what is on screen. The
 * group's own `hidden` flag is not a member's, so it is read from the stored
 * children rather than from the restored ones, which inherit it.
 */
function groupRecordSolid(cad: OcctKernel, group: WorkplaneShape): ShapeHandle {
  const stored = group.groupedShapes ?? [];
  const children = restoreGroupedChildren(group).filter((_, index) => !stored[index]?.hidden);
  if (children.length === 0) {
    throw new ServerCadError(`"${group.name}" is a group whose members are all hidden, so it has no geometry; show a member first.`);
  }
  const solids = children.filter((child) => !child.hole);
  if (solids.length === 0) return fuseSolids(cad, children);
  const holes = children.filter((child) => child.hole);
  return holes.length ? cutSolids(cad, solids, holes).cut : fuseSolids(cad, solids);
}

function fuseSolids(cad: OcctKernel, shapes: WorkplaneShape[]) {
  const handles = shapes.map((shape) => placedSolidForShape(cad, shape));
  return singleSolid(cad, handles.length === 1 ? handles[0] : cad.fuseAll(handles));
}

/**
 * Every solid fused together, with every hole taken out of the result.
 *
 * Fusing first is what makes a multi-solid cut mean what it reads as: a hole
 * spanning two touching plates goes through both, rather than through whichever
 * one happened to be cut first.
 */
type CutOutcome = {
  cut: ShapeHandle;
  /** Volume of everything fused together, before any hole was taken out. */
  fusedVolume: number;
  /** Volume left afterwards. Equal to `fusedVolume` when no hole met the solid. */
  cutVolume: number;
};

function cutSolids(cad: OcctKernel, solids: WorkplaneShape[], holes: WorkplaneShape[]): CutOutcome {
  const solidHandles = solids.map((shape) => placedSolidForShape(cad, shape));
  const holeHandles = holes.map((shape) => placedSolidForShape(cad, shape));
  const fused = singleSolid(cad, solidHandles.length === 1 ? solidHandles[0] : cad.fuseAll(solidHandles));
  // Measured, because `cutAll` returns the solid untouched when nothing met it
  // and says nothing about having done so. The worker path has reported these
  // two volumes since it was written; this one did not, so a hole that missed
  // was stored and answered as a successful cut.
  const fusedVolume = cad.getVolume(fused);
  const cut = singleSolid(cad, cad.cutAll(fused, holeHandles));
  return { cut, fusedVolume, cutVolume: cad.getVolume(cut) };
}

/**
 * A group holding the given shapes, with any hole among them cut out.
 *
 * This is one operation rather than two because it is one operation in the
 * editor: grouping is what applies a hole, so "group" and "cut" differ only in
 * how the caller named the operands.
 *
 * A group that is only a record is taken apart first and its children become
 * the operands, so cutting into a group cuts the shapes it holds.
 */
export async function buildGroupFromSelection(selection: WorkplaneShape[]): Promise<GroupBuildOutcome> {
  const operands = expandGroupsForBoolean(selection);
  const solids = operands.filter((shape) => !shape.hole);
  const holes = operands.filter((shape) => shape.hole);

  if (solids.length === 0 || holes.length === 0) {
    const group = groupedShapeFromSelection(selection);
    return group ? { group } : { error: "At least two shapes are needed to group.", status: 400 };
  }

  let result;
  try {
    result = await withCadKernel((cad) => {
      const { cut, fusedVolume, cutVolume } = cutSolids(cad, solids, holes);
      // Asked before the result is stored, not after. The exact geometry goes
      // into `cadBrep`, which a later fillet or a STEP export reads, so storing
      // something the kernel calls invalid defers the failure to whoever opens
      // the project next. Unlike a cut that removed nothing, there is no caller
      // this is useful to, so it is refused here rather than reported.
      if (!cadResultIsValid(cad, cut)) {
        throw new ServerCadError("That cut produced geometry the kernel reports as invalid.");
      }
      // Measured with the same threshold the editor uses, so the two agree
      // about what counts as a cut.
      const removedNothing = cutVolume >= fusedVolume - 1e-6;
      // No coarser than the finest exact revolve that went in (#523).
      const angularDeflection = exactRevolveAngularDeflection(operands);
      const meshed = meshedCadResult(cad, cut, undefined, undefined, undefined, angularDeflection);
      const bounds = boundsForPositions(meshed.positions);
      if (!bounds) return { meshed, brep: null, removedNothing };
      // The exact geometry is stored in the result's own frame, the way a
      // treated shape stores it, so a later fillet or a STEP export of the cut
      // reads from true surfaces rather than from the triangles.
      const centered = cad.translate(
        cut,
        -(bounds.minX + bounds.maxX) / 2,
        -bounds.minY,
        -(bounds.minZ + bounds.maxZ) / 2,
      );
      return { meshed, brep: cad.toBREP(centered), removedNothing };
    });
  } catch (error) {
    if (error instanceof ServerCadError) return { error: error.message, status: error.status };
    return { error: error instanceof Error ? error.message : "The CAD kernel could not complete that cut.", status: 422 };
  }

  const firstSolid = solids[0];
  const group = meshShapeFromWorldPositions(result.meshed.positions, {
    id: createLocalId("grouped-boolean"),
    name: "Group",
    color: firstSolid.color,
    groupOperation: "group",
  });
  if (!group || !result.brep) {
    return { error: "Those holes remove the whole solid, so the cut would leave nothing behind.", status: 422 };
  }

  const width = group.width ?? group.size;
  const depth = group.depth ?? group.size;
  return {
    group: {
      ...group,
      importedMesh: {
        ...group.importedMesh!,
        normals: result.meshed.normals?.length === group.importedMesh!.positions.length ? result.meshed.normals : undefined,
      },
      cadBrep: result.brep,
      cadBrepFrame: { x: group.x, z: group.z, elevation: group.elevation ?? 0, width, depth, height: group.height },
      groupedBaseWidth: width,
      groupedBaseDepth: depth,
      groupedBaseHeight: group.height,
      groupedShapes: operands.map((shape) => shapeAsGroupChild(shape, group.x, group.z, group.elevation ?? 0)),
    },
    ...(result.removedNothing ? { cutRemovedNothing: true } : {}),
  };
}
