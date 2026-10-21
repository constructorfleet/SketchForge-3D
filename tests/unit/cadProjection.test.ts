import { describe, expect, it } from "vitest";
import {
  EDITOR_TO_DRAWING_TRANSFORM,
  MULTIVIEW_PANELS,
  PROJECTION_LAYOUTS,
  PROJECTION_VIEWS,
  parseProjectionLayout,
  projectionLayoutForCaptureFace,
  renderDrawingSvg,
  viewBasis,
  viewUp,
  type ViewDrawing,
} from "@constructorfleet/sketchforge-engine/cadProjection";

/** Apply OCCT's row-major 3x4 affine rows to a point. */
function apply(matrix: readonly number[], [x, y, z]: [number, number, number]) {
  return [0, 1, 2].map((row) => matrix[row * 4] * x + matrix[row * 4 + 1] * y + matrix[row * 4 + 2] * z + matrix[row * 4 + 3]);
}

describe("projection views", () => {
  it("names the kernel's seven viewpoints and the grid as layouts", () => {
    expect(PROJECTION_VIEWS).toEqual(["front", "back", "top", "bottom", "left", "right", "iso"]);
    expect(PROJECTION_LAYOUTS).toEqual(["multiview", ...PROJECTION_VIEWS]);
    expect(MULTIVIEW_PANELS).toEqual(["front", "top", "right", "iso"]);
  });

  it("parses a layout and refuses anything else", () => {
    expect(parseProjectionLayout("top")).toBe("top");
    expect(parseProjectionLayout("multiview")).toBe("multiview");
    expect(parseProjectionLayout(undefined)).toBe("multiview");
    expect(parseProjectionLayout("sideways")).toBeNull();
    expect(parseProjectionLayout(3)).toBeNull();
    expect(parseProjectionLayout("")).toBeNull();
  });

  it("maps the capture tool's faces onto layouts, with the grid for the home view", () => {
    expect(projectionLayoutForCaptureFace("home")).toBe("multiview");
    expect(projectionLayoutForCaptureFace("current")).toBe("multiview");
    expect(projectionLayoutForCaptureFace(undefined)).toBe("multiview");
    expect(projectionLayoutForCaptureFace("top")).toBe("top");
    expect(projectionLayoutForCaptureFace("left")).toBe("left");
    expect(projectionLayoutForCaptureFace("nonsense")).toBe("multiview");
  });

  it("turns the editor's Y-up frame into the drawing's Z-up frame the way the STL export does", () => {
    // The STL writer maps [x, y, z] to [x, -z, y]; the kernel's named views
    // assume that Z-up frame, so the solid is turned the same way before
    // projecting and "top" means the same thing in both.
    expect(apply(EDITOR_TO_DRAWING_TRANSFORM, [1, 0, 0])).toEqual([1, 0, 0]);
    expect(apply(EDITOR_TO_DRAWING_TRANSFORM, [0, 1, 0])).toEqual([0, 0, 1]);
    expect(apply(EDITOR_TO_DRAWING_TRANSFORM, [0, 0, 1])).toEqual([0, -1, 0]);
  });

  it("stands every orthographic camera with Z upward and the isometric where the editor's home view is", () => {
    for (const view of ["front", "back", "left", "right"] as const) {
      expect(viewUp(viewBasis(view))).toEqual({ x: 0, y: 0, z: 1 });
    }
    expect(viewUp(viewBasis("top"))).toEqual({ x: 0, y: 1, z: 0 });
    // Front looks at the -Y face with +X to the right; right looks at the +X
    // face with +Y to the right, so the two share their vertical and a part
    // reads across the pair.
    expect(viewBasis("front")).toEqual({ toward: { x: 0, y: -1, z: 0 }, right: { x: 1, y: 0, z: 0 } });
    expect(viewBasis("right")).toEqual({ toward: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 1, z: 0 } });
    const iso = viewBasis("iso");
    expect(iso.toward.x).toBeGreaterThan(0);
    expect(iso.toward.y).toBeLessThan(0);
    expect(iso.toward.z).toBeGreaterThan(0);
    expect(viewUp(iso).z).toBeGreaterThan(0);
  });
});

/** A 20 x 10 rectangle as a closed polyline, the way `wireframe` samples a box's top. */
function rectangle(width: number, height: number): number[] {
  return [0, 0, width, 0, width, height, 0, height, 0, 0];
}

function panel(view: ViewDrawing["view"], visible: number[][], hidden: number[][] = []): ViewDrawing {
  return { view, visible, hidden };
}

describe("rendering a drawing", () => {
  it("lays the grid out two panels wide with a label each and the size in a footer", () => {
    const svg = renderDrawingSvg({
      layout: "multiview",
      size: { x: 20, y: 10, z: 4 },
      panels: [
        panel("front", [rectangle(20, 4)]),
        panel("top", [rectangle(20, 10)]),
        panel("right", [rectangle(10, 4)]),
        panel("iso", [rectangle(24, 12)]),
      ],
    }, { panelSize: 200 });

    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="400" height="422" viewBox="0 0 400 422">/);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect([...svg.matchAll(/<g transform="translate\((\d+) (\d+)\)">/g)].map((match) => [match[1], match[2]]))
      .toEqual([["0", "0"], ["200", "0"], ["0", "200"], ["200", "200"]]);
    for (const label of ["Front", "Top", "Right", "Iso"]) expect(svg).toContain(`>${label}</text>`);
    expect(svg).toContain(">20 × 10 × 4 (X×Y×Z)</text>");
  });

  it("scales every panel alike, so the part is the same size in each view", () => {
    const svg = renderDrawingSvg({
      layout: "multiview",
      panels: [panel("front", [rectangle(20, 4)]), panel("top", [rectangle(20, 10)])],
    }, { panelSize: 200, padding: 10 });

    // The widest view spans the panel's inner 180px, so 20 units is 180px in
    // every panel and the 4-unit front face is 36px tall.
    const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#111111"/g)].map((match) => match[1]);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("M10 118L190 118L190 82L10 82L10 118");
    expect(paths[1]).toBe("M10 145L190 145L190 55L10 55L10 145");
  });

  it("draws a single view as one unlabelled panel, hidden edges dashed unless told not to", () => {
    const drawing = { layout: "top" as const, panels: [panel("top", [rectangle(20, 10)], [[2, 2, 18, 8]])] };

    const dashed = renderDrawingSvg(drawing, { panelSize: 300 });
    expect(dashed).toMatch(/^<svg [^>]*width="300" height="300"/);
    expect(dashed).not.toContain("<g transform");
    expect(dashed).not.toContain(">Top</text>");
    expect(dashed).toContain('stroke-dasharray="3 2"');

    const outline = renderDrawingSvg(drawing, { panelSize: 300, showHidden: false });
    expect(outline).not.toContain("stroke-dasharray");
  });

  it("draws world +Y upward in the top view and +Z upward in the front view", () => {
    // A polyline rising in v must land higher on the page (smaller y), and the
    // gnomon says which world axis that is.
    const top = renderDrawingSvg({ layout: "top", panels: [panel("top", [[0, 0, 0, 10]])] }, { panelSize: 100, padding: 10 });
    expect(top).toContain('<path d="M50 90L50 10"');
    expect(top).toMatch(/<line [^>]*x2="32" y2="50" stroke="#3a3"/); // Y up
    const front = renderDrawingSvg({ layout: "front", panels: [panel("front", [[0, 0, 0, 10]])] }, { panelSize: 100, padding: 10 });
    expect(front).toMatch(/<line [^>]*x2="32" y2="50" stroke="#36c"/); // Z up
    expect(front).not.toContain('stroke="#3a3"'); // Y points into the page
  });

  it("escapes nothing it did not write and copes with an empty view", () => {
    const svg = renderDrawingSvg({ layout: "multiview", panels: [panel("front", []), panel("top", [])], size: { x: 0, y: 0, z: 0 } });
    expect(svg).toContain(">0 × 0 × 0 (X×Y×Z)</text>");
    expect(svg).not.toContain("<path");
  });
});
