import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { importedShapeFromTriangleSoup } from "@constructorfleet/sketchforge-engine/stlImport";
import { sectionShapesToDxf, sectionShapesToSvg } from "@constructorfleet/sketchforge-engine/serverCadSection";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(request: Record<string, unknown>) {
  return shapeFromRequest(request) as WorkplaneShape;
}

/** A closed, subdivided box as an imported triangle soup with the given number of segments per side. */
function denseBoxMesh(width: number, height: number, depth: number, segments: [number, number, number]) {
  const indexed = new THREE.BoxGeometry(width, height, depth, ...segments);
  const geometry = indexed.toNonIndexed();
  const positions = Array.from(geometry.getAttribute("position").array);
  indexed.dispose();
  geometry.dispose();
  return importedShapeFromTriangleSoup("dense-box.stl", positions, undefined) as WorkplaneShape;
}

/**
 * The SVG's closed loops as lists of [u, v] points, in drawing coordinates.
 *
 * The exact kernel returns one subpath per section edge, so subpaths that meet
 * end to end are joined before anything is measured.
 */
function svgLoops(svg: string) {
  const d = svg.match(/ d="([^"]+)"/)?.[1] ?? "";
  const pieces = d.split("M").filter(Boolean).map((subpath) => [...("M" + subpath).matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
    .map((match) => [Number(match[1]), Number(match[2])] as [number, number]));
  const same = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-2;
  const loops: [number, number][][] = [];
  while (pieces.length) {
    const loop = pieces.shift()!;
    for (let joined = true; joined && !same(loop[0], loop[loop.length - 1]);) {
      joined = false;
      for (let index = 0; index < pieces.length; index += 1) {
        const piece = pieces[index];
        const end = loop[loop.length - 1];
        if (same(piece[0], end)) loop.push(...piece.slice(1));
        else if (same(piece[piece.length - 1], end)) loop.push(...piece.reverse().slice(1));
        else continue;
        pieces.splice(index, 1);
        joined = true;
        break;
      }
    }
    if (same(loop[0], loop[loop.length - 1])) loop.pop();
    loops.push(loop);
  }
  return loops;
}

/** Absolute enclosed area and centroid of one closed loop, by the shoelace formula. */
function loopAreaAndCentroid(points: [number, number][]) {
  let twiceArea = 0;
  let cu = 0;
  let cv = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [u0, v0] = points[index];
    const [u1, v1] = points[(index + 1) % points.length];
    const cross = u0 * v1 - u1 * v0;
    twiceArea += cross;
    cu += (u0 + u1) * cross;
    cv += (v0 + v1) * cross;
  }
  return { area: Math.abs(twiceArea / 2), centroid: [cu / (3 * twiceArea), cv / (3 * twiceArea)] as [number, number] };
}

describe("section drawings of meshes above the old 50,000-triangle cap", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("slices a 62,400-triangle mesh where it stands", async () => {
    const mesh = denseBoxMesh(10, 10, 6, [60, 100, 60]);
    expect(mesh.importedMesh?.triangleCount).toBe(62_400);
    // Off-centre and turned, so a misplaced, mirrored, or unrotated slice is visible in the centroid and area.
    const placed: WorkplaneShape = { ...mesh, x: 7, z: 3, rotation: 30 };
    // How fast is the perf lane's business (tests/perf/kernel-operations.perf.ts).
    const svg = await sectionShapesToSvg([placed], { plane: "xy", offset: 5 });
    const loops = svgLoops(svg);
    expect(loops).toHaveLength(1);
    const { area, centroid } = loopAreaAndCentroid(loops[0]);
    // The SVG rounds each turned corner to a micrometre, which is all the area misses by.
    expect(area).toBeCloseTo(60, 2);
    // Drawing frame: u = editor x, v = -editor z.
    expect(centroid[0]).toBeCloseTo(7, 3);
    expect(centroid[1]).toBeCloseTo(-3, 3);
  });

  it.each([0, 10])("draws a mesh's outline when the plane lies on its end face at %s", async (offset) => {
    const mesh: WorkplaneShape = { ...denseBoxMesh(10, 10, 6, [5, 5, 3]), x: -4 };
    const loops = svgLoops(await sectionShapesToSvg([mesh], { plane: "xy", offset }));
    expect(loops).toHaveLength(1);
    const { area, centroid } = loopAreaAndCentroid(loops[0]);
    expect(area).toBeCloseTo(60, 3);
    expect(centroid[0]).toBeCloseTo(-4, 3);
    expect(centroid[1]).toBeCloseTo(0, 3);
  });

  it("draws both outlines where the plane lies on a downward face inside the mesh", async () => {
    // A T profile extruded 2 deep: a 2-wide stem from 0 to 5 under a 6-wide
    // cap from 5 to 7. The cap's underside lies on the plane at 5, and the
    // exact kernel draws its edges there as well as the stem's.
    const profile = new THREE.Shape([
      new THREE.Vector2(-1, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 5), new THREE.Vector2(3, 5),
      new THREE.Vector2(3, 7), new THREE.Vector2(-3, 7), new THREE.Vector2(-3, 5), new THREE.Vector2(-1, 5),
    ]);
    const extruded = new THREE.ExtrudeGeometry(profile, { depth: 2, bevelEnabled: false });
    const soup = extruded.index ? extruded.toNonIndexed() : extruded;
    const tee = importedShapeFromTriangleSoup("tee.stl", Array.from(soup.getAttribute("position").array), undefined) as WorkplaneShape;
    extruded.dispose();
    const placed: WorkplaneShape = { ...tee, x: 5, z: -2 };
    const measured = (offset: number) => sectionShapesToSvg([placed], { plane: "xy", offset })
      .then((svg) => svgLoops(svg).map(loopAreaAndCentroid).sort((left, right) => left.area - right.area));

    const onFace = await measured(5);
    expect(onFace).toHaveLength(2);
    expect(onFace[0].area).toBeCloseTo(4, 3);
    expect(onFace[1].area).toBeCloseTo(12, 3);
    for (const loop of onFace) {
      expect(loop.centroid[0]).toBeCloseTo(5, 3);
      expect(loop.centroid[1]).toBeCloseTo(2, 3);
    }
    // Off the face, each side is the one body it cuts.
    expect((await measured(4.9)).map((loop) => Number(loop.area.toFixed(3)))).toEqual([4]);
    expect((await measured(5.1)).map((loop) => Number(loop.area.toFixed(3)))).toEqual([12]);
  });

  it("draws a body resting on the plane beside one the plane crosses, in one mesh", async () => {
    // Two 2x2x2 cubes in one STL: one from height 1 to 3 at x = -5, one from 0 to 2 at x = 5.
    const cube = (x: number, y: number) => {
      const box = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
      box.translate(x, y, 0);
      const positions = Array.from(box.getAttribute("position").array);
      box.dispose();
      return positions;
    };
    const pair = importedShapeFromTriangleSoup("pair.stl", [...cube(-5, 2), ...cube(5, 1)], undefined) as WorkplaneShape;
    const measured = svgLoops(await sectionShapesToSvg([pair], { plane: "xy", offset: 1 })).map(loopAreaAndCentroid)
      .sort((left, right) => left.centroid[0] - right.centroid[0]);
    expect(measured).toHaveLength(2);
    expect(measured[0].area).toBeCloseTo(4, 3);
    expect(measured[0].centroid[0]).toBeCloseTo(-5, 3);
    expect(measured[1].area).toBeCloseTo(4, 3);
    expect(measured[1].centroid[0]).toBeCloseTo(5, 3);
  });

  it("interpolates where the plane crosses a sloped wall", async () => {
    // A square frustum: circumradius 6 at the base, 2 at the top, 10 tall. At
    // height 2.5 the circumradius is 5, so the square section is 2 * 5^2.
    const frustum = new THREE.CylinderGeometry(2, 6, 10, 4, 1);
    const soup = frustum.toNonIndexed();
    const mesh = importedShapeFromTriangleSoup("frustum.stl", Array.from(soup.getAttribute("position").array), undefined) as WorkplaneShape;
    frustum.dispose();
    soup.dispose();
    const loops = svgLoops(await sectionShapesToSvg([{ ...mesh, x: 3, z: -2 }], { plane: "xy", offset: 2.5 }));
    expect(loops).toHaveLength(1);
    const { area, centroid } = loopAreaAndCentroid(loops[0]);
    expect(area).toBeCloseTo(50, 2);
    expect(centroid[0]).toBeCloseTo(3, 3);
    expect(centroid[1]).toBeCloseTo(2, 3);
  });

  it("sections a mesh beside an exact solid, each by its own path, in one drawing", async () => {
    const mesh: WorkplaneShape = { ...denseBoxMesh(4, 10, 4, [4, 10, 4]), x: 20 };
    const svg = await sectionShapesToSvg(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 }), mesh],
      { plane: "xy", offset: 2 },
    );
    const measured = svgLoops(svg).map(loopAreaAndCentroid).sort((left, right) => left.area - right.area);
    expect(measured).toHaveLength(2);
    expect(measured[0].area).toBeCloseTo(16, 3);
    expect(measured[0].centroid[0]).toBeCloseTo(20, 3);
    expect(measured[0].centroid[1]).toBeCloseTo(0, 3);
    expect(measured[1].area).toBeCloseTo(200, 3);
    expect(measured[1].centroid[0]).toBeCloseTo(0, 3);
  });

  it("keeps a mesh's through-hole as its own contour", async () => {
    const outer = new THREE.Shape([new THREE.Vector2(-10, -10), new THREE.Vector2(10, -10), new THREE.Vector2(10, 10), new THREE.Vector2(-10, 10)]);
    outer.holes.push(new THREE.Path([new THREE.Vector2(2, -3), new THREE.Vector2(2, 3), new THREE.Vector2(6, 3), new THREE.Vector2(6, -3)]));
    const extruded = new THREE.ExtrudeGeometry(outer, { depth: 5, bevelEnabled: false });
    extruded.rotateX(-Math.PI / 2);
    const soup = extruded.index ? extruded.toNonIndexed() : extruded;
    const plate = importedShapeFromTriangleSoup("plate.stl", Array.from(soup.getAttribute("position").array), undefined) as WorkplaneShape;
    extruded.dispose();
    const loops = svgLoops(await sectionShapesToSvg([plate], { plane: "xy", offset: 2.5 })).map(loopAreaAndCentroid)
      .sort((left, right) => left.area - right.area);
    expect(loops).toHaveLength(2);
    expect(loops[0].area).toBeCloseTo(24, 3);
    expect(loops[1].area).toBeCloseTo(400, 3);
    // The hole sits at +4 in shape x and, after rotateX(-90deg), at -0 in z: centred on the plate's own centre.
    expect(loops[0].centroid[0]).toBeCloseTo(4, 3);
    expect(loops[0].centroid[1]).toBeCloseTo(0, 3);
  });
});

describe("section drawings from stored shapes", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("returns a bounded SVG contour for a named plane through a solid", async () => {
    const svg = await sectionShapesToSvg(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane: "xy", offset: 2 },
    );

    expect(svg).toMatch(/^<svg [^>]*viewBox=/);
    expect(svg).toContain('data-plane="xy"');
    expect(svg).toContain('data-offset="2"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    const coordinates = [...svg.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
      .map((match) => [Number(match[1]), Number(match[2])] as const);
    expect(Math.min(...coordinates.map(([u]) => u))).toBe(-10);
    expect(Math.max(...coordinates.map(([u]) => u))).toBe(10);
    expect(Math.min(...coordinates.map(([, v]) => v))).toBe(-5);
    expect(Math.max(...coordinates.map(([, v]) => v))).toBe(5);
  });

  it("exports the same section contour as millimetre-space DXF polylines", async () => {
    const dxf = await sectionShapesToDxf(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane: "xy", offset: 2 },
    );
    expect(dxf).toContain("LWPOLYLINE");
    expect(dxf).toContain("\n10\n-10\n20\n-5\n");
    expect(dxf).toContain("\n10\n10\n20\n5\n");
    expect(dxf.endsWith("0\nEOF\n")).toBe(true);
  });

  it("refuses a plane that misses the selected scene", async () => {
    await expect(sectionShapesToSvg(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane: "xy", offset: 100 },
    )).rejects.toThrow(/does not intersect/i);
  });

  it.each([
    { plane: "xz" as const, offset: 0, expected: [[-10, 0], [-10, 4], [10, 0], [10, 4]] },
    { plane: "yz" as const, offset: 0, expected: [[-5, 0], [-5, 4], [5, 0], [5, 4]] },
  ])("uses the named $plane plane frame", async ({ plane, offset, expected }) => {
    const svg = await sectionShapesToSvg(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane, offset },
    );
    const coordinates = [...svg.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
      .map((match) => [Number(match[1]), Number(match[2])] as const);
    for (const point of expected) expect(coordinates).toContainEqual(point);
  });

  it("bounds scene size and object count before invoking the kernel", async () => {
    await expect(sectionShapesToSvg(
      [shape({ kind: "box", width: 10_000, depth: 10_000, height: 10_000 })],
      { plane: "xy", offset: 1 },
    )).rejects.toThrow(/maximum section span/i);

    const many = Array.from({ length: 101 }, () => shape({ kind: "box", width: 1, depth: 1, height: 1 }));
    await expect(sectionShapesToSvg(many, { plane: "xy", offset: 0.5 }))
      .rejects.toThrow(/maximum of 100 shapes/i);

    const imported = {
      ...shape({ kind: "box", width: 1, depth: 1, height: 1 }),
      importedMesh: { positions: [], baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 2_000_001, sourceFormat: "stl" as const },
    };
    const refusal = sectionShapesToSvg([imported], { plane: "xy", offset: 0.5 });
    await expect(refusal).rejects.toThrow(/maximum of 2000000 mesh triangles/i);
    // The refusal says what to do about it: one mesh can only be reduced.
    await expect(refusal).rejects.toThrow(/reduce the mesh/i);
    await expect(refusal).rejects.not.toThrow(/shapeIds/);
  });

  it("refuses meshes that are too large together by naming shapeIds", async () => {
    const half = {
      ...shape({ kind: "box", width: 1, depth: 1, height: 1 }),
      importedMesh: { positions: [], baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 1_000_001, sourceFormat: "stl" as const },
    };
    const refusal = sectionShapesToSvg([half, { ...half, id: "other" }], { plane: "xy", offset: 0.5 });
    await expect(refusal).rejects.toThrow(/these have 2000002/);
    await expect(refusal).rejects.toThrow(/shapeIds/);
  });

  it("counts a mesh's stored triangles, not only the count recorded beside them", async () => {
    // A holey array: its length says 2,000,001 triangles without allocating them.
    const imported = {
      ...shape({ kind: "box", width: 1, depth: 1, height: 1 }),
      importedMesh: { positions: new Array<number>(9 * 2_000_001), baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 12, sourceFormat: "stl" as const },
    };
    await expect(sectionShapesToSvg([imported], { plane: "xy", offset: 0.5 })).rejects.toThrow(/maximum of 2000000 mesh triangles/i);
  });
});
