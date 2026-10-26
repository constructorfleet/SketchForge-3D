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
import { solidFromBrepOnKernel } from "./sketchFaceDraftKernel.js";
import { shapeDepth, shapeHasTaper, shapeWidth } from "./workplaneShapes.js";
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
  return placedSolid(cad, shape).solid;
}

/** Which stored representation supplied the geometry, and whether it is exact. */
export type ShapeGeometryProvenance = {
  /** Which stored representation supplied the geometry that was measured. */
  source: "parametric" | "brep" | "mesh";
  /** Imported triangle meshes remain tessellated even after sewing into a solid. */
  precision: "exact" | "tessellated";
};

export type PlacedSolid = { solid: ShapeHandle; provenance: ShapeGeometryProvenance };

const PARAMETRIC: ShapeGeometryProvenance = { source: "parametric", precision: "exact" };
const BREP: ShapeGeometryProvenance = { source: "brep", precision: "exact" };
const MESH: ShapeGeometryProvenance = { source: "mesh", precision: "tessellated" };

/**
 * Several solids' provenance as one: only as exact as the least exact of them.
 * A group record is reported this way from the members it actually fused, so
 * a member that fell back to its triangles -- a cut resized with its group,
 * or one whose B-rep failed its check -- makes the record tessellated.
 */
function combinedProvenance(sources: readonly ShapeGeometryProvenance[]): ShapeGeometryProvenance {
  return sources.find((source) => source.source === "mesh")
    ?? sources.find((source) => source.source === "brep")
    ?? PARAMETRIC;
}

/**
 * The shape as a placed solid, together with the representation it was
 * actually built from. Reported by the builder rather than guessed from the
 * shape's fields beforehand, because only building it can tell whether a
 * stored B-rep passed its check or a group member fell back to its mesh.
 */
export function placedSolid(cad: OcctKernel, shape: WorkplaneShape): PlacedSolid {
  // A plain revolve is stored as its sweep's mesh, but its profile describes
  // it exactly (#523). It is built in the mesh's own frame and placed the way
  // the mesh is, with the mirror applied exactly about the same centre rather
  // than through `generalTransform`, so its faces stay analytic.
  const revolve = exactRevolveLocalSolid(cad, shape);
  if (revolve) {
    const mirrored = mirroredInShapeFrame(cad, revolve, shape, { x: 0, y: shape.height / 2, z: 0 });
    const rigid = { ...shape, mirrorX: false, mirrorY: false, mirrorZ: false };
    return { solid: cad.transform(mirrored, rowMajorTransform(shapePlacementMatrix(rigid))), provenance: PARAMETRIC };
  }
  // A boolean result keeps its exact solid beside the mesh it is drawn with
  // (#541), and the triangles are only ever an approximation of it.
  const stored = placedResultBrepSolid(cad, shape);
  if (stored) return { solid: stored, provenance: BREP };
  const mesh = worldMeshForShape(shape);
  if (mesh) return { solid: solidFromMeshPositions(cad, meshTrianglePositions(mesh)), provenance: MESH };
  if (isGroupRecord(shape)) {
    const sources: ShapeGeometryProvenance[] = [];
    const solid = groupRecordSolid(cad, shape, sources);
    return { solid, provenance: combinedProvenance(sources) };
  }
  return { solid: placedLocalSolid(cad, shape), provenance: shape.cadBrep ? BREP : PARAMETRIC };
}

function placedLocalSolid(cad: OcctKernel, shape: WorkplaneShape): ShapeHandle {
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
 * Whether the shape is a boolean result whose stored B-rep is still the exact
 * form of the mesh it is drawn with (#541).
 *
 * A cut stores two descriptions of one solid: the triangles the viewport
 * draws, and the B-rep they were tessellated from, both in the result's own
 * frame -- centred in X and Z, base at Y = 0. While the two agree, the B-rep is
 * the better answer to "what is this solid", so measurement, interference and
 * a further boolean read it instead of sewing the triangles back up.
 *
 * They stop agreeing when an edit reaches the mesh and not the B-rep. Moving,
 * turning and mirroring do not: they are placement, applied to both alike. A
 * resize does, because it stretches the stored triangles and the B-rep keeps
 * its original size; so does a taper, and so does a frame recorded with a
 * baked `sourceTransform`, which puts the B-rep somewhere other than the
 * mesh's frame. A result made from a mesh operand is left out too: its B-rep
 * was sewn from triangles, so calling it exact would be a claim about
 * geometry nobody ever had.
 *
 * Edge treatments, drafts and shells rewrite the B-rep under their own rules
 * and stay on the paths they had.
 */
export function hasCurrentResultBrep(shape: WorkplaneShape): boolean {
  const mesh = shape.importedMesh;
  if (!shape.cadBrep || !shape.cadBrepFrame || shape.cadBrepFrame.sourceTransform) return false;
  if (!shape.groupedShapes?.length || !mesh || mesh.positions.length < 9) return false;
  if (shape.edgeTreatments?.length || shape.faceDraft || shape.shell || shapeHasTaper(shape)) return false;
  const unresized = (current: number, base: number) => Math.abs(current - base) <= RESULT_SIZE_TOLERANCE_MM;
  if (!unresized(shapeWidth(shape), mesh.baseWidth)
    || !unresized(shapeDepth(shape), mesh.baseDepth)
    || !unresized(shape.height, mesh.baseHeight)) return false;
  return shape.groupedShapes.every(operandIsExact);
}

/**
 * Stored sizes are rounded to a thousandth of a millimetre while the mesh's
 * base size is not, so an untouched result differs from its mesh by up to
 * half of that. Absolute, not relative to the size: a 200 mm cut stretched by
 * 0.15 mm is a resize, and a relative tolerance would call it untouched and
 * measure the stale B-rep.
 */
const RESULT_SIZE_TOLERANCE_MM = 1e-3;

/** Whether an operand went into a cut as exact geometry rather than as triangles. */
function operandIsExact(child: WorkplaneShape): boolean {
  if (hasExactRevolveSolid(child) || hasCurrentResultBrep(child)) return true;
  if ((child.importedMesh?.positions.length ?? 0) >= 9) return false;
  return child.groupedShapes?.length ? child.groupedShapes.every(operandIsExact) : true;
}

/**
 * How far a result's B-rep may sit from its mesh's box: the cut is meshed to
 * a tenth of a millimetre of chord height, so its corners can fall that far
 * inside the true surfaces, with a margin on top for a large part.
 */
const RESULT_BREP_MATCH_MM = 0.25;
const RESULT_BREP_MATCH_FRACTION = 0.01;

/**
 * How far a result's B-rep volume may differ from its mesh's, per mm² of the
 * B-rep's surface. Every triangle lies within the 0.1 mm chord height of the
 * true surface it was tessellated from, so the faceting can move at most
 * that much depth across the whole area; twice it leaves room for OCCT
 * treating the deflection as a target rather than a hard bound. A flat face
 * contributes nothing, so a box-like part sits far inside this.
 */
const RESULT_BREP_VOLUME_MM_PER_AREA = 0.2;

/** The volume a closed triangle list encloses, by the divergence theorem. */
function enclosedVolume(positions: readonly number[]) {
  let sixTimes = 0;
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(index, index + 9);
    sixTimes += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(sixTimes) / 6;
}

/**
 * A boolean result's stored B-rep, placed where the shape stands, or null to
 * use its mesh instead.
 *
 * Placed the way the mesh is placed, since the two share a frame: mirrored
 * exactly about the shape's centre, then moved rigidly, so the cut's
 * cylinders stay cylinders. A cut's B-rep is in the result's own frame, at the
 * origin -- what `cadBrepFrame` records for a cut since #548, and what loading
 * a project corrects an older cut's frame to (`migratePre548CutBrepFrames`) --
 * so the frame's position is not needed here; `cadBrepTransformForShape` would
 * give the same placement, only with the mirror folded into an affine scale.
 * A B-rep stored anywhere else fails the bounds check below and falls back to
 * the mesh.
 *
 * The B-rep is checked against the mesh before it is trusted, because the
 * structural test cannot see an edit that replaced the triangles and left the
 * B-rep behind. The triangles' corners lie on the true surfaces, so the two
 * boxes agree to within the meshing tolerance; a B-rep that misses by more is
 * describing something else, and the mesh is what is on screen.
 */
export function placedResultBrepSolid(cad: OcctKernel, shape: WorkplaneShape): ShapeHandle | null {
  if (!hasCurrentResultBrep(shape)) return null;
  const meshBounds = boundsForPositions(shape.importedMesh!.positions);
  if (!meshBounds) return null;
  let solid: ShapeHandle;
  try {
    solid = solidFromBrepOnKernel(cad, shape.cadBrep!);
  } catch {
    return null;
  }
  const box = cad.getBoundingBox(solid);
  const size = Math.max(meshBounds.maxX - meshBounds.minX, meshBounds.maxY - meshBounds.minY, meshBounds.maxZ - meshBounds.minZ);
  const tolerance = RESULT_BREP_MATCH_MM + RESULT_BREP_MATCH_FRACTION * size;
  const agrees = [
    [box.xmin, meshBounds.minX], [box.xmax, meshBounds.maxX],
    [box.ymin, meshBounds.minY], [box.ymax, meshBounds.maxY],
    [box.zmin, meshBounds.minZ], [box.zmax, meshBounds.maxZ],
  ].every(([exact, meshed]) => Number.isFinite(exact) && Math.abs(exact - meshed) <= tolerance);
  if (!agrees) return null;
  // A box cannot see inside: the uncut plate has the same one as the plate
  // with a bore through it. The volume can.
  const query = cad.queryBatch([solid])[0];
  if (!query || !Number.isFinite(query.volume)
    || Math.abs(query.volume - enclosedVolume(shape.importedMesh!.positions)) > RESULT_BREP_VOLUME_MM_PER_AREA * query.area) {
    return null;
  }
  const mirrored = mirroredInShapeFrame(cad, solid, shape, { x: 0, y: shape.height / 2, z: 0 });
  const rigid = { ...shape, mirrorX: false, mirrorY: false, mirrorZ: false };
  return cad.transform(mirrored, rowMajorTransform(shapePlacementMatrix(rigid)));
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
function groupRecordSolid(cad: OcctKernel, group: WorkplaneShape, sources: ShapeGeometryProvenance[]): ShapeHandle {
  const stored = group.groupedShapes ?? [];
  const children = restoreGroupedChildren(group).filter((_, index) => !stored[index]?.hidden);
  if (children.length === 0) {
    throw new ServerCadError(`"${group.name}" is a group whose members are all hidden, so it has no geometry; show a member first.`);
  }
  const solids = children.filter((child) => !child.hole);
  if (solids.length === 0) return fuseSolids(cad, children, sources);
  const holes = children.filter((child) => child.hole);
  return holes.length ? cutSolids(cad, solids, holes, sources).cut : fuseSolids(cad, solids, sources);
}

/** Each shape placed, with the representation it came from added to `sources`. */
function placedHandles(cad: OcctKernel, shapes: WorkplaneShape[], sources?: ShapeGeometryProvenance[]) {
  return shapes.map((shape) => {
    const placed = placedSolid(cad, shape);
    sources?.push(placed.provenance);
    return placed.solid;
  });
}

function fuseSolids(cad: OcctKernel, shapes: WorkplaneShape[], sources?: ShapeGeometryProvenance[]) {
  const handles = placedHandles(cad, shapes, sources);
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

function cutSolids(cad: OcctKernel, solids: WorkplaneShape[], holes: WorkplaneShape[], sources?: ShapeGeometryProvenance[]): CutOutcome {
  const solidHandles = placedHandles(cad, solids, sources);
  const holeHandles = placedHandles(cad, holes, sources);
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
      // Where the B-rep is, not where the shape is: it was recentred above
      // into the result's own frame, at the origin (#548).
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width, depth, height: group.height },
      groupedBaseWidth: width,
      groupedBaseDepth: depth,
      groupedBaseHeight: group.height,
      groupedShapes: operands.map((shape) => shapeAsGroupChild(shape, group.x, group.z, group.elevation ?? 0)),
    },
    ...(result.removedNothing ? { cutRemovedNothing: true } : {}),
  };
}
