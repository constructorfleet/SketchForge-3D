import { describe, expect, it } from "vitest";
import { meshDataFromPositions, meshMassProperties, meshShellsOverlap, meshSolidShells } from "@constructorfleet/sketchforge-engine/meshMassProperties";
import { MeshShellsOverlapError } from "@constructorfleet/sketchforge-engine/meshShellOverlap";

type Vec3 = [number, number, number];

/** An axis-aligned box's 12 triangles, outward-wound. */
function boxTriangles(min: Vec3, max: Vec3): number[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces: Vec3[] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ];
  return faces.flatMap((face) => face.flatMap((index) => v[index]));
}

/** A UV sphere about `centre`. */
function sphereTriangles(centre: Vec3, radius: number, segments: number, rings: number): number[] {
  const point = (ring: number, segment: number): Vec3 => {
    const theta = (Math.PI * ring) / rings;
    const phi = (2 * Math.PI * segment) / segments;
    return [
      centre[0] + radius * Math.sin(theta) * Math.cos(phi),
      centre[1] + radius * Math.cos(theta),
      centre[2] + radius * Math.sin(theta) * Math.sin(phi),
    ];
  };
  const out: number[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = point(ring, segment);
      const b = point(ring, segment + 1);
      const c = point(ring + 1, segment);
      const d = point(ring + 1, segment + 1);
      if (ring > 0) out.push(...a, ...b, ...c);
      if (ring < rings - 1) out.push(...b, ...d, ...c);
    }
  }
  return out;
}

/** A box whose every face is split into an n x n grid of quads, so two boxes' faces never share triangles. */
function finelyTessellatedBox(min: Vec3, max: Vec3, n: number): number[] {
  const out: number[] = [];
  const face = (origin: Vec3, u: Vec3, v: Vec3) => {
    const at = (a: number, b: number) => [0, 1, 2].map((k) => origin[k] + (u[k] * a) / n + (v[k] * b) / n);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const [p, q, r, s] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        out.push(...p, ...q, ...r, ...p, ...r, ...s);
      }
    }
  };
  const [x0, y0, z0] = min;
  const [dx, dy, dz] = [max[0] - x0, max[1] - y0, max[2] - z0];
  face([x0, y0, z0], [0, dy, 0], [dx, 0, 0]);
  face([x0, y0, max[2]], [dx, 0, 0], [0, dy, 0]);
  face([x0, y0, z0], [dx, 0, 0], [0, 0, dz]);
  face([x0, max[1], z0], [0, 0, dz], [dx, 0, 0]);
  face([x0, y0, z0], [0, 0, dz], [0, dy, 0]);
  face([max[0], y0, z0], [0, dy, 0], [0, 0, dz]);
  return out;
}

const overlaps = (...shells: number[][]) => meshShellsOverlap(meshDataFromPositions(shells.flat()));

// The overlap test is shared: the mesh measure refuses what it finds (#529),
// and a record-only group's members, measured as one mesh, will need it next (#521).
describe("overlapping closed shells", () => {
  it.each([
    ["one body's corner inside the other", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([5, 5, 5], [15, 15, 15])],
    ["side by side, sharing a slab", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([5, 0, 0], [15, 10, 10])],
    ["crossing bars, no corner inside the other", boxTriangles([-10, -1, -1], [10, 1, 1]), boxTriangles([-1, -10, -0.5], [1, 10, 1.5])],
    ["one body a hair larger than another it nearly fills", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([0.5, 0.5, 0.5], [10.5, 10.5, 10.5])],
  ])("finds bodies that overlap without nesting: %s", (_label, a, b) => {
    expect(overlaps(a, b)).toBe(true);
  });

  it.each([
    ["apart", boxTriangles([0, 0, 0], [1, 1, 1]), boxTriangles([3, 0, 0], [4, 1, 1])],
    ["a void well inside its part", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([2, 2, 2], [8, 8, 8])],
    ["resting on a face, triangulated differently", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([2, 10, 2], [4, 12, 4])],
    ["touching along an edge", boxTriangles([0, 0, 0], [1, 1, 1]), boxTriangles([1, 1, 0], [2, 2, 1])],
    ["touching at a corner", boxTriangles([0, 0, 0], [1, 1, 1]), boxTriangles([1, 1, 1], [2, 2, 2])],
    ["a void sharing three walls of its part", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([2, 2, 2], [10, 10, 10])],
  ])("does not count shells that nest or only touch: %s", (_label, a, b) => {
    expect(overlaps(a, b)).toBe(false);
  });

  it("finds one overlapping pair among many separate bodies", () => {
    const shells: number[][] = [];
    for (let i = 0; i < 10; i += 1) {
      for (let k = 0; k < 10; k += 1) shells.push(boxTriangles([2 * i, 0, 2 * k], [2 * i + 1, 1, 2 * k + 1]));
    }
    expect(overlaps(...shells)).toBe(false);
    shells.push(boxTriangles([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]));
    expect(overlaps(...shells)).toBe(true);
  });

  it("tells finely tessellated bodies resting face to face from ones sharing a slab", () => {
    // Every triangle of the contact face touches the other body; none crosses it.
    const base = finelyTessellatedBox([0, 0, 0], [10, 10, 10], 12);
    const resting = finelyTessellatedBox([0.37, 10, 0.41], [10.37, 20, 10.41], 13);
    const slab = finelyTessellatedBox([5, 0, 0], [15, 10, 10], 13);

    expect(overlaps(base, resting)).toBe(false);
    const union = meshMassProperties(meshDataFromPositions([...base, ...resting]));
    expect(union?.volume).toBeCloseTo(2000, 6);
    // Two equal cubes: the centre of mass lies halfway between their centres.
    expect(union?.centerOfMass.x).toBeCloseTo((5 + 5.37) / 2, 6);
    expect(union?.centerOfMass.y).toBeCloseTo(10, 6);
    expect(union?.centerOfMass.z).toBeCloseTo((5 + 5.41) / 2, 6);
    expect(overlaps(base, slab)).toBe(true);
  });

  it("refuses to measure or assemble overlapping bodies, rather than sum them", () => {
    const mesh = meshDataFromPositions([...boxTriangles([0, 0, 0], [10, 10, 10]), ...boxTriangles([5, 5, 5], [15, 15, 15])]);

    expect(() => meshMassProperties(mesh)).toThrow(MeshShellsOverlapError);
    expect(() => meshSolidShells(mesh)).toThrow(MeshShellsOverlapError);
  });

  it("measures a body resting on another after float32 rounding, at any pose", () => {
    // An STL stores float32 corners: rotated and moved, the resting face of the
    // top block sits a few micrometres above or below the base's top face.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let pose = 0; pose < 100; pose += 1) {
      let [w, x, y, z] = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
      const length = Math.hypot(w, x, y, z);
      [w, x, y, z] = [w / length, x / length, y / length, z / length];
      const rotation = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
      ];
      const offset = [random() * 100, random() * 100, random() * 100];
      const [bx, bz] = [10 + random() * 20, 10 + random() * 20];
      const local = [...boxTriangles([0, 0, 0], [60, 20, 60]), ...boxTriangles([bx, 20, bz], [45, 35, 45])];
      const place = (p: number[]) => [0, 1, 2].map((axis) => offset[axis] + rotation[axis][0] * p[0] + rotation[axis][1] * p[1] + rotation[axis][2] * p[2]);
      const positions: number[] = [];
      for (let at = 0; at < local.length; at += 3) positions.push(...place(local.slice(at, at + 3)).map(Math.fround));

      const baseVolume = 60 * 20 * 60, topVolume = (45 - bx) * 15 * (45 - bz);
      const volume = baseVolume + topVolume;
      const centre = place([30, 10, 30]).map((value, axis) => (baseVolume * value + topVolume * place([(bx + 45) / 2, 27.5, (bz + 45) / 2])[axis]) / volume);
      const measured = meshMassProperties(meshDataFromPositions(positions));

      expect(measured, `pose ${pose}`).not.toBeNull();
      expect(Math.abs(measured!.volume - volume) / volume, `pose ${pose}`).toBeLessThan(1e-5);
      expect(Math.hypot(...[measured!.centerOfMass.x, measured!.centerOfMass.y, measured!.centerOfMass.z].map((value, axis) => value - centre[axis])), `pose ${pose}`).toBeLessThan(1e-3);
    }
  });

  it("relates hundreds of bodies resting on one finely tessellated plate in well under a second", () => {
    // Each touching pair used to flood the whole plate: 300 cubes on an 82k-triangle plate took 13 s.
    const cells = 200, side = 100;
    const plate: number[] = [];
    for (let i = 0; i < cells; i += 1) {
      for (let j = 0; j < cells; j += 1) {
        const [x0, x1] = [-side / 2 + (side * i) / cells, -side / 2 + (side * (i + 1)) / cells];
        const [z0, z1] = [-side / 2 + (side * j) / cells, -side / 2 + (side * (j + 1)) / cells];
        plate.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0);
      }
    }
    // Sides and bottom, matched to the top's border so the plate closes.
    const [h, H] = [-side / 2, side / 2];
    for (let i = 0; i < cells; i += 1) {
      const [a, b] = [-side / 2 + (side * i) / cells, -side / 2 + (side * (i + 1)) / cells];
      plate.push(a, 0, h, b, 0, h, b, -10, h, a, 0, h, b, -10, h, a, -10, h);
      plate.push(b, 0, H, a, 0, H, a, -10, H, b, 0, H, a, -10, H, b, -10, H);
      plate.push(h, 0, b, h, 0, a, h, -10, a, h, 0, b, h, -10, a, h, -10, b);
      plate.push(H, 0, a, H, 0, b, H, -10, b, H, 0, a, H, -10, b, H, -10, a);
      plate.push(a, -10, h, b, -10, h, 0, -10, 0, b, -10, H, a, -10, H, 0, -10, 0);
      plate.push(h, -10, b, h, -10, a, 0, -10, 0, H, -10, a, H, -10, b, 0, -10, 0);
    }
    const cubes: number[] = [];
    const count = 600, perRow = Math.ceil(Math.sqrt(count));
    for (let n = 0; n < count; n += 1) {
      const x = -45 + (90 * (n % perRow)) / perRow + 0.123, z = -45 + (90 * Math.floor(n / perRow)) / perRow + 0.071;
      cubes.push(...boxTriangles([x, 0, z], [x + 1, 1, z + 1]));
    }
    // Timed against the plate alone, measured just before, so a busy machine
    // slows both: the cubes add about the plate's own time, where flooding the
    // plate for every cube added some eighty times it.
    let started = performance.now();
    meshMassProperties(meshDataFromPositions(plate));
    const plateAlone = performance.now() - started;
    started = performance.now();
    const measured = meshMassProperties(meshDataFromPositions([...plate, ...cubes]));
    const elapsed = performance.now() - started;

    expect(measured?.volume).toBeCloseTo(100 * 100 * 10 + count, 4);
    expect(elapsed).toBeLessThan(5 * plateAlone + 250);
  }, 120_000);

  it("has no answer for a mesh that is not closed", () => {
    expect(overlaps(boxTriangles([0, 0, 0], [1, 1, 1]).slice(0, 9 * 11))).toBeNull();
  });

  it("checks two large overlapping meshes without comparing every pair of triangles", () => {
    // Two ~60k-triangle spheres: every-pair comparison would be 3.6e9 triangle tests.
    const a = sphereTriangles([0, 0, 0], 20, 200, 150);
    const b = sphereTriangles([25, 3, 1], 20, 200, 150);
    expect(a.length / 9).toBeGreaterThan(59_000);

    const started = performance.now();
    const found = overlaps(a, b);
    const elapsed = performance.now() - started;

    expect(found).toBe(true);
    // Generous, so a busy machine does not fail it; a quadratic check takes minutes.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);

  it("keeps a large void that touches nothing", () => {
    const outer = sphereTriangles([0, 0, 0], 20, 200, 150);
    const inner = sphereTriangles([1, 0, 0], 15, 120, 90);
    expect(overlaps(outer, inner)).toBe(false);
  }, 60_000);
});
