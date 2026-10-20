import type { WorkplaneShape } from "./domain/sketchforge.js";
import { withCadKernel } from "./serverCadKernel.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import { worldMeshForShape } from "./serverShapeGroups.js";
import type { MeshData } from "./meshTransform.js";

/** Build world-space triangle meshes for exports and headless scene checks. */
export async function meshProjectShapes(shapes: readonly WorkplaneShape[]): Promise<MeshData[]> {
  const visible = shapes.filter((shape) => !shape.hidden && !shape.hole);
  const built = new Map<WorkplaneShape, MeshData>();
  const analytic: WorkplaneShape[] = [];
  for (const shape of visible) {
    const stored = worldMeshForShape(shape);
    if (stored) built.set(shape, stored);
    else analytic.push(shape);
  }
  if (analytic.length) await withCadKernel((cad) => {
    for (const shape of analytic) {
    const solid = placedSolidForShape(cad, shape);
    const tessellation = cad.tessellate(solid);
    const vertices: [number, number, number][] = [];
    for (let index = 0; index + 2 < tessellation.positions.length; index += 3) {
      vertices.push([tessellation.positions[index], tessellation.positions[index + 1], tessellation.positions[index + 2]]);
    }
    const indices = tessellation.indices;
    const faces: [number, number, number][] = [];
    for (let index = 0; index + 2 < indices.length; index += 3) {
      faces.push([indices[index], indices[index + 1], indices[index + 2]]);
    }
      built.set(shape, { name: shape.name, vertices, faces });
    }
  });
  return visible.flatMap((shape) => {
    const mesh = built.get(shape);
    return mesh ? [mesh] : [];
  });
}
