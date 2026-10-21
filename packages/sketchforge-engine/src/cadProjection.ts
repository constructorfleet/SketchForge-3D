/**
 * A 2D drawing of a project, with no kernel in it.
 *
 * The kernel's hidden-line removal (`projectEdges`) answers which edges of a
 * solid a camera can see and which it cannot; everything after that is
 * arithmetic and SVG text, and lives here so it can be tested against drawn
 * polylines rather than against OCCT. `serverCadProjection.ts` is the half
 * that drives the kernel.
 *
 * The kernel ships its own `toSVG` and `toMultiviewSVG` for exactly this, and
 * the layout below is theirs: a grid of equal panels sharing one scale, a
 * label and an XYZ gnomon per panel, the part's size in a footer. They are not
 * used because the build this project pins (occt-wasm 3.6.1) reads the
 * projected points in the wrong frame -- the HLR result comes back in the
 * camera's own 2D coordinates, and that renderer dots them with world axes --
 * so the front and right views collapse to a line and the top view is a mirror
 * image. Upstream corrected it in a later major version; when the kernel is
 * upgraded, this file reduces to naming the views.
 */

import type { Vec3 } from "occt-wasm";

/** The viewpoints the drawing can show, named as the kernel names them. */
export const PROJECTION_VIEWS = ["front", "back", "top", "bottom", "left", "right", "iso"] as const;
export type ProjectionView = (typeof PROJECTION_VIEWS)[number];

/** The default grid: three orthographic views and an isometric. */
export const MULTIVIEW_PANELS: readonly ProjectionView[] = ["front", "top", "right", "iso"];

/** What a drawing shows: one named view, or the grid. */
export const PROJECTION_LAYOUTS = ["multiview", ...PROJECTION_VIEWS] as const;
export type ProjectionLayout = (typeof PROJECTION_LAYOUTS)[number];

/** The layout a request names; the grid when it names none; null when it names nonsense. */
export function parseProjectionLayout(value: unknown): ProjectionLayout | null {
  if (value === undefined) return "multiview";
  return PROJECTION_LAYOUTS.find((layout) => layout === value) ?? null;
}

/**
 * The layout behind a capture `face`.
 *
 * `home` and `current` are what the editor's viewport words mean -- a
 * three-quarter look at everything -- and the grid is the headless answer to
 * that: it shows the isometric and the three faces it is made of. The six
 * face names are the kernel's own.
 */
export function projectionLayoutForCaptureFace(face: unknown): ProjectionLayout {
  const view = PROJECTION_VIEWS.find((candidate) => candidate === face && candidate !== "iso");
  return view ?? "multiview";
}

/**
 * The editor's Y-up frame turned into the Z-up frame a drawing reads in, as
 * OCCT's row-major 3x4 affine rows: `[x, y, z]` becomes `[x, -z, y]`.
 *
 * It is the same turn every file export makes (the STL and 3MF writers apply it
 * per vertex, STEP per solid), so a drawing's "top" is the view down the
 * editor's elevation axis and the footer's X×Y×Z reads as the other exports'
 * coordinates do.
 */
export const EDITOR_TO_DRAWING_TRANSFORM: readonly number[] = [
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
];

/**
 * Where a view's camera stands, in the drawing frame.
 *
 * `toward` points from the part to the camera and `right` is the screen's
 * horizontal; screen-up is their cross product, which is also the frame the
 * kernel hands projected points back in (see `viewUp`). Every orthographic
 * view keeps +Z upward. The isometric stands where the editor's home camera
 * stands -- in front, to the right, and above.
 */
export type ViewBasis = { toward: Vec3; right: Vec3 };

const ISO_TOWARD = unit({ x: 1, y: -1, z: 1 });
const ISO_RIGHT = unit({ x: 1, y: 1, z: 0 });

export function viewBasis(view: ProjectionView): ViewBasis {
  switch (view) {
    case "front": return { toward: { x: 0, y: -1, z: 0 }, right: { x: 1, y: 0, z: 0 } };
    case "back": return { toward: { x: 0, y: 1, z: 0 }, right: { x: -1, y: 0, z: 0 } };
    case "top": return { toward: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 } };
    case "bottom": return { toward: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 } };
    case "right": return { toward: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 1, z: 0 } };
    case "left": return { toward: { x: -1, y: 0, z: 0 }, right: { x: 0, y: -1, z: 0 } };
    case "iso": return { toward: ISO_TOWARD, right: ISO_RIGHT };
  }
}

/** Screen-up for a basis: `toward × right`, the Y axis of OCCT's `gp_Ax2(origin, toward, right)`. */
export function viewUp({ toward, right }: ViewBasis): Vec3 {
  // `0 +` turns a -0 from the arithmetic into the 0 it is.
  return {
    x: 0 + (toward.y * right.z - toward.z * right.y),
    y: 0 + (toward.z * right.x - toward.x * right.z),
    z: 0 + (toward.x * right.y - toward.y * right.x),
  };
}

function unit(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// --- the drawing -------------------------------------------------------------

/** A projected edge as `[u0, v0, u1, v1, ...]` in model units, v upward. */
export type DrawingPolyline = number[];

/** One view's worth of projected edges. */
export type ViewDrawing = {
  view: ProjectionView;
  visible: DrawingPolyline[];
  hidden: DrawingPolyline[];
};

export type DrawingOptions = {
  /** Width and height of each panel in px. Each panel is square. */
  panelSize?: number;
  /** Space between the part and the panel edge, in px. */
  padding?: number;
  /** Draw occluded edges dashed. On by default; a laser-cut template wants it off. */
  showHidden?: boolean;
  strokeWidth?: number;
  background?: string;
  visibleColor?: string;
  hiddenColor?: string;
};

export type Drawing = {
  layout: ProjectionLayout;
  panels: ViewDrawing[];
  /** The part's overall extent along X, Y and Z of the drawing frame, for the footer. */
  size?: { x: number; y: number; z: number };
};

const VIEW_LABEL: Record<ProjectionView, string> = {
  front: "Front", back: "Back", top: "Top", bottom: "Bottom", left: "Left", right: "Right", iso: "Iso",
};

const GRID_COLUMNS = 2;
const FOOTER_HEIGHT = 22;

function resolved(options: DrawingOptions) {
  return {
    panelSize: options.panelSize ?? 480,
    padding: options.padding ?? 14,
    showHidden: options.showHidden ?? true,
    strokeWidth: options.strokeWidth ?? 1,
    background: options.background ?? "#ffffff",
    visibleColor: options.visibleColor ?? "#111111",
    hiddenColor: options.hiddenColor ?? "#9aa0a6",
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Extent = { minU: number; maxU: number; minV: number; maxV: number };

function extentOf(panel: ViewDrawing): Extent {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const line of [...panel.visible, ...panel.hidden]) {
    for (let index = 0; index + 1 < line.length; index += 2) {
      minU = Math.min(minU, line[index]);
      maxU = Math.max(maxU, line[index]);
      minV = Math.min(minV, line[index + 1]);
      maxV = Math.max(maxV, line[index + 1]);
    }
  }
  return Number.isFinite(minU) ? { minU, maxU, minV, maxV } : { minU: 0, maxU: 0, minV: 0, maxV: 0 };
}

/** Model units to panel px, centred on the view's own midpoint; v up becomes y down. */
function toPixels(extent: Extent, scale: number, panelSize: number) {
  const offsetX = panelSize / 2 - ((extent.minU + extent.maxU) / 2) * scale;
  const offsetY = panelSize / 2 + ((extent.minV + extent.maxV) / 2) * scale;
  return ([u, v]: [number, number]) => [round(u * scale + offsetX), round(-v * scale + offsetY)] as const;
}

function pathData(lines: DrawingPolyline[], pixel: (point: [number, number]) => readonly [number, number]) {
  let d = "";
  for (const line of lines) {
    for (let index = 0; index + 1 < line.length; index += 2) {
      const [x, y] = pixel([line[index], line[index + 1]]);
      d += `${index === 0 ? "M" : "L"}${x} ${y}`;
    }
  }
  return d;
}

/** The world axes as the view sees them, drawn in the panel's lower-left corner. */
function gnomon(view: ProjectionView, panelSize: number, padding: number) {
  const basis = viewBasis(view);
  const up = viewUp(basis);
  const length = 18;
  const originX = padding + length + 4;
  const originY = panelSize - padding - length - 4;
  const axes: Array<[Vec3, string, string]> = [
    [{ x: 1, y: 0, z: 0 }, "#d33", "X"],
    [{ x: 0, y: 1, z: 0 }, "#3a3", "Y"],
    [{ x: 0, y: 0, z: 1 }, "#36c", "Z"],
  ];
  let svg = "";
  for (const [axis, color, name] of axes) {
    const dx = dot(axis, basis.right);
    const dy = -dot(axis, up);
    if (Math.hypot(dx, dy) < 0.05) continue; // points into the screen
    const endX = round(originX + dx * length);
    const endY = round(originY + dy * length);
    svg += `<line x1="${originX}" y1="${originY}" x2="${endX}" y2="${endY}" stroke="${color}" stroke-width="1.5"/>`;
    svg += `<text x="${endX}" y="${endY}" font-size="9" fill="${color}" text-anchor="middle" dominant-baseline="middle">${name}</text>`;
  }
  return svg;
}

function panelSvg(panel: ViewDrawing, scale: number, options: ReturnType<typeof resolved>, label: string | null) {
  const { panelSize, padding } = options;
  const pixel = toPixels(extentOf(panel), scale, panelSize);
  let body = `<rect x="0.5" y="0.5" width="${panelSize - 1}" height="${panelSize - 1}" fill="${options.background}" stroke="#e0e0e0"/>`;
  if (options.showHidden) {
    const d = pathData(panel.hidden, pixel);
    if (d) body += `<path d="${d}" fill="none" stroke="${options.hiddenColor}" stroke-width="${options.strokeWidth}" stroke-dasharray="3 2"/>`;
  }
  const d = pathData(panel.visible, pixel);
  if (d) body += `<path d="${d}" fill="none" stroke="${options.visibleColor}" stroke-width="${options.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;
  body += gnomon(panel.view, panelSize, padding);
  if (label !== null) {
    body += `<text x="${padding}" y="${padding + 4}" font-size="11" fill="#333" font-family="sans-serif">${escapeXml(label)}</text>`;
  }
  return body;
}

/**
 * The drawing as a standalone SVG document.
 *
 * Every panel shares one scale, so the part is the same size in each and the
 * views read against each other. A single named view is one panel with no
 * label and no footer.
 */
export function renderDrawingSvg(drawing: Drawing, options: DrawingOptions = {}): string {
  const o = resolved(options);
  const grid = drawing.layout === "multiview";
  const inner = o.panelSize - 2 * o.padding;
  let range = 1e-9;
  for (const panel of drawing.panels) {
    const extent = extentOf(panel);
    range = Math.max(range, extent.maxU - extent.minU, extent.maxV - extent.minV);
  }
  const scale = inner / range;

  const columns = grid ? GRID_COLUMNS : 1;
  const rows = Math.ceil(drawing.panels.length / columns);
  const footer = grid && drawing.size ? FOOTER_HEIGHT : 0;
  const width = columns * o.panelSize;
  const height = rows * o.panelSize + footer;

  let panels = "";
  drawing.panels.forEach((panel, index) => {
    const x = (index % columns) * o.panelSize;
    const y = Math.floor(index / columns) * o.panelSize;
    const body = panelSvg(panel, scale, o, grid ? VIEW_LABEL[panel.view] : null);
    panels += grid ? `<g transform="translate(${x} ${y})">${body}</g>` : body;
  });

  let footerSvg = "";
  if (footer && drawing.size) {
    const text = `${round(drawing.size.x)} × ${round(drawing.size.y)} × ${round(drawing.size.z)} (X×Y×Z)`;
    footerSvg = `<text x="${width / 2}" y="${rows * o.panelSize + 15}" font-size="11" fill="#444" font-family="sans-serif" text-anchor="middle">${escapeXml(text)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${o.background}"/>${panels}${footerSvg}</svg>`;
}
