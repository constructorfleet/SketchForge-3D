/** Exact-kernel section contours for one bounded, named axis plane. Node-only. */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { renderSectionDxf, renderSectionSvg, SECTION_PLANES, type SectionDrawing, type SectionPlane } from "./cadSection.js";
import { withCadKernel } from "./serverCadKernel.js";
import { ServerCadError } from "./serverCadOperations.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import { EDITOR_TO_DRAWING_TRANSFORM } from "./cadProjection.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type SectionOptions = { plane: SectionPlane; offset: number };

const MAX_SECTION_SHAPES = 100;
const MAX_SECTION_SPAN = 8_000;
export const MAX_SECTION_FACE_SPAN = 10_000;
const MAX_MESH_TRIANGLES = 50_000;
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

function validateRequest(shapes: readonly WorkplaneShape[], options: SectionOptions): asserts options is SectionOptions {
  if (!options || !SECTION_PLANES.includes(options.plane)) throw new ServerCadError(`plane must be one of: ${SECTION_PLANES.join(", ")}.`, 400);
  if (!Number.isFinite(options.offset) || Math.abs(options.offset) > 100_000) {
    throw new ServerCadError("Section offset must be a finite coordinate between -100000 and 100000.", 400);
  }
  if (shapes.length > MAX_SECTION_SHAPES) throw new ServerCadError(`A section drawing supports a maximum of ${MAX_SECTION_SHAPES} shapes.`, 413);
  const triangles = shapes.reduce((sum, shape) => sum + (shape.importedMesh?.triangleCount ?? 0), 0);
  if (triangles > MAX_MESH_TRIANGLES) throw new ServerCadError(`Section drawing supports a maximum of ${MAX_MESH_TRIANGLES} imported mesh triangles.`, 413);
}

function sectionCompound(cad: OcctKernel, shapes: readonly WorkplaneShape[]): ShapeHandle {
  const handles = shapes.map((shape) => cad.transform(placedSolidForShape(cad, shape), [...EDITOR_TO_DRAWING_TRANSFORM]));
  return handles.length === 1 ? handles[0] : cad.makeCompound(handles);
}

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

/** Cut the visible stored solids by a bounded plane and return scale-readable SVG contours. */
async function sectionShapesToDrawing(shapes: readonly WorkplaneShape[], options: SectionOptions): Promise<{ drawing: SectionDrawing; bounds: { minU: number; maxU: number; minV: number; maxV: number } }> {
  validateRequest(shapes, options);
  const visible = shapes.filter((shape) => shape.hidden !== true && shape.hole !== true);
  if (!visible.length) return Promise.reject(new ServerCadError("No visible solid objects to section.", 422));

  return withCadKernel((cad) => {
    const scene = sectionCompound(cad, visible);
    const bounds = cad.getBoundingBox(scene, false);
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
    const face = cad.transform(
      cad.makeRectangle(uBounds.max - uBounds.min + margin * 2, vBounds.max - vBounds.min + margin * 2),
      frame.matrix(uBounds.min - margin, vBounds.min - margin, options.offset),
    );
    const section = cad.section(scene, face);
    if (Number(section) === 0) throw new ServerCadError("The requested section plane produced no contours.", 422);
    const diagonal = Math.hypot(...spans);
    const contours = sampledContours(cad, section, options.plane, Math.max(diagonal * 0.002, 1e-4));
    if (!contours.length) throw new ServerCadError("The requested section plane produced no contours.", 422);
    const drawing: SectionDrawing = { plane: options.plane, offset: options.offset, contours };
    return { drawing, bounds: {
      minU: uBounds.min, maxU: uBounds.max,
      minV: vBounds.min, maxV: vBounds.max,
    } };
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
