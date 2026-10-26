/**
 * Fillet and chamfer on the server (upstream issue #55).
 *
 * Node-only. The browser worker does this for the editor, over a much wider
 * range of inputs: it can take any shape because the editor can mesh any
 * shape. The server has no mesher, so it works from what a stored project
 * actually carries -- a box's dimensions, a previous CAD result's exact BREP,
 * or an imported model's triangles -- and refuses anything else rather than
 * approximating it.
 *
 * The worker's own reconstruction is not reused: it lives inside a file that
 * talks to `self.postMessage` and is close to upstream's, and prising it apart
 * would conflict with every upstream change to it. What is shared instead is
 * the result format, so a shape filleted here is indistinguishable in the
 * editor from one filleted there -- and, through `meshShellSolids`, how a mesh
 * of several closed shells becomes one solid, so the two agree on which meshes
 * with internal voids are solids (#527).
 */

import type { EvolutionData, OcctKernel, ShapeHandle } from "occt-wasm";
import { faceIdsFromEvolution } from "./faceLineage.js";
import { withCadKernel } from "./serverCadKernel.js";
import {
  exactSolidForShape,
  mirroredInShapeFrame,
  shapeIsTurned,
  unrotatedSolidForShape,
  UnbuildableShapeError,
  EXACT_SOLID_KINDS,
} from "./cadSolids.js";
import { canonicalizeShape, shapeHasTaper } from "./workplaneShapes.js";
import { createLocalId } from "./localIds.js";
import type { SketchProfile, WorkplaneShape } from "./domain/sketchforge.js";
import { cadSketchRegions, draftPrismLoop, type OrderedCadSketchPath } from "./sketchCadProfile.js";
import { sketchExtrusionSolid } from "./sketchExtrusionSolid.js";
import { normalizeSketchRevolveSettings, sketchProfileToRevolvePolygons } from "./sketchRevolve.js";
import { triangleFaceGroups } from "./cadFaceMesh.js";
import { meshDataFromPositions } from "./meshMassProperties.js";
import { MeshShellsOverlapError } from "./meshShellOverlap.js";
import { MeshShellSolidError, nestedMeshShellSolid } from "./meshShellSolids.js";
import { draftSketchFace, draftPrismProfileOffset, faceIdsForCadResult, type SketchFaceDraftRequest } from "./sketchFaceDraftKernel.js";

export type ServerCadEdge = {
  index: number;
  length: number;
  curveType: string;
  midpoint: { x: number; y: number; z: number };
  /**
   * Whether this edge is one a fillet or chamfer can act on.
   *
   * An edge between two faces can be rounded. A seam -- where one curved
   * surface meets itself, as on a cylinder's side or around a torus -- has no
   * two faces to blend, and OCCT refuses it.
   */
  filletable: boolean;
};

export type ServerCadTreatment = {
  kind: "fillet" | "chamfer";
  amount: number;
  /** Chamfers only; 45 degrees is a symmetric chamfer. */
  angle?: number;
  /** Edge indexes from `shapeEdges`, or every edge when omitted. */
  edges?: number[];
};

export class ServerCadError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "ServerCadError";
    this.status = status;
  }
}

const MESH_DEFLECTION = 0.1;
const MIN_CAD_DIMENSION = 0.01;
const FACE_HASH_UPPER_BOUND = 2_147_483_647;
export type { SketchFaceDraftRequest } from "./sketchFaceDraftKernel.js";

/**
 * How far a retained sketch output has been resized since it was swept: its
 * drawn dimensions over the ones its source geometry was built at.
 */
export function sketchResizeFactors(shape: WorkplaneShape) {
  const mesh = shape.importedMesh;
  // A face-drafted output's bounds include its taper, so the resize recorded
  // with the draft is the one to use. Once the draft is gone the bounds are
  // the extrusion's again, and a recorded scale would hide any resize since.
  if (shape.faceDraft && shape.faceDraftSourceScale) return shape.faceDraftSourceScale;
  const factor = (drawn: number, base: number | undefined) => base && base > 0 ? drawn / base : 1;
  return {
    width: factor(shape.width, mesh?.baseWidth),
    depth: factor(shape.depth, mesh?.baseDepth),
    height: factor(shape.height, mesh?.baseHeight),
  };
}

function scaledSketchProfile(profile: SketchProfile, width: number, depth: number): SketchProfile {
  const xs = profile.points.map((point) => point.x);
  const zs = profile.points.map((point) => point.z);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const scalePoint = (point: SketchProfile["points"][number]) => ({
    ...point,
    x: centerX + (point.x - centerX) * width,
    z: centerZ + (point.z - centerZ) * depth,
    ...(point.handleIn ? { handleIn: { ...point.handleIn, x: centerX + (point.handleIn.x - centerX) * width, z: centerZ + (point.handleIn.z - centerZ) * depth } } : {}),
    ...(point.handleOut ? { handleOut: { ...point.handleOut, x: centerX + (point.handleOut.x - centerX) * width, z: centerZ + (point.handleOut.z - centerZ) * depth } } : {}),
  });
  return { ...profile, points: profile.points.map(scalePoint) };
}

const isResized = (factors: { width: number; depth: number; height: number }) =>
  [factors.width, factors.depth, factors.height].some((factor) => Math.abs(factor - 1) > 1e-8);

/**
 * A sketch extrusion whose exact solid is still its bare sweep -- no draft,
 * treatment or shell -- has its B-rep stored at the size it was drawn. A resize
 * since then lives only in its dimensions, so its exact solid at the size it is
 * shown is its profile scaled by that resize and extruded to its height, the
 * rebuild `applySketchFaceDraft` makes (#452 for width and depth; #546 fixed
 * the engine handing a height-resized extrusion to it at twice its height).
 * Null when there is no resize to apply, or the solid is something else.
 *
 * Without this, a fillet, chamfer or shell of a resized extrusion was built
 * from the B-rep as drawn and stored back at the original size (#539).
 */
export function resizedSketchExtrusionProfile(shape: WorkplaneShape): SketchProfile | null {
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile || !shape.cadBrep) return null;
  if (shape.faceDraft !== undefined || shape.draftPrismAngle !== undefined || shape.shell
    || (shape.edgeTreatments?.length ?? 0) > 0 || (shape.edgeTreatmentHistory?.length ?? 0) > 0) return null;
  const resize = sketchResizeFactors(shape);
  return isResized(resize) ? scaledSketchProfile(shape.sketchProfile, resize.width, resize.depth) : null;
}

/** The bare extrusion's exact solid at its drawn size, or its stored solid when it has not been resized. */
function storedOrResizedSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const resizedProfile = resizedSketchExtrusionProfile(shape);
  if (!resizedProfile) return localSolidForShape(cad, shape);
  const solid = sketchExtrusionSolid(cad, resizedProfile, shape.height);
  if (!cadResultIsValid(cad, solid)) {
    throw new ServerCadError("The resized sketch extrusion could not be rebuilt as exact CAD geometry.");
  }
  return solid;
}

function meshPositionsOf(shape: WorkplaneShape) {
  const positions = shape.importedMesh?.positions;
  return positions && positions.length >= 9 ? positions : null;
}

/** An ASCII STL of a triangle soup, which is how OCCT takes an arbitrary mesh. */
function asciiStlFromPositions(positions: number[]) {
  const lines = ["solid shape"];
  for (let index = 0; index + 8 < positions.length; index += 9) {
    lines.push("facet normal 0 0 0", "outer loop");
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = index + corner * 3;
      lines.push(`vertex ${positions[offset]} ${positions[offset + 1]} ${positions[offset + 2]}`);
    }
    lines.push("endloop", "endfacet");
  }
  lines.push("endsolid shape");
  return lines.join("\n");
}

/**
 * Whether the kernel considers a shape sound.
 *
 * Deliberately does not require a single solid, which `isValidSolid` below
 * does: a cut can split one solid into several bodies -- that is what
 * `POST /parts` exists to separate -- so a compound is a legitimate result and
 * must not be refused as invalid. Same semantics as the CAD modifier worker's
 * own check, so the two paths agree about what a usable result is.
 */
export function cadResultIsValid(cad: OcctKernel, shape: ShapeHandle) {
  try {
    return Boolean(cad.isValid(shape));
  } catch {
    return false;
  }
}

function isValidSolid(cad: OcctKernel, shape: ShapeHandle) {
  try {
    return cad.isSolid(shape) && Boolean(cad.isValid(shape));
  } catch {
    return false;
  }
}

function solidFromBrep(cad: OcctKernel, brep: string) {
  let exact = cad.fromBREP(brep);
  const solids = cad.getSubShapes(exact, "solid");
  if (isValidSolid(cad, exact) || solids.length > 0) {
    return solids.length === 1 ? solids[0] : exact;
  }
  exact = cad.fixShape(exact);
  exact = cad.fixFaceOrientations(exact);
  const healed = cad.getSubShapes(exact, "solid");
  if (isValidSolid(cad, exact) || healed.length > 0) {
    return healed.length === 1 ? healed[0] : exact;
  }
  throw new ServerCadError("The stored exact geometry for that shape could not be read.");
}

/**
 * A solid sewn from a flat list of triangle corners, which is how a stored mesh arrives.
 *
 * A mesh made of several closed shells -- a part with a sealed internal void,
 * or separate bodies -- is built one shell at a time and put back together by
 * nesting (#501). Sewn all at once, OCCT got a shell inside a shell, could make
 * no one solid of it, and refused a watertight part outright.
 */
export function solidFromMeshPositions(cad: OcctKernel, positions: number[]) {
  let nested: ShapeHandle | null;
  try {
    nested = nestedMeshShellSolid(cad, meshDataFromPositions(positions), (shell) => sewnMeshSolid(cad, shell));
  } catch (error) {
    if (!(error instanceof MeshShellSolidError)) throw error;
    throw new ServerCadError(error.reason === "shells-overlap" ? MESH_SHELLS_OVERLAP : MESH_NOT_SOLID);
  }
  return nested ?? sewnMeshSolid(cad, positions);
}

/** The exact path's refusal for a mesh error the kernel-free measures throw; anything else unchanged. */
export function asServerCadError(error: unknown) {
  return error instanceof MeshShellsOverlapError ? new ServerCadError(MESH_SHELLS_OVERLAP) : error;
}

const MESH_SHELLS_OVERLAP =
  "That shape's mesh has closed bodies that overlap without one enclosing the other, so the CAD kernel cannot tell which side of each is material. Union the bodies in the mesh before importing it.";

/**
 * Why a mesh could not become a solid. Shared by every exact path that reads a
 * mesh -- properties, booleans, interference, drawings -- so it names none of
 * them; it used to say "cannot be filleted" to all of them.
 */
const MESH_NOT_SOLID = "That shape's mesh is not a closed solid, so the CAD kernel cannot build exact geometry from it.";

/** One shell's triangles sewn into a solid, loosening the tolerance until it closes. */
function sewnMeshSolid(cad: OcctKernel, positions: number[]) {
  const imported = cad.importStl(asciiStlFromPositions(positions));
  let shape = cad.fixShape(imported);
  if (isValidSolid(cad, shape)) return shape;
  const faces = cad.getSubShapes(imported, "face");
  if (faces.length === 0) throw new ServerCadError("That shape's mesh has no faces to work from.");
  // Loosening the sewing tolerance in steps: a tessellated curve needs more
  // slack to close than a flat-faced mesh does.
  for (const tolerance of [1e-5, 1e-4, 1e-3, 1e-2]) {
    try {
      let candidate = cad.fixShape(cad.sewAndSolidify(faces, tolerance));
      candidate = cad.fixFaceOrientations(candidate);
      if (isValidSolid(cad, candidate)) return candidate;
    } catch {
      // Try the next tolerance.
    }
  }
  throw new ServerCadError(MESH_NOT_SOLID);
}

/**
 * Whether the shape's geometry has to be turned, or arrives already turned.
 *
 * Stored geometry -- a previous result's BREP, an imported mesh -- is kept in
 * the frame the shape's own rotation applies *to*, so the rotation lives on the
 * shape and nothing rebuilds it. A parametric shape has no stored geometry, so
 * whatever frame its solid is in is a choice made when it is built.
 *
 * This is the one predicate the two builders below and
 * `treatmentBakesRotation` all read, so they cannot disagree about which frame
 * a solid is in -- which is exactly how they came to disagree before.
 */
function rotationIsRebuilt(shape: WorkplaneShape) {
  return !shape.cadBrep && !meshPositionsOf(shape);
}

/**
 * Whether a treated result has the shape's rotation baked into its geometry.
 *
 * True exactly when `orientedSolidForShape` applied it -- which is the only
 * place it is applied on this path. A result that has it baked in must not
 * carry the rotation as well, or the shape is turned twice.
 */
export function treatmentBakesRotation(shape: WorkplaneShape) {
  return rotationIsRebuilt(shape) && shapeIsTurned(shape);
}

/**
 * The shape as an exact solid, in its own local frame -- **unrotated**.
 *
 * A parametric shape is rebuilt from its dimensions rather than its mesh, so
 * its fillet is exact rather than a rounded approximation of a tessellation.
 *
 * Local: centred in X and Z with its base at Y=0 and square to the axes, which
 * is the frame every geometry builder in the app produces. A caller that needs
 * the solid where the shape actually sits has to place it -- rotation included.
 *
 * This is what a boolean wants: `shapePlacementMatrix` carries the shape's
 * rotation, so a solid that arrived already turned would be turned twice. It
 * was, until this split: a parametric operand went through
 * `exactSolidForShape`, which bakes the rotation in, and then through the
 * placement matrix, which applies it again. A 20x20x12 wedge at yaw 90 came out
 * with its centre of mass 3.33mm away in each of X and Z -- with the correct
 * volume and, because its footprint is square, the correct bounding box too.
 */
export function localSolidForShape(cad: OcctKernel, shape: WorkplaneShape) {
  if (shape.cadBrep) return solidFromBrep(cad, shape.cadBrep);

  const positions = meshPositionsOf(shape);
  if (positions) return solidFromMeshPositions(cad, [...positions]);

  try {
    return unrotatedSolidForShape(cad, shape);
  } catch (error) {
    if (error instanceof UnbuildableShapeError) throw new ServerCadError(error.message);
    throw error;
  }
}

/**
 * The same solid, turned the way the shape sits in the project.
 *
 * What an operation that stores its result as geometry wants -- a fillet, a
 * chamfer, a hollow -- because the result is stored as a mesh with no rotation
 * of its own, so a shape treated while turned would otherwise come back
 * straightened. `treatmentBakesRotation` is the other half of that bargain and
 * reads the same predicate.
 *
 * For stored geometry this is the local solid with only its mirror applied:
 * the rotation stays on the shape, which is where it already was. A resized
 * bare sketch extrusion is the exception: it is rebuilt at its drawn size
 * (`resizedSketchExtrusionProfile`), since its stored B-rep is not.
 *
 * Mirrored either way, because the result is stored with the shape's mirror
 * flags cleared. Building it unmirrored handed back the unmirrored shape and
 * reported success (#413).
 */
export function orientedSolidForShape(cad: OcctKernel, shape: WorkplaneShape) {
  if (!rotationIsRebuilt(shape)) return mirroredStoredSolid(cad, storedOrResizedSolid(cad, shape), shape);

  try {
    return exactSolidForShape(cad, shape);
  } catch (error) {
    if (error instanceof UnbuildableShapeError) throw new ServerCadError(error.message);
    throw error;
  }
}

/**
 * A solid stored on the shape -- its BREP, its mesh, or a revolve rebuilt from
 * its profile -- with the shape's mirror flags applied about its own centre.
 *
 * The bounds centre rather than the origin, because stored geometry is not
 * always in the builders' frame (an earlier treatment's BREP keeps whatever
 * frame it was made in); the viewport mirrors the normalized mesh about its
 * centre, and a plane through any other point would only move the result.
 */
function mirroredStoredSolid(cad: OcctKernel, solid: ShapeHandle, shape: WorkplaneShape) {
  if (!shape.mirrorX && !shape.mirrorY && !shape.mirrorZ) return solid;
  const bounds = cad.getBoundingBox(solid, false);
  return mirroredInShapeFrame(cad, solid, shape, {
    x: (bounds.xmin + bounds.xmax) / 2,
    y: (bounds.ymin + bounds.ymax) / 2,
    z: (bounds.zmin + bounds.zmax) / 2,
  });
}

/** How many faces of the solid meet along this edge. A seam reports one. */
function adjacentFaceCount(cad: OcctKernel, solid: ShapeHandle, handle: ShapeHandle) {
  try {
    return cad.adjacentFaces(solid, handle).length;
  } catch {
    return 0;
  }
}

function edgeSummary(cad: OcctKernel, solid: ShapeHandle, handle: ShapeHandle, index: number): ServerCadEdge {
  const bounds = cad.getBoundingBox(handle, false);
  let curveType = "unknown";
  try {
    curveType = cad.curveType(handle);
  } catch {
    // Not every edge reports a curve type; the length and position still do.
  }
  return {
    index,
    length: cad.getLength(handle),
    curveType,
    midpoint: {
      x: (bounds.xmin + bounds.xmax) / 2,
      y: (bounds.ymin + bounds.ymax) / 2,
      z: (bounds.zmin + bounds.zmax) / 2,
    },
    filletable: adjacentFaceCount(cad, solid, handle) >= 2,
  };
}

/** The edges of a shape, in the order a treatment request refers to them by index. */
export function shapeEdges(shape: WorkplaneShape): Promise<ServerCadEdge[]> {
  return withCadKernel((cad) => {
    // Oriented, not local: the edge a caller names by index has to be the edge
    // the treatment then rounds, and a turned shape's edge midpoints are only
    // where the caller sees them once the rotation is applied. `edgeSolidForShape`
    // is what the treatment builds too, so the two cannot number differently.
    const solid = edgeSolidForShape(cad, shape);
    return cad.getSubShapes(solid, "edge").map((handle, index) => edgeSummary(cad, solid, handle, index));
  });
}

export type ServerCadResult = {
  brep: string;
  positions: number[];
  normals: number[] | null;
  triangleCount: number;
  faceIds?: string[];
  faceGroups?: number[];
};

/**
 * Reflect a parameter-built solid across a world-space axis plane and store the
 * reflected result as exact BREP with a matching display mesh. Existing
 * `mirrorX/Y/Z` flags are applied to the source first, so the operation removes
 * those flags while preserving the rendered result. The mirror plane passes
 * through `pivot` on the chosen world axis; callers use the selected bounds
 * midpoint, matching the editor's object-mirror convention.
 *
 * Exact source contract: parameter-built solids only. Imported meshes, groups,
 * and already baked BREP are refused rather than silently round-tripped through
 * triangles. The output has its world position baked into its normalized local
 * BREP and resets rotation and mirror flags.
 */
export function applyBakedMirror(shape: WorkplaneShape, axis: "x" | "y" | "z", pivot: number): Promise<WorkplaneShape> {
  if (!EXACT_SOLID_KINDS.includes(shape.kind as typeof EXACT_SOLID_KINDS[number])
    || shape.importedMesh || shape.cadBrep || shape.groupedShapes?.length) {
    return Promise.reject(new ServerCadError("Baked mirror requires exact parameter geometry; imported meshes, groups, and previously treated shapes are not supported yet."));
  }
  if (!Number.isFinite(pivot)) {
    return Promise.reject(new ServerCadError("The mirror plane must have a finite coordinate.", 400));
  }

  return withCadKernel((cad) => {
    let solid: ShapeHandle;
    try {
      solid = unrotatedSolidForShape(cad, shape);
    } catch (error) {
      if (error instanceof UnbuildableShapeError) throw new ServerCadError(error.message);
      throw error;
    }

    const centerY = shape.height / 2;
    solid = mirroredInShapeFrame(cad, solid, shape, { x: 0, y: centerY, z: 0 });

    const center = { x: 0, y: centerY, z: 0 };
    const angle = (degrees: number) => degrees * Math.PI / 180;
    if (shape.rotationZ) solid = cad.rotate(solid, { point: center, direction: { x: 0, y: 0, z: 1 } }, angle(shape.rotationZ));
    if (shape.rotation) solid = cad.rotate(solid, { point: center, direction: { x: 0, y: 1, z: 0 } }, angle(shape.rotation));
    if (shape.rotationX) solid = cad.rotate(solid, { point: center, direction: { x: 1, y: 0, z: 0 } }, angle(shape.rotationX));
    solid = cad.translate(solid, shape.x, shape.elevation ?? 0, shape.z);

    const point = { x: axis === "x" ? pivot : 0, y: axis === "y" ? pivot : 0, z: axis === "z" ? pivot : 0 };
    const normal = { x: axis === "x" ? 1 : 0, y: axis === "y" ? 1 : 0, z: axis === "z" ? 1 : 0 };
    const reflected = cad.mirror(solid, point, normal);
    if (!cadResultIsValid(cad, reflected)) throw new ServerCadError("The reflected exact solid is not valid.");

    const worldMesh = cad.meshShape(reflected, { linearDeflection: MESH_DEFLECTION });
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < worldMesh.positions.length; index += 3) {
      minX = Math.min(minX, worldMesh.positions[index]);
      maxX = Math.max(maxX, worldMesh.positions[index]);
      minY = Math.min(minY, worldMesh.positions[index + 1]);
      maxY = Math.max(maxY, worldMesh.positions[index + 1]);
      minZ = Math.min(minZ, worldMesh.positions[index + 2]);
      maxZ = Math.max(maxZ, worldMesh.positions[index + 2]);
    }
    if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) {
      throw new ServerCadError("The reflected solid produced no usable geometry.");
    }

    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const localSolid = cad.translate(reflected, -centerX, -minY, -centerZ);
    const result = meshedCadResult(cad, localSolid, shape);
    const normalized = shapeWithCadResult(shape, result);
    return canonicalizeShape({
        ...normalized,
        x: centerX,
        z: centerZ,
        elevation: minY,
        rotation: 0,
        rotationX: 0,
        rotationZ: 0,
        mirrorX: undefined,
        mirrorY: undefined,
        mirrorZ: undefined,
      });
  });
}

/**
 * Apply a fillet or chamfer and return the exact result with a mesh of it.
 *
 * Both are kept: the BREP is what STEP export and any later treatment work
 * from, and the mesh is what the viewport draws.
 */
export function applyEdgeTreatment(shape: WorkplaneShape, treatment: ServerCadTreatment): Promise<ServerCadResult> {
  if (!Number.isFinite(treatment.amount) || treatment.amount <= 0) {
    return Promise.reject(new ServerCadError("The fillet radius or chamfer distance must be greater than zero.", 400));
  }

  return withCadKernel((cad) => {
    const solid = edgeSolidForShape(cad, shape);
    const allEdges = cad.getSubShapes(solid, "edge");
    const requested = treatment.edges;
    if (requested?.some((index) => !Number.isInteger(index) || index < 0 || index >= allEdges.length)) {
      throw new ServerCadError(`Edge indexes must be between 0 and ${allEdges.length - 1}.`, 400);
    }
    // Seams cannot be rounded, and asking OCCT to try fails the whole
    // operation -- so a request for every edge means every edge that can be.
    const filletable = allEdges.filter((handle) => adjacentFaceCount(cad, solid, handle) >= 2);
    if (filletable.length === 0) {
      throw new ServerCadError(
        "That shape has no edges to round: its surface closes on itself, so there is no corner to blend.",
      );
    }
    const chosen = requested && requested.length > 0 ? requested.map((index) => allEdges[index]) : filletable;
    const edges = chosen.filter((handle) => adjacentFaceCount(cad, solid, handle) >= 2);
    if (edges.length === 0) {
      throw new ServerCadError(
        "None of those edges can be rounded: they are seams in a curved surface rather than corners. Check `filletable` in the edge listing.",
        400,
      );
    }

    const sourceFaces = cad.getSubShapes(solid, "face");
    const sourceFaceHashes = sourceFaces.map((face) => cad.hashCode(face, FACE_HASH_UPPER_BOUND));
    let treated: ShapeHandle;
    let evolution: EvolutionData | undefined;
    try {
      if (treatment.kind === "fillet") {
        evolution = cad.filletWithHistory(solid, edges, treatment.amount, sourceFaceHashes, FACE_HASH_UPPER_BOUND);
        treated = evolution.result;
      } else if (treatment.angle === undefined || Math.abs(treatment.angle - 45) < 0.001) {
        evolution = cad.chamferWithHistory(solid, edges, treatment.amount, sourceFaceHashes, FACE_HASH_UPPER_BOUND);
        treated = evolution.result;
      } else {
        treated = cad.chamferDistAngle(solid, edges, treatment.amount, treatment.angle);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wasmFault = typeof WebAssembly !== "undefined"
        && (error instanceof WebAssembly.Exception || error instanceof WebAssembly.RuntimeError);
      if (wasmFault || /out of memory|memory access out of bounds|allocation failed|wasm.*abort/i.test(message)) {
        throw error;
      }
      // Keep geometric sizing failures actionable without disguising runtime
      // faults as a user mistake.
      throw new ServerCadError(
        `The requested ${treatment.kind} amount ${treatment.amount} could not be applied to ${edges.length} eligible edges. Try a smaller amount.`,
      );
    }
    // Both fillet and chamfer hand back a compound wrapping the result, and
    // OCCT refuses a compound as the input to another treatment -- so storing
    // that as the shape's exact geometry would make the next fillet fail for
    // no visible reason. Unwrap the single solid inside it.
    const treatedSolids = cad.getSubShapes(treated, "solid");
    const result = treatedSolids.length === 1 ? treatedSolids[0] : treated;

    return meshedCadResult(cad, result, shape, evolution ? { sourceFaceHashes, evolution } : undefined, solid);
  });
}

/** Count currently chamferable/filletable edges without preserving topology indexes. */
export function allEdgeTreatmentEdgeCount(shape: WorkplaneShape, _kind: ServerCadTreatment["kind"]): Promise<number> {
  return withCadKernel((cad) => {
    const solid = edgeSolidForShape(cad, shape);
    return cad.getSubShapes(solid, "edge").filter((edge) => adjacentFaceCount(cad, solid, edge) >= 2).length;
  });
}

/**
 * A retained sketch revolve whose geometry is still exactly its sketch.
 *
 * A revolve is stored as a manifold mesh with its profile and settings beside
 * it, and nothing else: no `cadBrep` until something treats, shells or drafts
 * it. Its edges are therefore the facets of that mesh unless they are rebuilt
 * from the profile, which is what makes these shapes different from every
 * other mesh the server can be handed.
 */
function isUntreatedSketchRevolve(shape: WorkplaneShape) {
  return shape.sketchOperation === "revolve" && Boolean(shape.sketchProfile)
    && !shape.cadBrep && !shape.faceDraft;
}

/**
 * Why an untreated revolve has no exact solid to list or treat edges on, or
 * null when it has one.
 *
 * Only a plain full turn of one closed region is rebuilt exactly. Anything else
 * would fall back to the sewn tessellation, where a fillet "succeeds" by
 * rounding hundreds of facet edges and an edge index names a facet, so it is
 * refused instead.
 */
function revolveWithoutExactEdges(shape: WorkplaneShape): string | null {
  if (!isUntreatedSketchRevolve(shape)) return null;
  const settings = normalizeSketchRevolveSettings(shape.sketchRevolve);
  const limitation = "Fillets, chamfers and edge listings on a revolve use its exact solid, which is built only for a plain full turn of one closed profile region";
  if (settings.pitch !== 0) {
    return `${limitation}. This is a helical revolve (a thread or spring), whose only geometry is a tessellated sweep, so its edges are facets. Treat the profile before revolving it instead.`;
  }
  if (settings.coreRadius > 0) {
    return `${limitation}. This revolve is fused to a core, which has no exact solid here, so its edges are facets.`;
  }
  if (Math.abs(Math.abs(settings.sweepAngle) - 360) > 1e-6) {
    return `${limitation}. This revolve turns ${Math.abs(settings.sweepAngle)} degrees rather than a full turn, so its edges are facets.`;
  }
  const { radialX, radialZ } = revolveResizeFactors(shape);
  if (Math.abs(radialX - radialZ) > 1e-6 * Math.max(radialX, radialZ)) {
    return `${limitation}. This revolve has been resized unevenly across its axis, so it is no longer round and no revolve describes it exactly. Resize its width and depth together.`;
  }
  return null;
}

/**
 * How far a revolve has been resized since it was swept, per axis.
 *
 * The ratio of its drawn size to its mesh's natural size, which is what the
 * viewport stretches the mesh by.
 */
function revolveResizeFactors(shape: WorkplaneShape) {
  if (shape.faceDraftSourceScale) {
    return {
      radialX: shape.faceDraftSourceScale.width,
      radialZ: shape.faceDraftSourceScale.depth,
      axial: shape.faceDraftSourceScale.height,
    };
  }
  const mesh = shape.importedMesh;
  const ratio = (drawn: number, base: number | undefined) => (base && base > 0 && drawn > 0 ? drawn / base : 1);
  return {
    radialX: ratio(shape.width, mesh?.baseWidth),
    radialZ: ratio(shape.depth, mesh?.baseDepth),
    axial: ratio(shape.height, mesh?.baseHeight),
  };
}

/**
 * The exact solid of an untreated plain full-turn revolve, at its drawn size,
 * or null for any other shape.
 *
 * A resize is applied to the profile before it is turned, not to the solid
 * afterwards: the section is scaled radially by the width ratio and axially by
 * the height ratio, so a resized revolve is still a revolve and its faces stay
 * analytic. Scaling the solid instead goes wrong both ways the kernel offers --
 * `transform` turns an uneven scale into a uniform one, and `generalTransform`
 * approximates every face as a B-spline that is about 1% off in volume and
 * cannot be written back out as BREP.
 *
 * The ratios are to the mesh's natural size rather than its bounds, which for
 * a facet count that is not a multiple of four are narrower than the circle.
 */
function exactRevolveSolidForShape(cad: OcctKernel, shape: WorkplaneShape) {
  if (!isUntreatedSketchRevolve(shape) || revolveWithoutExactEdges(shape)) return null;
  const { radialX, axial } = revolveResizeFactors(shape);
  return exactPlainSketchRevolveSolid(
    cad,
    shape.sketchProfile!,
    normalizeSketchRevolveSettings(shape.sketchRevolve),
    undefined,
    { radial: radialX, axial },
  );
}

/**
 * Where a stored revolve's axis sits in its mesh's natural frame, or null when
 * that cannot be known without sweeping it again.
 *
 * The mesh is centred on its own box, so the axis is `-revolveAxisOffset`
 * there (#503). A full turn saved before that offset was recorded is still
 * symmetric about its axis under every one of its facet rotations, so the
 * axis is the centroid of its triangles in X and Z -- which is not the box
 * centre when the facet count is not a multiple of four. A partial sweep with
 * no recorded axis has neither, and stays tessellated.
 */
function storedRevolveAxis(shape: WorkplaneShape, fullTurn: boolean): { x: number; z: number } | null {
  if (shape.revolveAxisOffset) return { x: -shape.revolveAxisOffset.x, z: -shape.revolveAxisOffset.z };
  if (!fullTurn) return null;
  const positions = shape.importedMesh?.positions ?? [];
  let volume = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(index, index + 9);
    const tetra = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    volume += tetra;
    x += tetra * (ax + bx + cx) / 4;
    z += tetra * (az + bz + cz) / 4;
  }
  return Math.abs(volume) > 1e-12 ? { x: x / volume, z: z / volume } : null;
}

/**
 * Whether any profile segment is drawn as a curve.
 *
 * The rule `sketchProfileToRevolvePolygons` samples by: a segment that is not
 * a line and has both its handles (the start point's outgoing one and the end
 * point's incoming one) is a cubic, sampled into straight pieces; anything
 * else is drawn straight. A revolve of the samples would be exact about the
 * axis but still an approximation of the drawn curve, so it is not reported
 * as exact.
 */
function profileHasCurvedSegment(profile: SketchProfile) {
  const points = new Map(profile.points.map((point) => [point.id, point]));
  return profile.segments.some((segment) => segment.kind !== "line"
    && Boolean(points.get(segment.startId)?.handleOut) && Boolean(points.get(segment.endId)?.handleIn));
}

/** Whether all Bezier control points stay on the revolve side and below its axial top. */
function curveProfileStaysOnRevolveSide(profile: SketchProfile) {
  const maxZ = Math.max(...profile.points.map((point) => point.z));
  return profile.points.every((point) => point.x <= 1e-9
    && (point.handleIn?.x ?? -Infinity) <= 1e-9
    && (point.handleOut?.x ?? -Infinity) <= 1e-9
    && (point.handleIn?.z ?? -Infinity) <= maxZ + 1e-9
    && (point.handleOut?.z ?? -Infinity) <= maxZ + 1e-9);
}

/**
 * Why a revolve stored as a mesh is not measured, cut or exported as its exact
 * solid, or null when it is.
 *
 * Wider than the edge listing's rule (`revolveWithoutExactEdges`): a partial
 * sweep is exact here too, because nothing numbers its edges.
 */
function revolveWithoutExactSolid(shape: WorkplaneShape): string | null {
  if (!isUntreatedSketchRevolve(shape)) return "not an untreated sketch revolve";
  if ((shape.importedMesh?.positions.length ?? 0) < 9) return "no stored sweep to place the solid by";
  const settings = normalizeSketchRevolveSettings(shape.sketchRevolve);
  if (settings.pitch !== 0) return "a helical revolve has only its tessellated sweep";
  if (settings.coreRadius > 0) return "a revolve fused to a core has no exact solid";
  const { radialX, radialZ } = revolveResizeFactors(shape);
  if (Math.abs(radialX - radialZ) > 1e-6 * Math.max(radialX, radialZ)) return "resized unevenly across its axis, so no revolve describes it";
  if (shapeHasTaper(shape)) return "a taper is applied to the mesh, not to a revolve";
  const fullTurn = Math.abs(Math.abs(settings.sweepAngle) - 360) <= 1e-6;
  if (!storedRevolveAxis(shape, fullTurn)) return "a partial sweep saved without its axis";
  if (profileHasCurvedSegment(shape.sketchProfile!) && !curveProfileStaysOnRevolveSide(shape.sketchProfile!)) {
    return "a curved profile crosses the revolve axis or exceeds its axial bounds, so it cannot be revolved exactly";
  }
  try {
    if (cadSketchRegions(revolveSectionProfile(shape.sketchProfile!, settings, { radial: 1, axial: 1 })).length !== 1) {
      return "the profile has several closed regions";
    }
  } catch {
    return "the profile has no closed region";
  }
  return null;
}

/**
 * Whether `placedSolidForShape` builds this shape as the exact solid of its
 * revolve rather than sewing its stored mesh, which is what measuring it
 * reports as its precision.
 */
export function hasExactRevolveSolid(shape: WorkplaneShape) {
  return revolveWithoutExactSolid(shape) === null;
}

/**
 * The angle a mesh of a result built from these shapes may turn through
 * between facets, so that it is no coarser than the finest exact revolve
 * among them, or undefined when none is one.
 *
 * Before a revolve was exact, a cut through it was made from its faceted
 * sweep, so the stored result was exactly as fine as its `sides` asked. The
 * exact result is meshed at a fixed chord height instead, which on a small
 * ring is coarser than the sweep it replaced and ignores `sides` altogether.
 * A group record is searched through, since it is cut as its members.
 *
 * Twice the sweep's facet angle, because OCCT's angular deflection bounds the
 * turn between a facet's normal and the surface's, half a facet each way: at
 * this value a full circle gets `sides` facets, the sweep's own count, and a
 * 64-sided ring cut in half meshes to the 260 triangles its sweep gave.
 */
export function exactRevolveAngularDeflection(shapes: readonly WorkplaneShape[]): number | undefined {
  let finest = 0;
  const visit = (shape: WorkplaneShape) => {
    if (hasExactRevolveSolid(shape)) {
      finest = Math.max(finest, normalizeSketchRevolveSettings(shape.sketchRevolve).sides);
    } else if (!shape.importedMesh && !shape.cadBrep) {
      shape.groupedShapes?.forEach(visit);
    }
  };
  shapes.forEach(visit);
  return finest > 0 ? (4 * Math.PI) / finest : undefined;
}

/**
 * The exact solid of a plain revolve, full turn or partial sweep, in the frame
 * its stored mesh is drawn in -- centred on the mesh's box in X and Z, base at
 * Y=0, at its drawn size -- or null when it has none (#523).
 *
 * That frame is what lets the caller place it exactly as the mesh is placed.
 * The axis comes from the stored record rather than from the solid's own box,
 * because a faceted partial sweep's box is not the exact sweep's box, and
 * centring on the wrong one moves the solid off its axis.
 */
export function exactRevolveLocalSolid(cad: OcctKernel, shape: WorkplaneShape): ShapeHandle | null {
  if (!hasExactRevolveSolid(shape)) return null;
  const settings = normalizeSketchRevolveSettings(shape.sketchRevolve);
  const axis = storedRevolveAxis(shape, Math.abs(Math.abs(settings.sweepAngle) - 360) <= 1e-6)!;
  const { radialX, radialZ, axial } = revolveResizeFactors(shape);
  const solid = revolvedSectionSolid(cad, shape.sketchProfile!, settings, { radial: radialX, axial });
  if (!cad.isValid(solid) || !cad.isSolid(solid)) throw new ServerCadError("The retained sketch revolve could not be rebuilt as exact CAD geometry.");
  return cad.translate(solid, axis.x * radialX, 0, axis.z * radialZ);
}

/**
 * The solid `GET /edges` numbers and a fillet or chamfer rounds.
 *
 * One builder for both, so an index from the listing names the same edge in
 * the treatment. For an untreated revolve that is the exact solid rebuilt from
 * its profile (#347); a revolve with no exact solid is refused rather than
 * listed or treated by its facets. Everything else is the oriented solid.
 * Both carry the shape's mirror, which the treated result no longer does.
 */
export function edgeSolidForShape(cad: OcctKernel, shape: WorkplaneShape) {
  const refusal = revolveWithoutExactEdges(shape);
  if (refusal) throw new ServerCadError(refusal);
  const revolve = exactRevolveSolidForShape(cad, shape);
  return revolve ? mirroredStoredSolid(cad, revolve, shape) : orientedSolidForShape(cad, shape);
}

/** Build the analytical full-turn BREP for chamfering a retained plain revolve. */
export function isPlainFullTurnSketchRevolve(shape: WorkplaneShape) {
  const settings = shape.sketchRevolve;
  return shape.sketchOperation === "revolve" && Boolean(shape.sketchProfile) && Boolean(settings)
    && (settings!.pitch ?? 0) === 0 && (settings!.coreRadius ?? 0) === 0
    && Math.abs(Math.abs(settings!.sweepAngle) - 360) <= 1e-6;
}

/**
 * A revolve's section as a sketch profile in the OCCT build frame, at the given
 * section scale: x is the distance from the axis and z runs up it from the
 * revolve's base, the same polygons the mesh sweep turns.
 */
function revolveSectionProfile(
  sketchProfile: SketchProfile,
  sketchRevolve: WorkplaneShape["sketchRevolve"],
  sectionScale: { radial: number; axial: number },
): SketchProfile {
  const pointById = new Map(sketchProfile.points.map((point) => [point.id, point]));
  const maxZ = Math.max(...sketchProfile.points.map((point) => point.z));
  const hasCurves = sketchProfile.segments.some((segment) => segment.kind !== "line"
    && Boolean(pointById.get(segment.startId)?.handleOut) && Boolean(pointById.get(segment.endId)?.handleIn));
  if (hasCurves && curveProfileStaysOnRevolveSide(sketchProfile)) {
    // Bezier curves stay within the convex hull of their controls. Profiles
    // wholly on the revolve side need no axis clipping and can retain the
    // exact curve that the sketch stores.
    const mapPoint = (point: { x: number; z: number }) => ({
      x: -point.x * sectionScale.radial,
      z: (maxZ - point.z) * sectionScale.axial,
    });
    return {
      ...sketchProfile,
      points: sketchProfile.points.map((point) => ({
        ...point,
        ...mapPoint(point),
        ...(point.handleIn ? { handleIn: mapPoint(point.handleIn) } : {}),
        ...(point.handleOut ? { handleOut: mapPoint(point.handleOut) } : {}),
      })),
    };
  }
  const polygons = sketchProfileToRevolvePolygons(sketchProfile, sketchRevolve);
  if (polygons.length === 0) throw new ServerCadError("The retained revolve profile has no closed region.");
  return {
    points: polygons.flatMap((polygon, polygonIndex) => polygon.map(([x, z], pointIndex) => ({
      id: `revolve-${polygonIndex}-point-${pointIndex}`,
      x: x * sectionScale.radial,
      z: z * sectionScale.axial,
    }))),
    segments: polygons.flatMap((polygon, polygonIndex) => polygon.map((_, pointIndex) => ({
      id: `revolve-${polygonIndex}-segment-${pointIndex}`,
      startId: `revolve-${polygonIndex}-point-${pointIndex}`,
      endId: `revolve-${polygonIndex}-point-${(pointIndex + 1) % polygon.length}`,
      kind: "line" as const,
    }))),
  };
}

/**
 * The exact solid of a plain revolve's one section region, turned through its
 * sweep about the Y axis, in the frame the mesh sweep builds before centring.
 *
 * Manifold sweeps from +X towards the editor's -Z and then turns the result by
 * the start angle (or, for a negative sweep, by where the sweep ends), which
 * is what a positive OCCT rotation about +Y does too, so the two agree for a
 * partial sweep as well as for a full turn.
 */
function revolvedSectionSolid(
  cad: OcctKernel,
  sketchProfile: SketchProfile,
  sketchRevolve: NonNullable<WorkplaneShape["sketchRevolve"]>,
  sectionScale: { radial: number; axial: number },
) {
  const profile = revolveSectionProfile(sketchProfile, sketchRevolve, sectionScale);
  const pathWire = (path: OrderedCadSketchPath) => cad.makeWire(path.steps.map(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const first = forward ? from.handleOut : from.handleIn;
    const second = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && first && second) {
      return cad.makeBezierEdge([
        { x: from.x, y: from.z, z: 0 }, { x: first.x, y: first.z, z: 0 },
        { x: second.x, y: second.z, z: 0 }, { x: to.x, y: to.z, z: 0 },
      ]);
    }
    return cad.makeLineEdge({ x: from.x, y: from.z, z: 0 }, { x: to.x, y: to.z, z: 0 });
  }));
  const regions = cadSketchRegions(profile);
  if (regions.length !== 1) {
    throw new ServerCadError("Exact revolve geometry requires one closed profile region, and this revolve's profile has several.");
  }
  const axis = { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
  const region = regions[0]!;
  let face = cad.makeFace(pathWire(region.outer));
  if (region.holes.length) face = cad.addHolesInFace(face, region.holes.map(pathWire));
  const sweep = Math.abs(sketchRevolve.sweepAngle);
  const solid = cad.revolve(face, axis, Math.abs(sweep - 360) <= 1e-6 ? Math.PI * 2 : (sweep * Math.PI) / 180);
  const rotation = sketchRevolve.sweepAngle < 0 ? sketchRevolve.startAngle + sketchRevolve.sweepAngle : sketchRevolve.startAngle;
  return Math.abs(rotation) < 1e-8 ? solid : cad.rotate(solid, axis, (rotation * Math.PI) / 180);
}

/** Build the analytical BREP for a plain, single-region full-turn revolve. */
export function exactPlainSketchRevolveSolid(
  cad: OcctKernel,
  sketchProfile: SketchProfile,
  sketchRevolve: WorkplaneShape["sketchRevolve"],
  targetShape?: WorkplaneShape,
  sectionScale: { radial: number; axial: number } = { radial: 1, axial: 1 },
) {
  if (!sketchRevolve || (sketchRevolve.pitch ?? 0) !== 0 || (sketchRevolve.coreRadius ?? 0) !== 0
    || Math.abs(Math.abs(sketchRevolve.sweepAngle) - 360) > 1e-6) {
    throw new ServerCadError("Exact revolve geometry requires a plain full-turn sketch revolve.");
  }
  // A full turn starts where its start angle says, whichever way it is swept.
  let solid = revolvedSectionSolid(cad, sketchProfile, { ...sketchRevolve, sweepAngle: 360 }, sectionScale);
  // Callers that cannot express a resized revolve analytically (for example,
  // exact face listing of a radially elliptical legacy shape) use this bounds
  // fit. Face drafting of a supported resize passes profile scales instead.
  if (targetShape?.importedMesh && targetShape.width > 0 && targetShape.depth > 0 && targetShape.height > 0) {
    const bounds = cad.getBoundingBox(solid, false);
    const sx = targetShape.width / Math.max(bounds.xmax - bounds.xmin, 1e-9);
    const sy = targetShape.height / Math.max(bounds.ymax - bounds.ymin, 1e-9);
    const sz = targetShape.depth / Math.max(bounds.zmax - bounds.zmin, 1e-9);
    solid = cad.transform(solid, [
      sx, 0, 0, -(bounds.xmin + bounds.xmax) * sx / 2,
      0, sy, 0, -bounds.ymin * sy,
      0, 0, sz, -(bounds.zmin + bounds.zmax) * sz / 2,
    ]);
  }
  if (!cad.isValid(solid) || !cad.isSolid(solid)) throw new ServerCadError("The retained sketch revolve could not be rebuilt as exact CAD geometry.");
  return solid;
}

/** Rebuild the exact CAD representation of an eligible retained revolve. */
export function exactPlainSketchRevolveResult(shape: WorkplaneShape): Promise<ServerCadResult> {
  if (!shape.sketchProfile || !isPlainFullTurnSketchRevolve(shape)) {
    return Promise.reject(new ServerCadError("Exact revolve geometry requires a plain full-turn retained sketch revolve."));
  }
  return withCadKernel((cad) => {
    // The same solid a treatment of this shape starts from, so the untreated
    // exact result and a treated one are the same geometry before the blend.
    // A revolve stretched unevenly across its axis has no such solid; it keeps
    // the bounds-fitted rebuild this function has always returned.
    const solid = exactRevolveSolidForShape(cad, { ...shape, cadBrep: undefined, faceDraft: undefined })
      ?? exactPlainSketchRevolveSolid(cad, shape.sketchProfile!, shape.sketchRevolve, shape);
    return { ...meshedCadResult(cad, solid), faceIds: freshFaceIds(cad, solid, shape.id) };
  });
}

/**
 * Apply a prism draft along the shape's vertical extrusion axis.
 *
 * The geometry only: the caller records the retained angle and source frame
 * (`retainedPrismDraftFields`) that a sketch edit replays it from. The B-rep
 * is built about the centre of the profile's bounds
 * (`draftPrismProfileOffset`), and the exact BREP and viewport mesh are
 * persisted together, as with shell and edge treatments.
 */
export function applyDraftPrism(shape: WorkplaneShape, request: { angle: number }): Promise<ServerCadResult> {
  if (!Number.isFinite(request.angle) || request.angle === 0 || Math.abs(request.angle) >= 45) {
    return Promise.reject(new ServerCadError("The draft angle must be non-zero and between -45 and 45 degrees.", 400));
  }
  if (shape.sketchOperation !== "extrude" || !shape.sketchProfile) {
    return Promise.reject(new ServerCadError("Draft prism requires a sketch extrusion with its source profile retained.", 400));
  }
  const scale = sketchResizeFactors(shape);
  const profile = scaledSketchProfile(shape.sketchProfile, scale.width, scale.depth);
  const loop = draftPrismLoop(profile);
  if (typeof loop === "string") return Promise.reject(new ServerCadError(loop, 400));

  return withCadKernel((cad) => {
    const { x: centerX, z: centerZ } = draftPrismProfileOffset(profile);
    const edges = loop.map((point, index) => {
      const next = loop[(index + 1) % loop.length];
      return cad.makeLineEdge(
        { x: point.x - centerX, y: 0, z: point.z - centerZ },
        { x: next.x - centerX, y: 0, z: next.z - centerZ },
      );
    });
    const face = cad.makeFace(cad.makeWire(edges));
    let drafted: ShapeHandle;
    try {
      drafted = cad.draftPrism(face, 0, shape.height, 0, request.angle);
    } catch {
      throw new ServerCadError("The shape cannot be drafted along its vertical extrusion axis.");
    }
    const solids = cad.getSubShapes(drafted, "solid");
    const result = solids.length === 1 ? solids[0] : drafted;
    if (!cadResultIsValid(cad, result) || !cad.isSolid(result)) {
      throw new ServerCadError("The draft did not produce a valid solid.");
    }
    const meshed = meshedCadResult(cad, result);
    return { ...meshed, faceIds: freshFaceIds(cad, result, shape.id) };
  });
}

/** Apply one face draft to a retained exact sketch extrusion or sweep using the current stable face ID. */
export function applySketchFaceDraft(shape: WorkplaneShape, request: SketchFaceDraftRequest): Promise<ServerCadResult> {
  if (!Number.isFinite(request.angle) || request.angle === 0 || Math.abs(request.angle) >= 45) {
    return Promise.reject(new ServerCadError("The face draft angle must be non-zero and between -45 and 45 degrees.", 400));
  }
  const exactRevolve = isPlainFullTurnSketchRevolve(shape);
  if (exactRevolve) {
    const resize = revolveResizeFactors(shape);
    if (Math.abs(resize.radialX - resize.radialZ) > 1e-6 * Math.max(resize.radialX, resize.radialZ)) {
      return Promise.reject(new ServerCadError(
        "Face drafting requires an equal resize across the revolve's radial axes; unequal radial resizing makes an elliptical shape that cannot be drafted exactly.",
        400,
      ));
    }
  }
  if ((!exactRevolve && shape.sketchOperation !== "extrude" && shape.sketchOperation !== "sweep")
    || !shape.sketchProfile || (!shape.cadBrep && !exactRevolve)) {
    return Promise.reject(new ServerCadError("Face drafts require an exact retained sketch extrusion, sweep, or plain full-turn revolve.", 400));
  }
  return withCadKernel((cad) => {
    let solid: ShapeHandle;
    if (exactRevolve) {
      const resize = revolveResizeFactors(shape);
      const hasResize = [resize.radialX, resize.radialZ, resize.axial]
        .some((factor) => Math.abs(factor - 1) > 1e-8);
      solid = hasResize
        ? exactPlainSketchRevolveSolid(cad, shape.sketchProfile!, shape.sketchRevolve, undefined, {
          radial: resize.radialX,
          axial: resize.axial,
        })
        : exactPlainSketchRevolveSolid(cad, shape.sketchProfile!, shape.sketchRevolve, shape);
    } else {
      solid = solidFromBrep(cad, shape.cadBrep!);
    }
    const resize = sketchResizeFactors(shape);
    if (!exactRevolve && shape.sketchOperation === "extrude" && isResized(resize)) {
      solid = sketchExtrusionSolid(cad, scaledSketchProfile(shape.sketchProfile!, resize.width, resize.depth), shape.height);
      if (!cadResultIsValid(cad, solid) || !cad.isSolid(solid)) {
        throw new ServerCadError("The resized sketch extrusion could not be rebuilt as exact CAD geometry.");
      }
    }
    const faces = cad.getSubShapes(solid, "face");
    const ids = shape.faceIds?.length === faces.length ? shape.faceIds
      : exactRevolve ? faces.map((_, index) => `face_${encodeURIComponent(shape.id)}_${index}`)
        : undefined;
    if (!ids || ids.length !== faces.length || new Set(ids).size !== faces.length) {
      throw new ServerCadError("Face drafting requires a complete, unique stable face ID list.");
    }
    const selected = ids.flatMap((id, index) => id === request.sourceFaceId ? [index] : []);
    if (selected.length !== 1) throw new ServerCadError("The selected source face is no longer available.");
    const face = faces[selected[0]!];
    if (!face) throw new ServerCadError("The selected source face is no longer available.");

    const drafted = draftSketchFace(cad, solid, face, request);
    if (!drafted) throw new ServerCadError("The selected source face cannot be drafted along that local pull axis and angle.");
    if (!cadResultIsValid(cad, drafted) || !cad.isSolid(drafted)) {
      throw new ServerCadError("The face draft did not produce a valid solid.");
    }
    return meshedCadResult(cad, drafted, shape, undefined, solid);
  });
}

/** The exact geometry and a mesh of it, which is what a shape stores after any CAD operation. */
export function meshedCadResult(
  cad: OcctKernel,
  result: ShapeHandle,
  sourceShape?: WorkplaneShape,
  lineage?: { sourceFaceHashes: number[]; evolution: EvolutionData },
  sourceSolid?: ShapeHandle,
  angularDeflection?: number,
): ServerCadResult {
  const mesh = cad.meshShape(result, angularDeflection
    ? { linearDeflection: MESH_DEFLECTION, angularDeflection }
    : { linearDeflection: MESH_DEFLECTION });
  // The editor stores a flat triangle list, not an indexed mesh, so the
  // indices are expanded here rather than carried.
  const positions: number[] = [];
  const normals: number[] = [];
  for (const vertex of mesh.indices) {
    const offset = vertex * 3;
    positions.push(mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]);
    normals.push(mesh.normals[offset], mesh.normals[offset + 1], mesh.normals[offset + 2]);
  }
  const faces = cad.getSubShapes(result, "face");
  const faceIndexByHash = new Map(faces.map((face, index) => [cad.hashCode(face, 2_147_483_647), index]));
  const faceGroups = triangleFaceGroups(mesh.faceGroups, faceIndexByHash);
  const faceIds = sourceShape
    ? lineage
      ? faceIdsFromEvolution(
        sourceShape.id,
        sourceShape.faceIds,
        lineage.sourceFaceHashes,
        faces.map((face) => cad.hashCode(face, FACE_HASH_UPPER_BOUND)),
        lineage.evolution,
      )
      : faceIdsForResult(cad, sourceShape, faces, sourceSolid)
    : undefined;
  return {
    brep: cad.toBREP(result),
    positions,
    normals: normals.length === positions.length ? normals : null,
    triangleCount: mesh.triangleCount,
    ...(faceIds ? { faceIds } : {}),
    ...(faceGroups.length ? { faceGroups } : {}),
  };
}

function faceIdsForResult(
  cad: OcctKernel,
  source: WorkplaneShape,
  resultFaces: ShapeHandle[],
  sourceSolid = orientedSolidForShape(cad, source),
): string[] {
  return faceIdsForCadResult(cad, source, resultFaces, sourceSolid);
}

function freshFaceIds(cad: OcctKernel, solid: ShapeHandle, shapeId: string): string[] {
  return cad.getSubShapes(solid, "face").map((_, index) => `face_${createLocalId(`${shapeId}-face-${index}`)}`);
}


/**
 * The shape as it stands after a treatment.
 *
 * Mirrors what the editor stores for a CAD result: the shape becomes a mesh
 * carrying the triangles to draw, with the exact geometry alongside it in
 * `cadBrep` for STEP export and for the next treatment to build on. Positions
 * are centred in X and Z and measured from the bottom in Y, which is the frame
 * the viewport expects -- so the shape keeps its place on the workplane.
 */
export function shapeWithCadResult(shape: WorkplaneShape, result: ServerCadResult): WorkplaneShape {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < result.positions.length; index += 3) {
    minX = Math.min(minX, result.positions[index]);
    minY = Math.min(minY, result.positions[index + 1]);
    minZ = Math.min(minZ, result.positions[index + 2]);
    maxX = Math.max(maxX, result.positions[index]);
    maxY = Math.max(maxY, result.positions[index + 1]);
    maxZ = Math.max(maxZ, result.positions[index + 2]);
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    throw new ServerCadError("The treated shape produced no usable geometry.");
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const width = Math.max(MIN_CAD_DIMENSION, maxX - minX);
  const height = Math.max(MIN_CAD_DIMENSION, maxY - minY);
  const depth = Math.max(MIN_CAD_DIMENSION, maxZ - minZ);
  const positions: number[] = [];
  for (let index = 0; index < result.positions.length; index += 3) {
    positions.push(
      result.positions[index] - centerX,
      result.positions[index + 1] - minY,
      result.positions[index + 2] - centerZ,
    );
  }

  // A result built from exact geometry already carries the shape's rotation, so
  // keeping it would turn the solid twice. One rebuilt from a stored mesh does
  // not, so its rotation has to stay.
  const bakedRotation = treatmentBakesRotation(shape);
  const survivingColors = Object.fromEntries(Object.entries(shape.faceColors ?? []).flatMap(([key, color]) => {
    const id = /^\d+$/.test(key)
      ? shape.faceIds?.[Number(key)] ?? `face_${encodeURIComponent(shape.id)}_${Number(key)}`
      : key;
    return result.faceIds?.includes(id) ? [[id, color] as const] : [];
  }));
  return canonicalizeShape({
    ...shape,
    // A baked rotation can move the bounds away from the source's pivot. The
    // mesh is rebased to those bounds, so move its project origin by the same
    // offset. Other results keep the source frame they were built in.
    x: shape.x + (bakedRotation ? centerX : 0),
    z: shape.z + (bakedRotation ? centerZ : 0),
    elevation: (shape.elevation ?? 0) + (bakedRotation ? minY : 0),
    faceIds: result.faceIds,
    faceColors: Object.keys(survivingColors).length ? survivingColors : undefined,
    kind: "mesh",
    width,
    depth,
    height,
    size: Math.max(width, depth),
    // The treated geometry is already in its final form; carrying a taper
    // forward would apply it to the result a second time.
    rotation: bakedRotation ? 0 : shape.rotation,
    rotationX: bakedRotation ? 0 : shape.rotationX,
    rotationZ: bakedRotation ? 0 : shape.rotationZ,
    mirrorX: undefined,
    mirrorY: undefined,
    mirrorZ: undefined,
    radius: undefined,
    taperTopWidth: undefined,
    taperTopDepth: undefined,
    taperBottomWidth: undefined,
    taperBottomDepth: undefined,
    taperTopScale: undefined,
    taperBottomScale: undefined,
    sides: undefined,
    importedMesh: {
      positions,
      normals: result.normals?.length === positions.length ? result.normals : undefined,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: result.triangleCount,
      sourceFormat: "json",
      ...(result.faceGroups ? { faceGroups: result.faceGroups } : {}),
    },
    cadBrep: result.brep,
    // The frame says where the stored B-Rep *is*, not where the shape is.
    //
    // Both readers -- STEP export and the editor's own CAD worker, through
    // `cadBrepTransformForShape` -- place the geometry by subtracting this
    // frame's centre and adding the shape's current one. So a frame carrying
    // the shape's placement, for geometry that is actually in the local frame
    // every builder here produces, cancels the placement out: a filleted,
    // chamfered or hollowed shape at x=25, z=-15, elevation=7 exported to STEP
    // at the origin instead. Nothing caught it because a shape left where it
    // was created -- which is where a test shape sits -- subtracts zero.
    //
    // These are the result's own bounds, which is what the editor's worker
    // records for exactly the same reason, and what both cut writers now
    // record for a cut's recentred B-rep (#548).
    cadBrepFrame: { x: centerX, z: centerZ, elevation: minY, width, depth, height },
    cadPrimitiveFrame: undefined,
    cadDisplayEdges: undefined,
    cadDisplayEdgesVersion: undefined,
  });
}
