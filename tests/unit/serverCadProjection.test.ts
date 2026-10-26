import manifoldModule from "manifold-3d";
import { parseRevolveRequest, revolvedShapeFromRequest } from "@constructorfleet/sketchforge-engine/revolveRequests";
import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { projectShapesToSvg } from "@constructorfleet/sketchforge-engine/serverCadProjection";
import { ServerCadError } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { exportProjectScene } from "@constructorfleet/sketchforge-engine/sceneExport";
import { groupedShapeFromSelection, meshShapeFromWorldPositions } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
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

describe("exact projections of plain revolves (#542)", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it.each([false, true])("draws the curved rim when legacy=%s", async (legacy) => {
    const runtime = await manifoldModule();
    runtime.setup();
    const request = parseRevolveRequest({ profile: [[5, 0], [10, 0], [10, 8], [5, 8]], sides: 3, sweepAngle: 90 });
    if (!request.ok) throw new Error(request.error);
    const quarter = revolvedShapeFromRequest(runtime, request, { x: 20, z: -10 });
    const svg = await projectShapesToSvg([{ ...quarter, revolveAxisOffset: legacy ? undefined : quarter.revolveAxisOffset }], { view: "top", panelSize: 400 });
    // Three sweep segments leave a visibly polygonal quarter rim.
    // The exact rim must include intermediate curve samples in the SVG.
    const points = new Set(visiblePoints(svg).map(([x, y]) => `${x},${y}`));
    expect(points.size).toBeGreaterThan(12);
    const vertices = visiblePoints(svg);
    const axisX = Math.min(...vertices.map(([x]) => x));
    const axisY = Math.max(...vertices.map(([, y]) => y));
    const radius = Math.max(...vertices.map(([x]) => x)) - axisX;
    for (const [x, y] of vertices) {
      const distance = Math.hypot(x - axisX, y - axisY);
      expect(Math.min(Math.abs(distance - radius), Math.abs(distance - radius / 2)) / radius).toBeLessThan(0.001);
    }
  });
});

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
    // OCCT 5 emits 30 points for the current cylinder tessellation; retain a
    // meaningful minimum while the radial check below guards roundness.
    expect(rim.length).toBeGreaterThanOrEqual(24);
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

// --- mesh shapes (#506) ------------------------------------------------------

type Point3 = [number, number, number];

/** Triangles wound outward, as a flat editor-frame (Y-up) position list. */
function soup(triangles: Array<[Point3, Point3, Point3]>) {
  return triangles.flatMap((triangle) => triangle.flat());
}

/** A closed cylinder of `segments` sides standing on the workplane, caps as fans. */
function cylinderSoup(radius: number, height: number, segments: number, centre: Point3 = [0, 0, 0]) {
  const [cx, cy, cz] = centre;
  const ring = (y: number) => Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return [cx + radius * Math.cos(angle), cy + y, cz + radius * Math.sin(angle)] as Point3;
  });
  const bottom = ring(0);
  const top = ring(height);
  const triangles: Array<[Point3, Point3, Point3]> = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    triangles.push([bottom[index], top[index], top[next]], [bottom[index], top[next], bottom[next]]);
    triangles.push([[cx, cy + height, cz], top[next], top[index]]);
    triangles.push([[cx, cy, cz], bottom[index], bottom[next]]);
  }
  return soup(triangles);
}

/** An axis-aligned box from `min` to `max`, two triangles per face. */
function boxSoup(min: Point3, max: Point3) {
  const corner = (i: number): Point3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return soup(quads.flatMap(([a, b, c, d]) => [
    [corner(a), corner(b), corner(c)],
    [corner(a), corner(c), corner(d)],
  ] as Array<[Point3, Point3, Point3]>));
}

function meshShape(positions: number[], id = "mesh") {
  const built = meshShapeFromWorldPositions(positions, { id, name: id, color: "#888888" });
  if (!built) throw new Error("mesh shape was not built");
  return built;
}

/** Every vertex of the dashed (hidden) edge paths. */
function hiddenPoints(svg: string) {
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#9aa0a6"/g)].map((match) => match[1]);
  return paths.flatMap((d) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])] as const));
}

/** How many separate strokes a path colour draws. */
function strokeCount(svg: string, colour: string) {
  const paths = [...svg.matchAll(new RegExp(`<path d="([^"]+)" fill="none" stroke="${colour}"`, "g"))].map((match) => match[1]);
  return paths.reduce((sum, d) => sum + (d.match(/M/g)?.length ?? 0), 0);
}

/** The midpoint of every straight run of the solid (visible) edge paths. */
function visibleMidpoints(svg: string) {
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#111111"/g)].map((match) => match[1]);
  const midpoints: Array<readonly [number, number]> = [];
  for (const d of paths) {
    let previous: [number, number] | null = null;
    for (const match of d.matchAll(/([ML])(-?[\d.]+) (-?[\d.]+)/g)) {
      const point: [number, number] = [Number(match[2]), Number(match[3])];
      if (match[1] === "L" && previous) midpoints.push([(previous[0] + point[0]) / 2, (previous[1] + point[1]) / 2]);
      previous = point;
    }
  }
  return midpoints;
}

function extent(points: ReadonlyArray<readonly [number, number]>) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe("projecting mesh shapes to SVG by feature edges", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("leaves a flat cap's triangle fan out of the drawing, keeping its rim", async () => {
    const svg = await projectShapesToSvg([meshShape(cylinderSoup(15, 12, 64))], { view: "top", panelSize: 400 });

    const points = visiblePoints(svg);
    const box = extent(points);
    const centre = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
    const outer = (box.maxX - box.minX) / 2;
    const radii = points.map(([x, y]) => Math.hypot(x - centre[0], y - centre[1]));
    // Every one of the 64 spokes runs through the centre; a feature-edge
    // drawing has none of them, only the rim where the cap meets the wall.
    expect(Math.min(...radii)).toBeGreaterThan(outer * 0.9);
  });

  it("draws a faceted wall by its silhouette, not by its seams", async () => {
    const svg = await projectShapesToSvg([meshShape(cylinderSoup(15, 12, 64))], { view: "front", panelSize: 400 });

    const points = visiblePoints(svg);
    const box = extent(points);
    const midX = (box.minX + box.maxX) / 2;
    const halfWidth = (box.maxX - box.minX) / 2;
    // A seam in the middle of the wall is a vertical stroke whose midpoint is
    // well inside the outline, on neither the top rim nor the bottom one.
    const interior = visibleMidpoints(svg).filter(([x, y]) => Math.abs(x - midX) < halfWidth * 0.8 && y > box.minY + 1 && y < box.maxY - 1);
    expect(interior).toEqual([]);
    // ...and the outline is still there: a vertical stroke down each side.
    const side = (x: number) => visibleMidpoints(svg).some(([mx, my]) => Math.abs(mx - x) < 1 && my > box.minY + 1 && my < box.maxY - 1);
    expect(side(box.minX) && side(box.maxX)).toBe(true);
  });

  it("brings the seams back when featureAngle is below the facet angle", async () => {
    // 64 sides meet at 5.625 degrees, so a 3 degree crease angle draws them.
    const svg = await projectShapesToSvg([meshShape(cylinderSoup(15, 12, 64))], { view: "front", panelSize: 400, featureAngle: 3 });
    const top = await projectShapesToSvg([meshShape(cylinderSoup(15, 12, 64))], { view: "top", panelSize: 400, featureAngle: 3 });

    const points = visiblePoints(svg);
    const box = extent(points);
    const midX = (box.minX + box.maxX) / 2;
    const halfWidth = (box.maxX - box.minX) / 2;
    expect(visibleMidpoints(svg).some(([x, y]) => Math.abs(x - midX) < halfWidth * 0.5 && y > box.minY + 1 && y < box.maxY - 1)).toBe(true);
    // The fan's spokes are coplanar, so no crease angle above zero draws them.
    const topPoints = visiblePoints(top);
    const topBox = extent(topPoints);
    const centre = [(topBox.minX + topBox.maxX) / 2, (topBox.minY + topBox.maxY) / 2];
    expect(Math.min(...topPoints.map(([x, y]) => Math.hypot(x - centre[0], y - centre[1])))).toBeGreaterThan((topBox.maxX - topBox.minX) * 0.45);
  });

  it("draws a triangulated cube as twelve edges, the three behind it dashed", async () => {
    const svg = await projectShapesToSvg([meshShape(boxSoup([-5, 0, -5], [5, 10, 5]))], { view: "iso", panelSize: 400 });

    expect(strokeCount(svg, "#111111")).toBe(9);
    expect(strokeCount(svg, "#9aa0a6")).toBe(3);
  });

  it("hides a mesh behind an exact solid", async () => {
    // The camera of the front view stands on the editor's +Z side.
    const svg = await projectShapesToSvg([
      shape({ kind: "box", width: 40, depth: 4, height: 40, z: 20 }),
      meshShape(boxSoup([-5, 15, -25], [5, 25, -15]), "behind"),
    ], { view: "front", panelSize: 400 });

    const visible = visiblePoints(svg);
    const box = extent(visible);
    const onOutline = ([x, y]: readonly [number, number]) => Math.min(Math.abs(x - box.minX), Math.abs(x - box.maxX), Math.abs(y - box.minY), Math.abs(y - box.maxY)) < 1;
    expect(visible.every(onOutline)).toBe(true);
    expect(hiddenPoints(svg).some((point) => !onOutline(point))).toBe(true);
  });

  it("hides an exact solid behind a mesh", async () => {
    const svg = await projectShapesToSvg([
      meshShape(boxSoup([-20, 0, 18], [20, 40, 22]), "front-plate"),
      shape({ kind: "box", width: 10, depth: 10, height: 10, elevation: 15, z: -20 }),
    ], { view: "front", panelSize: 400 });

    const visible = visiblePoints(svg);
    const box = extent(visible);
    const onOutline = ([x, y]: readonly [number, number]) => Math.min(Math.abs(x - box.minX), Math.abs(x - box.maxX), Math.abs(y - box.minY), Math.abs(y - box.maxY)) < 1;
    expect(visible.every(onOutline)).toBe(true);
    expect(hiddenPoints(svg).some((point) => !onOutline(point))).toBe(true);
  });

  it("places a mesh on the same side as the kernel places an exact solid", async () => {
    // A short exact box on -X and a tall mesh box on +X: in the front view the
    // tall outline has to be on the right, or the mesh frame is mirrored in u.
    const svg = await projectShapesToSvg([
      shape({ kind: "box", width: 10, depth: 10, height: 10, x: -20 }),
      meshShape(boxSoup([15, 0, -5], [25, 30, 5]), "tall"),
    ], { view: "front", panelSize: 400 });

    const visible = visiblePoints(svg);
    const box = extent(visible);
    const midX = (box.minX + box.maxX) / 2;
    const top = visible.filter(([, y]) => Math.abs(y - box.minY) < 1);
    expect(top.length).toBeGreaterThan(0);
    expect(top.every(([x]) => x > midX)).toBe(true);
  });

  it("draws a mesh inside a group of solids by its feature edges too", async () => {
    const cylinder = meshShape(cylinderSoup(15, 12, 64));
    const block = shape({ kind: "box", width: 10, depth: 10, height: 10, x: 40 });
    const group = groupedShapeFromSelection([cylinder, block]);
    if (!group) throw new Error("group was not built");

    const grouped = await projectShapesToSvg([group], { view: "top", panelSize: 400 });
    const loose = await projectShapesToSvg([cylinder, block], { view: "top", panelSize: 400 });

    // The cylinder is the left part of the drawing; none of its 64 cap spokes
    // may reach in towards its centre.
    const points = visiblePoints(grouped);
    const box = extent(points);
    const scale = (box.maxX - box.minX) / 60;
    const centre = [box.minX + 15 * scale, (box.minY + box.maxY) / 2];
    const radii = points.map(([x, y]) => Math.hypot(x - centre[0], y - centre[1]));
    expect(Math.min(...radii)).toBeGreaterThan(15 * scale * 0.9);
    expect(strokeCount(grouped, "#111111")).toBe(strokeCount(loose, "#111111"));
  });

  it("refuses a feature angle outside 0 to 180 degrees", async () => {
    await expect(projectShapesToSvg([meshShape(boxSoup([0, 0, 0], [1, 1, 1]))], { featureAngle: 181 })).rejects.toBeInstanceOf(ServerCadError);
    await expect(projectShapesToSvg([meshShape(boxSoup([0, 0, 0], [1, 1, 1]))], { featureAngle: Number.NaN })).rejects.toThrow(/featureAngle/);
  });

  it("passes featureAngle through a project's SVG export", async () => {
    const document = { projectName: "Mesh", shapes: [meshShape(cylinderSoup(15, 12, 64))] } as unknown as Parameters<typeof exportProjectScene>[0];
    const draw = async (featureAngle?: number) => Buffer.from((await exportProjectScene(document, { format: "svg", view: "front", ...(featureAngle === undefined ? {} : { featureAngle }) })).data).toString("utf8");

    expect(strokeCount(await draw(3), "#111111")).toBeGreaterThan(strokeCount(await draw(), "#111111") + 20);
    await expect(exportProjectScene(document, { format: "stl", featureAngle: 10 })).rejects.toThrow(/featureAngle/);
  });
});
