/** Exact mass properties from the shape's positioned CAD solid. */

import { withCadKernel } from "./serverCadKernel.js";
import { isGroupRecord, placedSolidForShape } from "./serverShapeBooleans.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type ShapeGeometryProvenance = {
  /** Which stored representation supplied the solid to the kernel. */
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
  isValid: boolean;
  provenance: ShapeGeometryProvenance;
};

function geometryProvenance(shape: WorkplaneShape): ShapeGeometryProvenance {
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
