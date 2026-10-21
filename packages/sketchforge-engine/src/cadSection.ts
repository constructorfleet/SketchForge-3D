/** The three named axis-aligned section planes in drawing coordinates. */
export const SECTION_PLANES = ["xy", "xz", "yz"] as const;
export type SectionPlane = (typeof SECTION_PLANES)[number];

export type SectionDrawing = {
  plane: SectionPlane;
  offset: number;
  /** Section contours in model units as [u0, v0, u1, v1, ...]. */
  contours: number[][];
};

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function pathData(contours: readonly number[][]) {
  return contours.map((contour) => {
    let path = "";
    for (let index = 0; index + 1 < contour.length; index += 2) {
      path += `${index === 0 ? "M" : "L"}${round(contour[index])} ${round(contour[index + 1])}`;
    }
    return path;
  }).join("");
}

/** Render exact-kernel section edges as a scale-readable, millimetre SVG. */
export function renderSectionSvg(drawing: SectionDrawing, bounds: { minU: number; maxU: number; minV: number; maxV: number }) {
  const padding = Math.max(1, Math.max(bounds.maxU - bounds.minU, bounds.maxV - bounds.minV) * 0.03);
  const minU = bounds.minU - padding;
  const minV = -bounds.maxV - padding;
  const width = Math.max(2, bounds.maxU - bounds.minU + 2 * padding);
  const height = Math.max(2, bounds.maxV - bounds.minV + 2 * padding);
  const d = pathData(drawing.contours);
  if (!d) throw new Error("The section plane produced no contours.");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}mm" height="${round(height)}mm" viewBox="${round(minU)} ${round(minV)} ${round(width)} ${round(height)}" data-plane="${drawing.plane}" data-offset="${round(drawing.offset)}"><g transform="scale(1 -1)"><path d="${escapeXml(d)}" fill="none" stroke="#111111" stroke-width="0.2" stroke-linejoin="round" stroke-linecap="round"/></g></svg>`;
}
