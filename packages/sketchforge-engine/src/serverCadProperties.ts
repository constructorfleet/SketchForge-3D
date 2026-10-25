/**
 * Mass properties of one shape where it stands in the project.
 *
 * An exact shape is measured on its positioned CAD solid. A mesh-sourced shape
 * is measured on its placed triangles directly (#508): sewing them into a solid
 * first cost over a minute on a large STL, held the single kernel the whole
 * time, and could not improve on a result that is tessellated either way.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { withCadKernel } from "./serverCadKernel.js";
import { hasCurrentResultBrep, placedResultBrepSolid, placedSolid, type ShapeGeometryProvenance } from "./serverShapeBooleans.js";
import { worldMeshForShape } from "./serverShapeGroups.js";
import { meshMassProperties } from "./meshMassProperties.js";
import { asServerCadError, hasExactRevolveSolid } from "./serverCadOperations.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type { ShapeGeometryProvenance };

export type ServerCadShapeProperties = {
  /** Volume in mm^3. */
  volume: number;
  /** Surface area in mm^2. */
  area: number;
  /** Center of mass in project coordinates, in mm. */
  centerOfMass: { x: number; y: number; z: number };
  /** Axis-aligned bounds in project coordinates, in mm. */
  bbox: { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number };
  /**
   * The kernel's validity check. A mesh measured from its triangles is always
   * valid: one that is not closed is sent to the kernel instead.
   */
  isValid: boolean;
  provenance: ShapeGeometryProvenance;
};

const MESH_PROVENANCE: ShapeGeometryProvenance = { source: "mesh", precision: "tessellated" };

function measuredSolid(cad: OcctKernel, solid: ShapeHandle, provenance: ShapeGeometryProvenance): ServerCadShapeProperties {
  const query = cad.queryBatch([solid])[0];
  if (!query) throw new Error("The CAD kernel returned no shape properties.");
  return {
    volume: query.volume,
    area: query.area,
    centerOfMass: query.centerOfMass,
    bbox: query.bbox,
    isValid: query.isValid,
    provenance,
  };
}

/** Measure one shape using the same project-space solid the engine's CAD tools use. */
export async function shapeProperties(shape: WorkplaneShape): Promise<ServerCadShapeProperties> {
  // A boolean result is measured on its exact B-rep while that still agrees
  // with its mesh (#541), and falls through to the mesh when it does not.
  if (hasCurrentResultBrep(shape)) {
    const exact = await withCadKernel((cad) => {
      const solid = placedResultBrepSolid(cad, shape);
      return solid ? measuredSolid(cad, solid, { source: "brep", precision: "exact" }) : null;
    });
    if (exact) return exact;
  }
  // The same placed triangles placedSolidForShape would sew, measured as they are.
  const mesh = hasExactRevolveSolid(shape) ? null : worldMeshForShape(shape);
  // A mesh that does not close at any weld tolerance has no volume to report:
  // the kernel's sewing gets the last word, and refuses it as it always has.
  // Bodies overlapping without nesting are refused here, as the exact path
  // refuses them, rather than sewn only for the kernel to refuse them (#529).
  let fromMesh;
  try {
    fromMesh = mesh ? meshMassProperties(mesh) : null;
  } catch (error) {
    throw asServerCadError(error);
  }
  // Measured from the triangles, so tessellated, whatever else the shape
  // carries: a result whose B-rep did not match its mesh lands here too.
  if (fromMesh) return { ...fromMesh, isValid: true, provenance: MESH_PROVENANCE };
  // The provenance comes from the build itself: a revolve is its profile, a
  // mesh that did not close is sewn and still triangles, and a group record is
  // only as exact as the members it actually fused -- a cut inside it that was
  // resized with the group, or whose B-rep failed its check, is sewn from its
  // mesh and makes the record tessellated.
  return withCadKernel((cad) => {
    const { solid, provenance } = placedSolid(cad, shape);
    return measuredSolid(cad, solid, provenance);
  });
}
