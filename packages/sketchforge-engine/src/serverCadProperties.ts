/**
 * Mass properties of one shape where it stands in the project.
 *
 * An exact shape is measured on its positioned CAD solid. A mesh-sourced shape
 * is measured on its placed triangles directly (#508): sewing them into a solid
 * first cost over a minute on a large STL, held the single kernel the whole
 * time, and could not improve on a result that is tessellated either way.
 */

import { withCadKernel } from "./serverCadKernel.js";
import { isGroupRecord, placedSolidForShape } from "./serverShapeBooleans.js";
import { worldMeshForShape } from "./serverShapeGroups.js";
import { meshMassProperties } from "./meshMassProperties.js";
import { asServerCadError, hasExactRevolveSolid } from "./serverCadOperations.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type ShapeGeometryProvenance = {
  /** Which stored representation supplied the geometry that was measured. */
  source: "parametric" | "brep" | "mesh";
  /** Imported triangle meshes remain tessellated even after sewing into a solid. */
  precision: "exact" | "tessellated";
};

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

function geometryProvenance(shape: WorkplaneShape): ShapeGeometryProvenance {
  // A plain revolve is measured on the exact solid of its profile, not on the
  // sweep's mesh it is stored as (#523).
  if (hasExactRevolveSolid(shape)) return { source: "parametric", precision: "exact" };
  // placedSolidForShape uses an imported mesh when one is present, including
  // when it also carries source STEP text. Report the geometry actually used.
  if (shape.importedMesh?.positions && shape.importedMesh.positions.length >= 9) {
    return { source: "mesh", precision: "tessellated" };
  }
  // A group record is measured as its children fused, so it is only as exact
  // as the least exact of them. A hidden member is left out of the fuse, so
  // it is left out here too.
  if (isGroupRecord(shape)) {
    const children = (shape.groupedShapes ?? []).filter((child) => !child.hidden).map(geometryProvenance);
    return children.find((child) => child.source === "mesh")
      ?? children.find((child) => child.source === "brep")
      ?? { source: "parametric", precision: "exact" };
  }
  return shape.cadBrep
    ? { source: "brep", precision: "exact" }
    : { source: "parametric", precision: "exact" };
}

/** Measure one shape using the same project-space solid the engine's CAD tools use. */
export function shapeProperties(shape: WorkplaneShape): Promise<ServerCadShapeProperties> {
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
    return Promise.reject(asServerCadError(error));
  }
  if (fromMesh) return Promise.resolve({ ...fromMesh, isValid: true, provenance: geometryProvenance(shape) });
  return withCadKernel((cad) => {
    const solid = placedSolidForShape(cad, shape);
    const query = cad.queryBatch([solid])[0];
    if (!query) throw new Error("The CAD kernel returned no shape properties.");
    return {
      volume: query.volume,
      area: query.area,
      centerOfMass: query.centerOfMass,
      bbox: query.bbox,
      isValid: query.isValid,
      provenance: geometryProvenance(shape),
    };
  });
}
