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
 * editor from one filleted there.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { withCadKernel } from "@/lib/serverCadKernel";
import { exactSolidForShape, shapeIsTurned, UnbuildableShapeError } from "@/lib/serverCadSolids";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export type ServerCadEdge = {
  index: number;
  length: number;
  curveType: string;
  midpoint: { x: number; y: number; z: number };
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

function solidFromMesh(cad: OcctKernel, positions: number[]) {
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
  throw new ServerCadError("That shape's mesh is not a closed solid, so it cannot be filleted.");
}

/**
 * Whether a treated result should keep the shape's rotation or has it baked in.
 *
 * Exact geometry is built turned the way the shape sits, so the result must not
 * be turned again. Stored geometry -- a previous result's BREP, an imported
 * mesh -- is already in the frame the shape's own rotation applies to.
 */
export function treatmentBakesRotation(shape: WorkplaneShape) {
  if (shape.cadBrep || meshPositionsOf(shape)) return false;
  return shapeIsTurned(shape);
}

/**
 * The shape as an exact solid.
 *
 * A parametric shape is rebuilt from its dimensions rather than its mesh, so
 * its fillet is exact rather than a rounded approximation of a tessellation.
 */
function solidForShape(cad: OcctKernel, shape: WorkplaneShape) {
  if (shape.cadBrep) return solidFromBrep(cad, shape.cadBrep);

  const positions = meshPositionsOf(shape);
  if (positions) return solidFromMesh(cad, [...positions]);

  try {
    return exactSolidForShape(cad, shape);
  } catch (error) {
    if (error instanceof UnbuildableShapeError) throw new ServerCadError(error.message);
    throw error;
  }
}

function edgeSummary(cad: OcctKernel, handle: ShapeHandle, index: number): ServerCadEdge {
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
  };
}

/** The edges of a shape, in the order a treatment request refers to them by index. */
export function shapeEdges(shape: WorkplaneShape): Promise<ServerCadEdge[]> {
  return withCadKernel((cad) => {
    const solid = solidForShape(cad, shape);
    return cad.getSubShapes(solid, "edge").map((handle, index) => edgeSummary(cad, handle, index));
  });
}

export type ServerCadResult = {
  brep: string;
  positions: number[];
  normals: number[] | null;
  triangleCount: number;
};

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
    const solid = solidForShape(cad, shape);
    const allEdges = cad.getSubShapes(solid, "edge");
    const requested = treatment.edges;
    if (requested?.some((index) => !Number.isInteger(index) || index < 0 || index >= allEdges.length)) {
      throw new ServerCadError(`Edge indexes must be between 0 and ${allEdges.length - 1}.`, 400);
    }
    const edges = requested && requested.length > 0 ? requested.map((index) => allEdges[index]) : allEdges;
    if (edges.length === 0) throw new ServerCadError("That shape has no edges to treat.");

    let treated: ShapeHandle;
    try {
      if (treatment.kind === "fillet") {
        treated = cad.fillet(solid, edges, treatment.amount);
      } else if (treatment.angle === undefined || Math.abs(treatment.angle - 45) < 0.001) {
        treated = cad.chamfer(solid, edges, treatment.amount);
      } else {
        treated = cad.chamferDistAngle(solid, edges, treatment.amount, treatment.angle);
      }
    } catch (error) {
      // OCCT fails when the radius does not fit the geometry, which is the
      // common mistake: too large a radius for a thin wall or a short edge.
      throw new ServerCadError(
        treatment.kind === "fillet"
          ? "That radius is too large for this shape's edges. Try a smaller one."
          : "That chamfer is too large for this shape's edges. Try a smaller one.",
      );
    }
    // Both fillet and chamfer hand back a compound wrapping the result, and
    // OCCT refuses a compound as the input to another treatment -- so storing
    // that as the shape's exact geometry would make the next fillet fail for
    // no visible reason. Unwrap the single solid inside it.
    const treatedSolids = cad.getSubShapes(treated, "solid");
    const result = treatedSolids.length === 1 ? treatedSolids[0] : treated;

    const mesh = cad.meshShape(result, { linearDeflection: MESH_DEFLECTION });
    // The editor stores a flat triangle list, not an indexed mesh, so the
    // indices are expanded here rather than carried.
    const positions: number[] = [];
    const normals: number[] = [];
    for (const vertex of mesh.indices) {
      const offset = vertex * 3;
      positions.push(mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]);
      normals.push(mesh.normals[offset], mesh.normals[offset + 1], mesh.normals[offset + 2]);
    }
    return {
      brep: cad.toBREP(result),
      positions,
      normals: normals.length === positions.length ? normals : null,
      triangleCount: mesh.triangleCount,
    };
  });
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
  return canonicalizeShape({
    ...shape,
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
    },
    cadBrep: result.brep,
    cadBrepFrame: { x: shape.x, z: shape.z, elevation: shape.elevation ?? 0, width, depth, height },
    cadPrimitiveFrame: undefined,
    cadDisplayEdges: undefined,
    cadDisplayEdgesVersion: undefined,
  });
}
