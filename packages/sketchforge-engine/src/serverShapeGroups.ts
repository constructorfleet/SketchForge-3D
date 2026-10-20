/**
 * Grouping, ungrouping and separating stored shapes (upstream issue #55).
 *
 * The app's grouping model is a record, not an operation: a group is one shape
 * carrying its children in `groupedShapes`, each child's placement held
 * relative to the group's own box, and ungrouping puts them back by undoing
 * that. Because the record is what the editor reads, a project grouped here
 * opens there unchanged and ungroups to the children it started with.
 *
 * The editor's own grouping lives inside its viewport component and asks the
 * browser mesher where every shape sits. There is no mesher on the server, so
 * the placement maths is reproduced here from what a project stores -- the same
 * trade `serverCadOperations` makes with the CAD worker, and for the same
 * reason: prising the editor's copy apart would conflict with every upstream
 * change to it.
 */

import * as THREE from "three";
import { createLocalId } from "./localIds.js";
import { transformMesh, type MeshData, type Vec3 } from "./meshTransform.js";
import {
  canonicalizeShape,
  cleanNearZero,
  cleanRotationDegrees,
  meshYawDegrees,
  mirrorSign,
  resizedImportedMeshPositions,
  shapeDepth,
  shapeOverallFootprintDimensions,
  shapeWidth,
  withHoleMode,
} from "./workplaneShapes.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type ShapeBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

const MIN_SHAPE_DIMENSION = 0.01;
const MODEL_DIMENSION_PRECISION = 3;
/** How close two triangle corners must be to count as the same vertex when splitting parts. */
const SEPARATE_PARTS_VERTEX_TOLERANCE = 0.0005;

function cleanModelDimension(value: number) {
  return Math.max(MIN_SHAPE_DIMENSION, Number(value.toFixed(MODEL_DIMENSION_PRECISION)));
}

function degrees(value: number | undefined) {
  return THREE.MathUtils.degToRad(value ?? 0);
}

/**
 * The matrix that puts a shape's local geometry where the shape sits.
 *
 * Mirror, then rotate, then translate, with the local frame's base at Y=0 and
 * its middle at the origin in X and Z. That is the frame every builder in the
 * app produces and the order `transformMesh` applies, so exact geometry built
 * on the server lands exactly where the editor draws the same shape.
 */
export function shapePlacementMatrix(shape: WorkplaneShape) {
  const centerY = shape.height / 2;
  return new THREE.Matrix4()
    .makeTranslation(shape.x, (shape.elevation ?? 0) + centerY, shape.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      degrees(shape.rotationX),
      degrees(meshYawDegrees(shape)),
      degrees(shape.rotationZ),
      "XYZ",
    )))
    .multiply(new THREE.Matrix4().makeScale(mirrorSign(shape.mirrorX), mirrorSign(shape.mirrorY), mirrorSign(shape.mirrorZ)))
    .multiply(new THREE.Matrix4().makeTranslation(0, -centerY, 0));
}

/**
 * A shape's box in world space.
 *
 * The editor measures this from the shape's mesh. Here it is the shape's own
 * footprint box put through the same placement: identical for anything
 * square-sided, and a shade generous for a turned curved shape, which leaves a
 * group's frame marginally larger than its contents rather than clipping them.
 */
export function shapeWorldBounds(shape: WorkplaneShape): ShapeBounds {
  const footprint = shapeOverallFootprintDimensions(shape);
  const matrix = shapePlacementMatrix(shape);
  const halfWidth = footprint.width / 2;
  const halfDepth = footprint.depth / 2;
  const corner = new THREE.Vector3();
  const bounds: ShapeBounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
  for (const x of [-halfWidth, halfWidth]) {
    for (const y of [0, shape.height]) {
      for (const z of [-halfDepth, halfDepth]) {
        corner.set(x, y, z).applyMatrix4(matrix);
        bounds.minX = Math.min(bounds.minX, corner.x);
        bounds.maxX = Math.max(bounds.maxX, corner.x);
        bounds.minY = Math.min(bounds.minY, corner.y);
        bounds.maxY = Math.max(bounds.maxY, corner.y);
        bounds.minZ = Math.min(bounds.minZ, corner.z);
        bounds.maxZ = Math.max(bounds.maxZ, corner.z);
      }
    }
  }
  return bounds;
}

export function boundsForShapes(shapes: WorkplaneShape[]): ShapeBounds {
  const boxes = shapes.map(shapeWorldBounds);
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxY: Math.max(...boxes.map((box) => box.maxY)),
    minZ: Math.min(...boxes.map((box) => box.minZ)),
    maxZ: Math.max(...boxes.map((box) => box.maxZ)),
  };
}

export function boundsForPositions(positions: number[]): ShapeBounds | null {
  if (positions.length < 9) return null;
  const bounds: ShapeBounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
  for (let index = 0; index + 2 < positions.length; index += 3) {
    bounds.minX = Math.min(bounds.minX, positions[index]);
    bounds.maxX = Math.max(bounds.maxX, positions[index]);
    bounds.minY = Math.min(bounds.minY, positions[index + 1]);
    bounds.maxY = Math.max(bounds.maxY, positions[index + 1]);
    bounds.minZ = Math.min(bounds.minZ, positions[index + 2]);
    bounds.maxZ = Math.max(bounds.maxZ, positions[index + 2]);
  }
  return [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ].every(Number.isFinite)
    ? bounds
    : null;
}

/** A child's placement is held relative to its group's box, so it survives the group being moved. */
export function shapeAsGroupChild(shape: WorkplaneShape, centerX: number, centerZ: number, minY: number): WorkplaneShape {
  return {
    ...shape,
    id: createLocalId(`${shape.id}-group-child`),
    x: shape.x - centerX,
    z: shape.z - centerZ,
    elevation: (shape.elevation ?? 0) - minY,
  };
}

/**
 * One group holding the given shapes, or null when there is nothing to group.
 *
 * A group of nothing but holes is itself a hole, so grouping a set of cutters
 * and then grouping that with a solid cuts all of them.
 */
export function groupedShapeFromSelection(selection: WorkplaneShape[]): WorkplaneShape | null {
  const groupable = selection.filter((shape) => !shape.locked);
  if (groupable.length < 2) return null;

  const bounds = boundsForShapes(groupable);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const width = cleanModelDimension(Math.max(MIN_SHAPE_DIMENSION, bounds.maxX - bounds.minX));
  const depth = cleanModelDimension(Math.max(MIN_SHAPE_DIMENSION, bounds.maxZ - bounds.minZ));
  const height = cleanModelDimension(Math.max(MIN_SHAPE_DIMENSION, bounds.maxY - bounds.minY));
  const firstSolid = groupable.find((shape) => !shape.hole) ?? groupable[0];

  return canonicalizeShape({
    id: createLocalId("group"),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    hole: groupable.every((shape) => shape.hole),
    x: centerX,
    z: centerZ,
    elevation: bounds.minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    groupOperation: "group",
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: groupable.map((shape) => shapeAsGroupChild(shape, centerX, centerZ, bounds.minY)),
    locked: false,
    hidden: false,
  });
}

function quaternionForShape(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    degrees(shape.rotationX),
    degrees(shape.rotation),
    degrees(shape.rotationZ),
    "XYZ",
  ));
}

function rotationFromQuaternion(quaternion: THREE.Quaternion) {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    rotationX: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.x)),
    rotation: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.y)),
    rotationZ: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.z)),
  };
}

/**
 * The children of a group, put back where they belong as shapes of their own.
 *
 * A group can have been moved, turned, mirrored and resized since it was made,
 * and all of that has to be pushed down into the children: the stored base
 * dimensions say what the group measured when it was built, so the ratio to its
 * current size is the scale each child has silently been under.
 */
export function restoreGroupedChildren(group: WorkplaneShape): WorkplaneShape[] {
  const children = group.groupedShapes ?? [];
  if (children.length === 0) return [];

  const bounds = boundsForShapes(children);
  const baseWidth = group.groupedBaseWidth ?? Math.max(0.001, bounds.maxX - bounds.minX);
  const baseHeight = group.groupedBaseHeight ?? Math.max(0.001, bounds.maxY - bounds.minY);
  const baseDepth = group.groupedBaseDepth ?? Math.max(0.001, bounds.maxZ - bounds.minZ);
  const scaleX = shapeWidth(group) / Math.max(0.001, baseWidth);
  const scaleY = group.height / Math.max(0.001, baseHeight);
  const scaleZ = shapeDepth(group) / Math.max(0.001, baseDepth);
  const groupQuaternion = quaternionForShape(group);
  const groupReflection = new THREE.Matrix4().makeScale(mirrorSign(group.mirrorX), mirrorSign(group.mirrorY), mirrorSign(group.mirrorZ));
  const groupCenter = new THREE.Vector3(group.x, (group.elevation ?? 0) + group.height / 2, group.z);

  return children.map((child) => {
    const width = shapeWidth(child) * scaleX;
    const depth = shapeDepth(child) * scaleZ;
    const height = child.height * scaleY;
    const localCenter = new THREE.Vector3(
      child.x * scaleX * mirrorSign(group.mirrorX),
      (((child.elevation ?? 0) + child.height / 2) * scaleY - group.height / 2) * mirrorSign(group.mirrorY),
      child.z * scaleZ * mirrorSign(group.mirrorZ),
    ).applyQuaternion(groupQuaternion);
    const worldCenter = groupCenter.clone().add(localCenter);
    // A mirror either side of the child's own turn, so a reflected group turns
    // its children the other way rather than shearing them.
    const childRotationMatrix = new THREE.Matrix4()
      .makeRotationFromQuaternion(groupQuaternion)
      .multiply(groupReflection)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternionForShape(child)))
      .multiply(groupReflection);
    const childRotation = rotationFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(childRotationMatrix));
    const restored: WorkplaneShape = {
      ...child,
      id: createLocalId(`${child.id}-ungroup`),
      x: worldCenter.x,
      z: worldCenter.z,
      elevation: worldCenter.y - height / 2,
      width,
      depth,
      height,
      size: (width + depth) / 2,
      rotation: childRotation.rotation,
      rotationX: childRotation.rotationX,
      rotationZ: childRotation.rotationZ,
      mirrorX: Boolean(child.mirrorX) !== Boolean(group.mirrorX) || undefined,
      mirrorY: Boolean(child.mirrorY) !== Boolean(group.mirrorY) || undefined,
      mirrorZ: Boolean(child.mirrorZ) !== Boolean(group.mirrorZ) || undefined,
      hidden: group.hidden ? true : child.hidden,
    };
    return canonicalizeShape(group.hole ? withHoleMode(restored, true) : restored);
  });
}

/**
 * The operands a boolean actually works on.
 *
 * A group that is only a record is taken apart first, so cutting a hole out of
 * a group cuts the shapes inside it. One whose geometry has already been baked
 * into a mesh is left whole: that mesh *is* the group, and its children are
 * only there so it can be taken apart again later.
 */
export function expandGroupsForBoolean(selection: WorkplaneShape[]): WorkplaneShape[] {
  return selection.flatMap((shape) => {
    if (shape.importedMesh) return [shape];
    return shape.groupedShapes?.length ? restoreGroupedChildren(shape) : [shape];
  });
}

/**
 * One shape's triangles, in world space.
 *
 * Only shapes carrying a mesh have any on the server; a parametric shape's
 * geometry is built by the CAD kernel instead.
 */
export function worldMeshForShape(shape: WorkplaneShape): MeshData | null {
  const stored = shape.importedMesh;
  if (!stored || stored.positions.length < 9) return null;
  const positions = resizedImportedMeshPositions(shape);
  const vertices: Vec3[] = [];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    vertices.push([positions[index], positions[index + 1], positions[index + 2]]);
  }
  const faces: [number, number, number][] = [];
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    faces.push([index, index + 1, index + 2]);
  }
  return transformMesh({ name: shape.name, vertices, faces }, shape);
}

/**
 * A shape holding the given world-space triangles, placed where they are.
 *
 * The triangles are stored relative to the shape's own frame -- centred in X
 * and Z, measured up from its base -- which is the frame the viewport draws a
 * mesh in, so the result keeps its place on the workplane.
 */
export function meshShapeFromWorldPositions(
  worldPositions: number[],
  fields: Partial<WorkplaneShape> & { id: string; name: string; color: string },
): WorkplaneShape | null {
  const bounds = boundsForPositions(worldPositions);
  if (!bounds) return null;

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, bounds.maxX - bounds.minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, bounds.maxY - bounds.minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, bounds.maxZ - bounds.minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions = worldPositions.map((value, index) => {
    if (index % 3 === 0) return value - centerX;
    if (index % 3 === 1) return value - bounds.minY;
    return value - centerZ;
  });

  return canonicalizeShape({
    kind: "mesh",
    x: cleanNearZero(centerX, 0.0005),
    z: cleanNearZero(centerZ, 0.0005),
    elevation: cleanNearZero(bounds.minY, 0.0005),
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    locked: false,
    hidden: false,
    ...fields,
  });
}

function quantizedPointKey([x, y, z]: Vec3, tolerance: number) {
  return [x, y, z].map((value) => Math.round(value / tolerance)).join(",");
}

/**
 * The triangles of a mesh, gathered into bodies that touch.
 *
 * Two triangles belong to the same body when they share a corner, within the
 * tolerance that decides two coordinates are the same point -- a mesh written
 * out as a flat triangle list has no vertex sharing left to read.
 */
function meshFaceComponents(mesh: MeshData, tolerance = SEPARATE_PARTS_VERTEX_TOLERANCE) {
  if (mesh.faces.length === 0) return [];
  const keysByFace = mesh.faces.map((face) => face.map((vertexIndex) => quantizedPointKey(mesh.vertices[vertexIndex], tolerance)));
  const facesByVertex = new Map<string, number[]>();
  keysByFace.forEach((keys, faceIndex) => {
    keys.forEach((key) => {
      const current = facesByVertex.get(key);
      if (current) current.push(faceIndex);
      else facesByVertex.set(key, [faceIndex]);
    });
  });

  const visited = new Uint8Array(mesh.faces.length);
  const components: number[][] = [];
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex += 1) {
    if (visited[faceIndex]) continue;
    const component: number[] = [];
    const queue = [faceIndex];
    visited[faceIndex] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      component.push(current);
      keysByFace[current].forEach((key) => {
        const neighbors = facesByVertex.get(key);
        if (!neighbors) return;
        // Each corner is only ever walked once: a body is reached through any
        // one of its vertices, so revisiting them makes this quadratic.
        facesByVertex.delete(key);
        neighbors.forEach((neighbor) => {
          if (visited[neighbor]) return;
          visited[neighbor] = 1;
          queue.push(neighbor);
        });
      });
    }
    components.push(component);
  }
  return components;
}

function meshComponentShape(source: WorkplaneShape, mesh: MeshData, faceIndices: number[], partIndex: number, totalParts: number) {
  const worldPositions: number[] = [];
  faceIndices.forEach((faceIndex) => {
    const face = mesh.faces[faceIndex];
    if (!face) return;
    face.forEach((vertexIndex) => {
      const vertex = mesh.vertices[vertexIndex];
      if (vertex) worldPositions.push(vertex[0], vertex[1], vertex[2]);
    });
  });

  return meshShapeFromWorldPositions(worldPositions, {
    id: createLocalId(`${source.id}-part`),
    name: totalParts > 1 ? `${source.name} Part ${partIndex + 1}` : source.name,
    color: source.color,
    hole: source.hole || undefined,
    hidden: source.hidden,
  });
}

/**
 * A shape split into the bodies it is made of, or nothing when it is only one.
 *
 * A group that is only a record splits back into its children, which is what
 * "separate" means for something that was never fused. Anything carrying a mesh
 * splits into the parts of that mesh that touch.
 */
export function separateShapeParts(shape: WorkplaneShape): WorkplaneShape[] {
  if (shape.locked || shape.hole) return [];
  if (shape.groupedShapes?.length && !shape.importedMesh) {
    const restored = restoreGroupedChildren(shape);
    return restored.length > 1 ? restored : [];
  }

  const mesh = worldMeshForShape(shape);
  if (!mesh) return [];
  const components = meshFaceComponents(mesh).filter((component) => component.length > 0);
  if (components.length <= 1) return [];
  return components
    .map((component, index) => meshComponentShape(shape, mesh, component, index, components.length))
    .filter((part): part is WorkplaneShape => Boolean(part));
}
