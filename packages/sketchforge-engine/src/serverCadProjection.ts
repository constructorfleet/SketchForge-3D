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
 * A shape that carries a mesh is the exception (#506): it has no exact edges,
 * only triangles, and the kernel would draw every one of them. It is drawn by
 * its feature edges instead (`meshEdgeProjection.ts`), and the two halves of
 * the scene hide each other through a depth buffer of their triangles.
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
import {
  DEFAULT_FEATURE_ANGLE,
  depthBuffer,
  drawMeshEdges,
  isFeatureAngle,
  meshEdgeSet,
  occludeByMeshes,
  viewRaster,
  type MeshEdgeSet,
  type TriangleSoup,
} from "./meshEdgeProjection.js";
import { recoverLegacyRevolveShapes } from "./serverRevolveRecovery.js";
import { hasExactRevolveSolid } from "./serverCadOperations.js";
import { withCadKernel } from "./serverCadKernel.js";
import { ServerCadError } from "./serverCadOperations.js";
import { isGroupRecord, placedSolidForShape } from "./serverShapeBooleans.js";
import { restoreGroupedChildren, worldMeshForShape } from "./serverShapeGroups.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type ProjectionOptions = {
  /** One named view, or the four-view grid. The grid by default. */
  view?: ProjectionLayout;
  /** Width and height of each panel in px. Each panel is square. */
  panelSize?: number;
  /** Draw occluded edges dashed. On by default; a laser-cut template wants it off. */
  showHidden?: boolean;
  /**
   * Crease angle in degrees for shapes that carry a mesh: an edge between two
   * triangles is drawn only when they meet at more than this, besides
   * boundaries and silhouettes. 30 by default; 0 draws every edge that is not
   * flat. Exact solids are drawn from their true edges and ignore it.
   */
  featureAngle?: number;
};

const ORIGIN = { x: 0, y: 0, z: 0 };

/** The exact solids as one shape in the drawing frame. */
function drawingCompound(cad: OcctKernel, shapes: readonly WorkplaneShape[]): ShapeHandle {
  const solids = shapes.map((shape) => cad.transform(placedSolidForShape(cad, shape), [...EDITOR_TO_DRAWING_TRANSFORM]));
  return solids.length === 1 ? solids[0] : cad.makeCompound(solids);
}

/** Whether a mesh is anywhere among the shape or, for a group record, its members. */
function holdsMesh(shape: WorkplaneShape): boolean {
  if (hasExactRevolveSolid(shape)) return false;
  if (worldMeshForShape(shape)) return true;
  return isGroupRecord(shape) && restoreGroupedChildren(shape).some(holdsMesh);
}

/**
 * The shapes to draw for one visible shape.
 *
 * A group record with a mesh among its members and no hole among them is
 * drawn as its members, so each mesh goes down the feature-edge path rather
 * than being sewn into the group's fused solid and drawn triangle by triangle
 * (#506). A member group without a mesh stays whole, so its solids are still
 * fused before the kernel draws them. A group that cuts holes has to be cut,
 * which needs the sewn solid, so it stays on the kernel path.
 */
function drawingMembers(shape: WorkplaneShape): WorkplaneShape[] {
  if (!isGroupRecord(shape) || !holdsMesh(shape)) return [shape];
  const children = restoreGroupedChildren(shape);
  if (children.some((child) => child.hole)) return [shape];
  return children.flatMap(drawingMembers);
}

/** A mesh shape's triangles in the drawing frame: `[x, y, z]` becomes `[x, -z, y]`. */
function drawingSoup(shape: WorkplaneShape): Float64Array | null {
  if (hasExactRevolveSolid(shape)) return null;
  const mesh = worldMeshForShape(shape);
  if (!mesh) return null;
  const soup = new Float64Array(mesh.faces.length * 9);
  let offset = 0;
  for (const face of mesh.faces) {
    for (const vertexIndex of face) {
      const [x, y, z] = mesh.vertices[vertexIndex];
      soup[offset] = x;
      soup[offset + 1] = -z;
      soup[offset + 2] = y;
      offset += 3;
    }
  }
  return soup;
}

/** The kernel's tessellation of the exact solids, as a soup, so meshes can be hidden behind them. */
function tessellatedSoup(cad: OcctKernel, scene: ShapeHandle, deflection: number): Float64Array {
  const mesh = cad.meshShape(scene, { linearDeflection: deflection });
  const soup = new Float64Array(mesh.indices.length * 3);
  mesh.indices.forEach((vertex, index) => {
    soup[index * 3] = mesh.positions[vertex * 3];
    soup[index * 3 + 1] = mesh.positions[vertex * 3 + 1];
    soup[index * 3 + 2] = mesh.positions[vertex * 3 + 2];
  });
  return soup;
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

type ExactScene = { cad: OcctKernel; scene: ShapeHandle; soup: Float64Array | null; deflection: number };
type MeshScene = { soups: Float64Array[]; edges: MeshEdgeSet[] };

function exactDrawing(exact: ExactScene, view: ProjectionView) {
  const basis = viewBasis(view);
  const projected: ProjectionData = exact.cad.projectEdges(exact.scene, ORIGIN, basis.toward, basis.right);
  const lines = (handle: ShapeHandle) => polylinesOf(exact.cad, handle, exact.deflection);
  return {
    visible: [...lines(projected.visibleOutline), ...lines(projected.visibleSmooth), ...lines(projected.visibleSharp)],
    hidden: [...lines(projected.hiddenOutline), ...lines(projected.hiddenSmooth), ...lines(projected.hiddenSharp)],
  };
}

function viewDrawing(view: ProjectionView, exact: ExactScene | null, meshes: MeshScene): ViewDrawing {
  const drawn = exact ? exactDrawing(exact, view) : { visible: [], hidden: [] };
  if (!meshes.soups.length) return { view, ...drawn };

  const basis = viewBasis(view);
  const exactSoups: TriangleSoup[] = exact?.soup ? [exact.soup] : [];
  const raster = viewRaster(basis, [...meshes.soups, ...exactSoups], drawn.visible);
  const meshDepth = depthBuffer(raster, meshes.soups);
  const exactDepth = exactSoups.length ? depthBuffer(raster, exactSoups) : null;
  const visible: DrawingPolyline[] = [];
  const hidden: DrawingPolyline[] = [...drawn.hidden];
  if (exactDepth) occludeByMeshes(drawn.visible, exactDepth, meshDepth, visible, hidden);
  const occluders = exactDepth ? [meshDepth, exactDepth] : [meshDepth];
  for (const edges of meshes.edges) {
    const lines = drawMeshEdges(edges, occluders, raster);
    visible.push(...lines.visible);
    hidden.push(...lines.hidden);
  }
  return { view, visible, hidden };
}

function soupBounds(soups: readonly Float64Array[]) {
  const box = { xmin: Infinity, ymin: Infinity, zmin: Infinity, xmax: -Infinity, ymax: -Infinity, zmax: -Infinity };
  for (const soup of soups) {
    for (let index = 0; index + 2 < soup.length; index += 3) {
      box.xmin = Math.min(box.xmin, soup[index]); box.xmax = Math.max(box.xmax, soup[index]);
      box.ymin = Math.min(box.ymin, soup[index + 1]); box.ymax = Math.max(box.ymax, soup[index + 1]);
      box.zmin = Math.min(box.zmin, soup[index + 2]); box.zmax = Math.max(box.zmax, soup[index + 2]);
    }
  }
  return box;
}

/**
 * The visible solids of `shapes` drawn to an SVG string.
 *
 * Refuses, as the mesh exports do, when nothing is left to draw, and refuses
 * a crease angle outside 0 to 180 degrees.
 */
export async function projectShapesToSvg(shapes: readonly WorkplaneShape[], options: ProjectionOptions = {}): Promise<string> {
  const visible = shapes.filter((shape) => shape.hidden !== true && shape.hole !== true);
  if (!visible.length) {
    return Promise.reject(new ServerCadError("No visible solid objects to draw.", 422));
  }
  const featureAngle = options.featureAngle ?? DEFAULT_FEATURE_ANGLE;
  if (!isFeatureAngle(featureAngle)) {
    return Promise.reject(new ServerCadError("featureAngle must be a number of degrees from 0 to 180.", 400));
  }
  const layout = options.view ?? "multiview";
  const views = layout === "multiview" ? MULTIVIEW_PANELS : [layout];

  const soups: Float64Array[] = [];
  const exactShapes: WorkplaneShape[] = [];
  for (const shape of (await recoverLegacyRevolveShapes(visible)).flatMap(drawingMembers)) {
    const soup = drawingSoup(shape);
    if (soup) soups.push(soup);
    else exactShapes.push(shape);
  }
  const meshes: MeshScene = { soups, edges: soups.map((soup) => meshEdgeSet(soup, featureAngle)) };
  const render = (exact: ExactScene | null, box: ReturnType<typeof soupBounds>) => {
    const size = { x: box.xmax - box.xmin, y: box.ymax - box.ymin, z: box.zmax - box.zmin };
    const panels = views.map((view) => viewDrawing(view, exact, meshes));
    return renderDrawingSvg({ layout, panels, size }, { panelSize: options.panelSize, showHidden: options.showHidden });
  };
  // A scene of meshes alone never needs the kernel.
  if (!exactShapes.length) return Promise.resolve().then(() => render(null, soupBounds(soups)));

  return withCadKernel((cad) => {
    const scene = drawingCompound(cad, exactShapes);
    const exactBox = cad.getBoundingBox(scene, false);
    const meshBox = soupBounds(soups);
    const box = {
      xmin: Math.min(exactBox.xmin, meshBox.xmin), xmax: Math.max(exactBox.xmax, meshBox.xmax),
      ymin: Math.min(exactBox.ymin, meshBox.ymin), ymax: Math.max(exactBox.ymax, meshBox.ymax),
      zmin: Math.min(exactBox.zmin, meshBox.zmin), zmax: Math.max(exactBox.zmax, meshBox.zmax),
    };
    // Sampled at a fifth of a percent of the diagonal, so a curve reads as a
    // curve at any size without the drawing growing with the part.
    const deflection = Math.max(Math.hypot(box.xmax - box.xmin, box.ymax - box.ymin, box.zmax - box.zmin) * 0.002, 1e-4);
    const exact: ExactScene = { cad, scene, deflection, soup: soups.length ? tessellatedSoup(cad, scene, deflection) : null };
    return render(exact, box);
  });
}
