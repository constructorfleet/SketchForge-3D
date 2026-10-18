/**
 * How the REST API describes a shape (upstream issue #55).
 *
 * Deliberately the same field names the API accepts when creating one, so a
 * script can read a shape, change a number, and send it back.
 */

import type { WorkplaneShape } from "@/types/sketchforge";

export function apiShapeSummary(shape: WorkplaneShape) {
  return {
    id: shape.id,
    name: shape.name,
    kind: shape.kind,
    color: shape.color,
    hole: Boolean(shape.hole),
    locked: Boolean(shape.locked),
    hidden: Boolean(shape.hidden),
    x: shape.x,
    z: shape.z,
    elevation: shape.elevation ?? 0,
    width: shape.width ?? shape.size ?? 0,
    depth: shape.depth ?? shape.size ?? 0,
    height: shape.height,
    rotation: shape.rotation,
    rotationX: shape.rotationX ?? 0,
    rotationZ: shape.rotationZ ?? 0,
    ...(shape.sides === undefined ? {} : { sides: shape.sides }),
    ...(shape.text === undefined ? {} : { text: shape.text }),
    ...(shape.groupedShapes ? { groupedCount: shape.groupedShapes.length } : {}),
  };
}
