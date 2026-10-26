/**
 * Section contours for one bounded, named axis plane. Node-only.
 *
 * Shapes the project describes exactly are cut by the OCCT kernel. Shapes it
 * describes only by their triangles -- imported meshes, and anything stored as
 * a mesh -- are sliced directly (`meshSection.ts`): sewing their triangles into
 * a solid first is what made a 50,000-triangle section take minutes, and the
 * sewn solid's section is the same polyline anyway.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { renderSectionDxf, renderSectionSvg, SECTION_PLANES, type SectionDrawing, type SectionPlane } from "./cadSection.js";
import { withCadKernel } from "./serverCadKernel.js";
import { recoverLegacyRevolveShapes } from "./serverRevolveRecovery.js";
import { hasExactRevolveSolid, ServerCadError } from "./serverCadOperations.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import { EDITOR_TO_DRAWING_TRANSFORM } from "./cadProjection.js";
import { sectionTriangleSoup } from "./meshSection.js";
import { worldMeshForShape } from "./serverShapeGroups.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type SectionOptions = { plane: SectionPlane; offset: number };

const MAX_SECTION_SHAPES = 100;
const MAX_SECTION_SPAN = 8_000;
export const MAX_SECTION_FACE_SPAN = 10_000;
/**
 * Triangles a section reads, across every mesh in it, counted from the stored
 * positions as well as the recorded count. Slicing is linear, so this bounds
 * memory rather than time: placing a mesh builds a vertex array, a transformed
 * copy, and a Float64Array in the drawing frame, about 400 bytes a triangle
 * at peak. Measured by hand, not in the perf lane (which stops at 240,000): a
 * 1,965,600-triangle section ran out of a 1 GiB heap and completed in 1.5 GiB.
 */
export const MAX_SECTION_MESH_TRIANGLES = 2_000_000;
export const MAX_CONTOURS = 10_000;
export const MAX_SAMPLED_POINTS = 100_000;

type Bounds = { xmin: number; xmax: number; ymin: number; ymax: number; zmin: number; zmax: number };
type PlaneFrame = { normal: "x" | "y" | "z"; u: "x" | "y" | "z"; v: "x" | "y" | "z"; matrix: (minU: number, minV: number, offset: number) => number[] };

const FRAMES: Record<SectionPlane, PlaneFrame> = {
  xy: {
    normal: "z", u: "x", v: "y",
    matrix: (u, v, offset) => [1, 0, 0, u, 0, 1, 0, v, 0, 0, 1, offset],
  },
  xz: {
    normal: "y", u: "x", v: "z",
    matrix: (u, v, offset) => [1, 0, 0, u, 0, 0, -1, offset, 0, 1, 0, v],
  },
  yz: {
    normal: "x", u: "y", v: "z",
    matrix: (u, v, offset) => [0, 0, 1, offset, 1, 0, 0, u, 0, 1, 0, v],
  },
};

function axisBounds(bounds: Bounds, axis: "x" | "y" | "z") {
  if (axis === "x") return { min: bounds.xmin, max: bounds.xmax };
  if (axis === "y") return { min: bounds.ymin, max: bounds.ymax };
  return { min: bounds.zmin, max: bounds.zmax };
}

/** Triangles a shape's stored mesh holds, read from the positions themselves as well as the count beside them. */
function meshTriangleCount(shape: WorkplaneShape) {
  const mesh = shape.importedMesh;
  if (!mesh) return 0;
  return Math.max(mesh.triangleCount ?? 0, Math.floor((mesh.positions?.length ?? 0) / 9));
}

function validateRequest(shapes: readonly WorkplaneShape[], options: SectionOptions): asserts options is SectionOptions {
  if (!options || !SECTION_PLANES.includes(options.plane)) throw new ServerCadError(`plane must be one of: ${SECTION_PLANES.join(", ")}.`, 400);
  if (!Number.isFinite(options.offset) || Math.abs(options.offset) > 100_000) {
    throw new ServerCadError("Section offset must be a finite coordinate between -100000 and 100000.", 400);
  }
  if (shapes.length > MAX_SECTION_SHAPES) throw new ServerCadError(`A section drawing supports a maximum of ${MAX_SECTION_SHAPES} shapes.`, 413);
  const counts = shapes.map(meshTriangleCount);
  const triangles = counts.reduce((sum, count) => sum + count, 0);
  if (triangles > MAX_SECTION_MESH_TRIANGLES) {
    const alone = counts.some((count) => count > MAX_SECTION_MESH_TRIANGLES);
    throw new ServerCadError(
      alone
        ? `Section drawing supports a maximum of ${MAX_SECTION_MESH_TRIANGLES} mesh triangles; one selected mesh has ${Math.max(...counts)}. `
          + "Reduce the mesh before importing it."
        : `Section drawing supports a maximum of ${MAX_SECTION_MESH_TRIANGLES} mesh triangles across the selected shapes; these have ${triangles}. `
          + "Pass shapeIds to section fewer shapes at a time, or reduce the meshes before importing them.",
      413,
    );
  }
}

function sectionCompound(cad: OcctKernel, shapes: readonly WorkplaneShape[]): ShapeHandle {
  const handles = shapes.map((shape) => cad.transform(placedSolidForShape(cad, shape), [...EDITOR_TO_DRAWING_TRANSFORM]));
  return handles.length === 1 ? handles[0] : cad.makeCompound(handles);
}

/** A mesh shape's triangles where it stands, in the drawing frame, three vertices per triangle. */
function drawingFramePositions(shape: WorkplaneShape): Float64Array | null {
  if (hasExactRevolveSolid(shape)) return null;
  const mesh = worldMeshForShape(shape);
  if (!mesh) return null;
  const positions = new Float64Array(mesh.faces.length * 9);
  const m = EDITOR_TO_DRAWING_TRANSFORM;
  let cursor = 0;
  for (const face of mesh.faces) {
    for (const vertexIndex of face) {
      const [x, y, z] = mesh.vertices[vertexIndex];
      positions[cursor++] = m[0] * x + m[1] * y + m[2] * z + m[3];
      positions[cursor++] = m[4] * x + m[5] * y + m[6] * z + m[7];
      positions[cursor++] = m[8] * x + m[9] * y + m[10] * z + m[11];
    }
  }
  return positions;
}

function positionBounds(positions: Float64Array): Bounds | null {
  if (positions.length < 9) return null;
  const bounds = { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, zmin: Infinity, zmax: -Infinity };
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (x < bounds.xmin) bounds.xmin = x;
    if (x > bounds.xmax) bounds.xmax = x;
    if (y < bounds.ymin) bounds.ymin = y;
    if (y > bounds.ymax) bounds.ymax = y;
    if (z < bounds.zmin) bounds.zmin = z;
    if (z > bounds.zmax) bounds.zmax = z;
  }
  return bounds;
}

function unionBounds(bounds: readonly Bounds[]): Bounds | null {
  if (!bounds.length) return null;
  return bounds.reduce((left, right) => ({
    xmin: Math.min(left.xmin, right.xmin), xmax: Math.max(left.xmax, right.xmax),
    ymin: Math.min(left.ymin, right.ymin), ymax: Math.max(left.ymax, right.ymax),
    zmin: Math.min(left.zmin, right.zmin), zmax: Math.max(left.zmax, right.zmax),
  }));
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

function contourCoordinates(plane: SectionPlane, x: number, y: number, z: number): [number, number] {
  if (plane === "xy") return [x, y];
  if (plane === "xz") return [x, z];
  return [y, z];
}

function sampledContours(cad: OcctKernel, section: ShapeHandle, plane: SectionPlane, deflection: number) {
  const { points, edgeGroups } = cad.wireframe(section, deflection);
  if (edgeGroups.length / 3 > MAX_CONTOURS || points.length / 3 > MAX_SAMPLED_POINTS) {
    throw new ServerCadError("Section drawing is too complex to return safely.", 413);
  }
  const contours: number[][] = [];
  for (let group = 0; group + 2 < edgeGroups.length; group += 3) {
    const start = edgeGroups[group];
    const count = edgeGroups[group + 1];
    if (start < 0 || count < 0 || start + count > points.length) {
      throw new ServerCadError("The CAD kernel returned malformed section contours.");
    }
    const contour: number[] = [];
    for (let index = 0; index + 2 < count; index += 3) {
      const [u, v] = contourCoordinates(
        plane,
        points[start + index],
        points[start + index + 1],
        points[start + index + 2],
      );
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        throw new ServerCadError("The CAD kernel returned non-finite section coordinates.");
      }
      contour.push(u, v);
    }
    if (contour.length >= 4) contours.push(contour);
  }
  return contours;
}

type SectionBounds = { minU: number; maxU: number; minV: number; maxV: number };

/** Refuse a scene the plane misses or that is too large to draw, and frame what is left. */
function checkedFrame(bounds: Bounds, options: SectionOptions) {
  const values = [bounds.xmin, bounds.xmax, bounds.ymin, bounds.ymax, bounds.zmin, bounds.zmax];
  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 100_000)) {
    throw new ServerCadError("The selected scene has coordinates outside the supported section range.", 413);
  }
  const frame = FRAMES[options.plane];
  const normal = axisBounds(bounds, frame.normal);
  if (options.offset < normal.min - 1e-7 || options.offset > normal.max + 1e-7) {
    throw new ServerCadError("The requested section plane does not intersect the selected scene.", 422);
  }
  const uBounds = axisBounds(bounds, frame.u);
  const vBounds = axisBounds(bounds, frame.v);
  const spans = [bounds.xmax - bounds.xmin, bounds.ymax - bounds.ymin, bounds.zmax - bounds.zmin];
  if (spans.some((span) => span > MAX_SECTION_SPAN)) {
    throw new ServerCadError(`Section drawings support a maximum section span of ${MAX_SECTION_SPAN} mm.`, 413);
  }
  const margin = Math.max(1, Math.max(uBounds.max - uBounds.min, vBounds.max - vBounds.min) * 0.02);
  if (uBounds.max - uBounds.min + margin * 2 > MAX_SECTION_FACE_SPAN || vBounds.max - vBounds.min + margin * 2 > MAX_SECTION_FACE_SPAN) {
    throw new ServerCadError(`Section faces are limited to ${MAX_SECTION_FACE_SPAN} mm on each side.`, 413);
  }
  return { frame, uBounds, vBounds, margin, diagonal: Math.hypot(...spans) };
}

function exactContours(cad: OcctKernel, scene: ShapeHandle, options: SectionOptions, framed: ReturnType<typeof checkedFrame>) {
  const { frame, uBounds, vBounds, margin, diagonal } = framed;
  const face = cad.transform(
    cad.makeRectangle(uBounds.max - uBounds.min + margin * 2, vBounds.max - vBounds.min + margin * 2),
    frame.matrix(uBounds.min - margin, vBounds.min - margin, options.offset),
  );
  const section = cad.section(scene, face);
  if (Number(section) === 0) return [];
  return sampledContours(cad, section, options.plane, Math.max(diagonal * 0.002, 1e-4));
}

function meshContours(meshes: readonly Float64Array[], options: SectionOptions) {
  const frame = FRAMES[options.plane];
  const axes = { normal: AXIS_INDEX[frame.normal], u: AXIS_INDEX[frame.u], v: AXIS_INDEX[frame.v], offset: options.offset };
  return meshes.flatMap((positions) => sectionTriangleSoup(positions, axes));
}

function finishedDrawing(contours: number[][], options: SectionOptions, framed: ReturnType<typeof checkedFrame>) {
  const points = contours.reduce((sum, contour) => sum + contour.length / 2, 0);
  if (contours.length > MAX_CONTOURS || points > MAX_SAMPLED_POINTS) {
    throw new ServerCadError("Section drawing is too complex to return safely.", 413);
  }
  if (!contours.length) throw new ServerCadError("The requested section plane produced no contours.", 422);
  const drawing: SectionDrawing = { plane: options.plane, offset: options.offset, contours };
  const bounds: SectionBounds = { minU: framed.uBounds.min, maxU: framed.uBounds.max, minV: framed.vBounds.min, maxV: framed.vBounds.max };
  return { drawing, bounds };
}

/** Cut the visible stored solids by a bounded plane and return scale-readable contours. */
async function sectionShapesToDrawing(shapes: readonly WorkplaneShape[], options: SectionOptions): Promise<{ drawing: SectionDrawing; bounds: SectionBounds }> {
  validateRequest(shapes, options);
  const visible = shapes.filter((shape) => shape.hidden !== true && shape.hole !== true);
  if (!visible.length) return Promise.reject(new ServerCadError("No visible solid objects to section.", 422));

  const meshes: Float64Array[] = [];
  const exact: WorkplaneShape[] = [];
  for (const shape of await recoverLegacyRevolveShapes(visible)) {
    const positions = drawingFramePositions(shape);
    if (positions) meshes.push(positions);
    else exact.push(shape);
  }
  const meshBounds = meshes.map(positionBounds).filter((bounds): bounds is Bounds => bounds !== null);

  if (!exact.length) {
    const framed = checkedFrame(unionBounds(meshBounds)!, options);
    return finishedDrawing(meshContours(meshes, options), options, framed);
  }
  return withCadKernel((cad) => {
    const scene = sectionCompound(cad, exact);
    const framed = checkedFrame(unionBounds([cad.getBoundingBox(scene, false), ...meshBounds])!, options);
    const contours = exactContours(cad, scene, options, framed);
    return finishedDrawing([...contours, ...meshContours(meshes, options)], options, framed);
  });
}

export async function sectionShapesToSvg(shapes: readonly WorkplaneShape[], options: SectionOptions): Promise<string> {
  const result = await sectionShapesToDrawing(shapes, options);
  return renderSectionSvg(result.drawing, result.bounds);
}

export async function sectionShapesToDxf(shapes: readonly WorkplaneShape[], options: SectionOptions): Promise<string> {
  const { drawing } = await sectionShapesToDrawing(shapes, options);
  return renderSectionDxf(drawing);
}
