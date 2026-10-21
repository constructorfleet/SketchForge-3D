import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { projectShapesToSvg } from "@constructorfleet/sketchforge-engine/serverCadProjection";
import { ServerCadError } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(request: Record<string, unknown>) {
  return shapeFromRequest(request) as WorkplaneShape;
}

/** The view labels the kernel writes into a multiview grid, in panel order. */
function panelLabels(svg: string) {
  return [...svg.matchAll(/font-size="11" fill="#333" font-family="sans-serif">([A-Za-z]+)<\/text>/g)].map((match) => match[1]);
}

/** Every vertex of the solid (visible) edge paths. */
function visiblePoints(svg: string) {
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#111111"/g)].map((match) => match[1]);
  return paths.flatMap((d) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])] as const));
}

describe("projecting stored shapes to SVG on the server", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("draws the default four-view grid with the part's size in the drawing frame", async () => {
    const svg = await projectShapesToSvg([shape({ kind: "box", width: 20, depth: 10, height: 4 })]);

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(panelLabels(svg)).toEqual(["Front", "Top", "Right", "Iso"]);
    // Width is X, depth is Y and height is Z once the solid is turned into the
    // Z-up frame every file export uses; in the editor's own frame this would
    // read 20 x 4 x 10.
    expect(svg).toContain("20 × 10 × 4 (X×Y×Z)");
  });

  it("draws one named view as a single panel with no label", async () => {
    const svg = await projectShapesToSvg([shape({ kind: "box", width: 20, depth: 10, height: 4 })], { view: "top", panelSize: 300 });

    expect(panelLabels(svg)).toEqual([]);
    expect(svg).toMatch(/^<svg [^>]*width="300" height="300"/);
    // Seen from above a 20 x 10 plate is a rectangle twice as wide as it is
    // tall, which only holds if "top" looks down the editor's elevation axis.
    const points = visiblePoints(svg);
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(width / height).toBeCloseTo(2, 1);
  });

  it("draws a cylinder's silhouette as a circle rather than a polygon", async () => {
    const svg = await projectShapesToSvg([shape({ kind: "cylinder", width: 30, depth: 30, height: 12 })], { view: "top", panelSize: 400 });

    const points = visiblePoints(svg);
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const radii = points.map(([x, y]) => Math.hypot(x - centre[0], y - centre[1]));
    const outer = Math.max(...radii);
    // Everything on the rim sits at one radius. A tessellated cylinder's
    // outline would be a coarse polygon with its corners outside its flats.
    const rim = radii.filter((radius) => radius > outer * 0.5);
    expect(rim.length).toBeGreaterThanOrEqual(32);
    expect((outer - Math.min(...rim)) / outer).toBeLessThan(0.01);
  });

  it("projects every visible solid of a scene into one drawing, leaving hidden shapes and cutters out", async () => {
    const one = await projectShapesToSvg([shape({ kind: "box", width: 10, depth: 10, height: 10 })], { view: "front" });
    const two = await projectShapesToSvg([
      shape({ kind: "box", width: 10, depth: 10, height: 10 }),
      shape({ kind: "box", width: 10, depth: 10, height: 10, x: 30 }),
      { ...shape({ kind: "box", width: 10, depth: 10, height: 10, x: 60 }), hidden: true },
      { ...shape({ kind: "cylinder", width: 4, depth: 4, height: 30 }), hole: true },
    ], { view: "front" });

    const aspect = (svg: string) => {
      const points = visiblePoints(svg);
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      return (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));
    };
    // Each panel is scaled to fit, so the shape of the drawing is the evidence:
    // one cube is square, two cubes 30 apart are four cube-widths wide, and
    // three would be seven.
    expect(aspect(one)).toBeCloseTo(1, 1);
    expect(aspect(two)).toBeCloseTo(4, 1);
  });

  it("refuses a scene with nothing to draw", async () => {
    await expect(projectShapesToSvg([])).rejects.toBeInstanceOf(ServerCadError);
    await expect(projectShapesToSvg([{ ...shape({ kind: "box", width: 1, depth: 1, height: 1 }), hidden: true }]))
      .rejects.toThrow(/nothing|no visible/i);
  });
});
