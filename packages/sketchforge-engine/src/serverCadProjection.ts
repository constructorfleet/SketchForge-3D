/**
 * A 2D drawing of a project, from the exact B-rep.
 *
 * OCCT's hidden-line removal runs on the real surfaces, so a cylinder's
 * outline is a circle and an occluded edge is a dashed one. The client-side
 * SVG export flattens a triangle soup from above instead, and the MCP capture
 * tool used to depth-sort every triangle by hand; this is the server-side path
 * neither of them had.
 *
 * Every visible solid of the scene is placed where it sits, turned into the
 * drawing's Z-up frame (`EDITOR_TO_DRAWING_TRANSFORM`) and gathered into one
 * compound, so a drawing of a scene is one drawing rather than one per part
 * and the parts occlude each other correctly. Hidden shapes and cutters are
 * left out, as every mesh export leaves them out.
 *
 * `projectEdges` hands its result back in the camera's own frame: x along the
 * `right` axis it was given, y along `toward × right`, z flattened to zero.
 * That is why the polylines below are read off as `(x, y)` with no further
 * projection, and why the kernel's own SVG renderer (which dots them with
 * world axes) is not used -- see `cadProjection.ts`.
 *
 * Node-only. Never import this from anything the browser bundles.
 */

import type { OcctKernel, ProjectionData, ShapeHandle } from "occt-wasm";
import {
  EDITOR_TO_DRAWING_TRANSFORM,
  MULTIVIEW_PANELS,
  renderDrawingSvg,
  viewBasis,
  type DrawingPolyline,
  type ProjectionLayout,
  type ProjectionView,
  type ViewDrawing,
} from "./cadProjection.js";
import { withCadKernel } from "./serverCadKernel.js";
import { ServerCadError } from "./serverCadOperations.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type ProjectionOptions = {
  /** One named view, or the four-view grid. The grid by default. */
  view?: ProjectionLayout;
  /** Width and height of each panel in px. Each panel is square. */
  panelSize?: number;
  /** Draw occluded edges dashed. On by default; a laser-cut template wants it off. */
  showHidden?: boolean;
};

const ORIGIN = { x: 0, y: 0, z: 0 };

/** The scene as one shape in the drawing frame. */
function drawingCompound(cad: OcctKernel, shapes: readonly WorkplaneShape[]): ShapeHandle {
  const solids = shapes.map((shape) => cad.transform(placedSolidForShape(cad, shape), [...EDITOR_TO_DRAWING_TRANSFORM]));
  return solids.length === 1 ? solids[0] : cad.makeCompound(solids);
}

/** Each projected edge sampled into a polyline, read in the camera frame. */
function polylinesOf(cad: OcctKernel, handle: ShapeHandle, deflection: number): DrawingPolyline[] {
  // An empty category comes back as the null handle rather than an empty compound.
  if (Number(handle) === 0) return [];
  const { points, edgeGroups } = cad.wireframe(handle, deflection);
  const lines: DrawingPolyline[] = [];
  for (let group = 0; group + 1 < edgeGroups.length; group += 3) {
    const start = edgeGroups[group];
    const count = edgeGroups[group + 1];
    const line: DrawingPolyline = [];
    for (let index = 0; index + 1 < count; index += 3) {
      line.push(points[start + index], points[start + index + 1]);
    }
    if (line.length >= 4) lines.push(line);
  }
  return lines;
}

function viewDrawing(cad: OcctKernel, scene: ShapeHandle, view: ProjectionView, deflection: number): ViewDrawing {
  const basis = viewBasis(view);
  const projected: ProjectionData = cad.projectEdges(scene, ORIGIN, basis.toward, basis.right);
  const lines = (handle: ShapeHandle) => polylinesOf(cad, handle, deflection);
  return {
    view,
    visible: [...lines(projected.visibleOutline), ...lines(projected.visibleSmooth), ...lines(projected.visibleSharp)],
    hidden: [...lines(projected.hiddenOutline), ...lines(projected.hiddenSmooth), ...lines(projected.hiddenSharp)],
  };
}

/**
 * The visible solids of `shapes` drawn to an SVG string.
 *
 * Refuses, as the mesh exports do, when nothing is left to draw.
 */
export function projectShapesToSvg(shapes: readonly WorkplaneShape[], options: ProjectionOptions = {}): Promise<string> {
  const visible = shapes.filter((shape) => shape.hidden !== true && shape.hole !== true);
  if (!visible.length) {
    return Promise.reject(new ServerCadError("No visible solid objects to draw.", 422));
  }
  const layout = options.view ?? "multiview";
  const views = layout === "multiview" ? MULTIVIEW_PANELS : [layout];
  return withCadKernel((cad) => {
    const scene = drawingCompound(cad, visible);
    const box = cad.getBoundingBox(scene, false);
    const size = { x: box.xmax - box.xmin, y: box.ymax - box.ymin, z: box.zmax - box.zmin };
    // Sampled at a fifth of a percent of the diagonal, so a curve reads as a
    // curve at any size without the drawing growing with the part.
    const deflection = Math.max(Math.hypot(size.x, size.y, size.z) * 0.002, 1e-4);
    const panels = views.map((view) => viewDrawing(cad, scene, view, deflection));
    return renderDrawingSvg({ layout, panels, size }, { panelSize: options.panelSize, showHidden: options.showHidden });
  });
}
