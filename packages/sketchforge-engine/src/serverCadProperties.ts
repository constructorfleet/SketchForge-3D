/**
 * Mass properties of one shape where it stands in the project.
 *
 * An exact shape is measured on its positioned CAD solid. A mesh-sourced shape
 * is measured on its placed triangles directly (#508): sewing them into a solid
 * first cost over a minute on a large STL, held the single kernel the whole
 * time, and could not improve on a result that is tessellated either way.
 */

import { recoverLegacyRevolveShape } from "./serverRevolveRecovery.js";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { withCadKernel } from "./serverCadKernel.js";
import { hasCurrentResultBrep, placedResultBrepSolid, placedSolid, type ShapeGeometryProvenance } from "./serverShapeBooleans.js";
import { worldMeshForShape } from "./serverShapeGroups.js";
import { meshMassProperties, meshDataFromPositions } from "./meshMassProperties.js";
import { MeshShellsOverlapError } from "./meshShellOverlap.js";
import { restoreGroupedChildren } from "./serverShapeGroups.js";
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

/**
 * Flatten a record-only group of mesh children into one placed triangle mesh.
 * A nested group is restored before descending so each child's stored frame
 * and placement are composed exactly as they are when the group is ungrouped.
 * Hole members and mixed exact/mesh groups stay on the existing OCCT path.
 */
function meshForRecordOnlyGroup(shape: WorkplaneShape) {
  if (!shape.groupedShapes?.length || shape.importedMesh || shape.hole || shape.hidden) return null;
  const positions: number[] = [];
  const visit = (group: WorkplaneShape): boolean => {
    for (const child of restoreGroupedChildren(group)) {
      if (child.hidden) continue;
      if (child.groupedShapes?.length && !child.importedMesh) {
        if (!visit(child)) return false;
        continue;
      }
      if (!child.importedMesh || child.hole || child.cadBrep || hasExactRevolveSolid(child)) return false;
      const mesh = worldMeshForShape(child);
      if (!mesh) return false;
      for (const face of mesh.faces) {
        for (const index of face) {
          const vertex = mesh.vertices[index];
          if (!vertex) return false;
          positions.push(vertex[0], vertex[1], vertex[2]);
        }
      }
    }
    return true;
  };
  return visit(shape) && positions.length >= 9 ? meshDataFromPositions(positions) : null;
}

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
  shape = await recoverLegacyRevolveShape(shape);
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
  const mesh = hasExactRevolveSolid(shape)
    ? null
    : worldMeshForShape(shape) ?? meshForRecordOnlyGroup(shape);
  // A mesh that does not close at any weld tolerance has no volume to report:
  // the kernel's sewing gets the last word, and refuses it as it always has.
  // Bodies overlapping without nesting are refused here, as the exact path
  // refuses them, rather than sewn only for the kernel to refuse them (#529).
  let fromMesh;
  try {
    fromMesh = mesh ? meshMassProperties(mesh) : null;
  } catch (error) {
    // A record-only group is an assembly that OCCT fuses. When sibling meshes
    // overlap, let that exact union path handle them instead of adding their
    // overlapping triangles or returning the single-mesh overlap refusal.
    if (error instanceof MeshShellsOverlapError && shape.groupedShapes?.length && !shape.importedMesh) {
      fromMesh = null;
    } else {
      throw asServerCadError(error);
    }
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
