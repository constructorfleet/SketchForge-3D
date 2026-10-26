import { beforeEach, describe, expect, it, vi } from "vitest";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

// Counts every trip into the CAD kernel while still running it, so a test can
// tell a mesh measured from its triangles apart from one sewn into a solid.
const kernelCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@constructorfleet/sketchforge-engine/serverCadKernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@constructorfleet/sketchforge-engine/serverCadKernel")>();
  return {
    ...actual,
    withCadKernel: (work: Parameters<typeof actual.withCadKernel>[0]) => {
      kernelCalls.count += 1;
      return actual.withCadKernel(work);
    },
  };
});

const { shapeProperties } = await import("@constructorfleet/sketchforge-engine/serverCadProperties");
const { groupedShapeFromSelection } = await import("@constructorfleet/sketchforge-engine/serverShapeGroups");

type Vec3 = [number, number, number];

/** An axis-aligned box's 12 triangles, outward-wound unless `inward`. */
function boxTriangles(min: Vec3, max: Vec3, inward = false): number[] {
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
  return faces.flatMap(([a, b, c]) => (inward ? [a, c, b] : [a, b, c]).flatMap((index) => v[index]));
}

/** A UV sphere centred at (0, r, 0), so it sits on its base like a stored mesh. */
function sphereTriangles(radius: number, segments: number, rings: number): number[] {
  const point = (ring: number, segment: number): Vec3 => {
    const theta = (Math.PI * ring) / rings;
    const phi = (2 * Math.PI * segment) / segments;
    return [radius * Math.sin(theta) * Math.cos(phi), radius + radius * Math.cos(theta), radius * Math.sin(theta) * Math.sin(phi)];
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

function boundsOf(positions: number[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 1) {
    min[index % 3] = Math.min(min[index % 3], positions[index]);
    max[index % 3] = Math.max(max[index % 3], positions[index]);
  }
  return { min, max };
}

/**
 * A mesh shape holding `positions` as stored local triangles, at unit scale.
 *
 * The overrides go on after `sceneShape`, which keeps only the fields it
 * knows about and would otherwise drop a mirror without a word.
 */
function meshShape(positions: number[], overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  const { min, max } = boundsOf(positions);
  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const depth = max[2] - min[2];
  return {
    ...sceneShape({
      id: "mesh",
      name: "Imported mesh",
      kind: "mesh",
      color: "#123456",
      width,
      depth,
      height,
      importedMesh: { positions, baseWidth: width, baseDepth: depth, baseHeight: height, triangleCount: positions.length / 9, sourceFormat: "stl" },
    }),
    ...overrides,
  };
}

beforeEach(() => {
  kernelCalls.count = 0;
});

describe("mesh-native shape properties", () => {
  it("still sends an exact shape through the CAD kernel", async () => {
    const box = sceneShape({ id: "box", name: "Box", kind: "box", color: "#123456", width: 4, depth: 4, height: 4 });
    const properties = await shapeProperties(box);

    expect(properties.volume).toBeCloseTo(64, 6);
    expect(properties.provenance).toEqual({ source: "parametric", precision: "exact" });
    expect(kernelCalls.count).toBe(1);
  });

  it("measures a large imported mesh from its triangles without the CAD kernel", async () => {
    const radius = 20;
    const positions = sphereTriangles(radius, 200, 150);
    expect(positions.length / 9).toBeGreaterThan(55_000);
    const shape = meshShape(positions, { x: 7, elevation: 3, z: -11 });

    const properties = await shapeProperties(shape);

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeGreaterThan((4 / 3) * Math.PI * radius ** 3 * 0.995);
    expect(properties.volume).toBeLessThan((4 / 3) * Math.PI * radius ** 3);
    expect(properties.area).toBeGreaterThan(4 * Math.PI * radius ** 2 * 0.995);
    expect(properties.area).toBeLessThan(4 * Math.PI * radius ** 2);
    expect(properties.centerOfMass.x).toBeCloseTo(7, 6);
    expect(properties.centerOfMass.y).toBeCloseTo(3 + radius, 6);
    expect(properties.centerOfMass.z).toBeCloseTo(-11, 6);
    expect(properties.bbox.ymin).toBeCloseTo(3, 6);
    expect(properties.bbox.ymax).toBeCloseTo(3 + 2 * radius, 6);
    expect(properties.isValid).toBe(true);
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  });

  it("measures a record-only group of separate mesh parts without sewing them (#521)", async () => {
    const positions = boxTriangles([-2, 0, -2], [2, 4, 2]);
    const group = groupedShapeFromSelection([
      meshShape(positions, { id: "left", x: -5 }),
      meshShape(positions, { id: "right", x: 5 }),
    ]);
    expect(group).not.toBeNull();

    const properties = await shapeProperties(group!);

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(128, 6);
    expect(properties.centerOfMass.x).toBeCloseTo(0, 6);
    expect(properties.centerOfMass.y).toBeCloseTo(2, 6);
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  });

  it("uses the exact union path when record-only mesh members overlap", async () => {
    const positions = boxTriangles([-2, 0, -2], [2, 4, 2]);
    const group = groupedShapeFromSelection([
      meshShape(positions, { id: "left", x: 0 }),
      meshShape(positions, { id: "right", x: 1 }),
    ]);
    expect(group).not.toBeNull();

    const properties = await shapeProperties(group!);

    expect(kernelCalls.count).toBe(1);
    expect(properties.volume).toBeCloseTo(80, 5);
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  });

  it("subtracts an internal void and keeps its area", async () => {
    const positions = [...boxTriangles([-5, 0, -5], [5, 10, 5]), ...boxTriangles([-3, 2, -3], [3, 8, 3], true)];
    const properties = await shapeProperties(meshShape(positions, { x: 2 }));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(1000 - 216, 6);
    expect(properties.area).toBeCloseTo(600 + 216, 6);
    expect(properties.centerOfMass).toEqual({ x: expect.closeTo(2, 6), y: expect.closeTo(5, 6), z: expect.closeTo(0, 6) });
    expect(properties.isValid).toBe(true);
  });

  it("treats a nested shell as a void whichever way its triangles are wound", async () => {
    // Both shells wound outward: the inner one is still a cavity, by nesting.
    const positions = [...boxTriangles([-5, 0, -5], [5, 10, 5]), ...boxTriangles([-3, 2, -3], [3, 8, 3])];
    const properties = await shapeProperties(meshShape(positions));

    expect(properties.volume).toBeCloseTo(1000 - 216, 6);
    expect(properties.isValid).toBe(true);
  });

  it("weights the centre of mass across separate shells", async () => {
    // A 4 mm cube at x in [-10, -6] and a 2 mm cube at x in [6, 8].
    const positions = [...boxTriangles([-10, 0, -2], [-6, 4, 2]), ...boxTriangles([6, 0, -1], [8, 2, 1])];
    const properties = await shapeProperties(meshShape(positions));

    const expectedX = (64 * -8 + 8 * 7) / 72;
    const expectedY = (64 * 2 + 8 * 1) / 72;
    expect(properties.volume).toBeCloseTo(72, 6);
    expect(properties.area).toBeCloseTo(96 + 24, 6);
    // The stored mesh is re-centred in X, so measure relative to the shape's placement.
    expect(properties.centerOfMass.x - (properties.bbox.xmin + properties.bbox.xmax) / 2).toBeCloseTo(expectedX - (-10 + 8) / 2, 6);
    expect(properties.centerOfMass.y).toBeCloseTo(expectedY, 6);
    expect(properties.centerOfMass.z).toBeCloseTo(0, 6);
  });

  it("reports a positive volume for a mesh wound inside out", async () => {
    const properties = await shapeProperties(meshShape(boxTriangles([-1, 0, -2], [3, 2, 2], true)));

    expect(properties.volume).toBeCloseTo(32, 6);
    expect(properties.isValid).toBe(true);
  });

  it("rewinds individual triangles that an export flipped", async () => {
    const positions = boxTriangles([-2, 0, -1], [2, 3, 1]);
    // Swap two corners of the 1st and 6th triangles, as a sloppy exporter might.
    for (const triangle of [0, 5]) {
      const at = triangle * 9;
      const second = positions.slice(at + 3, at + 6);
      positions.splice(at + 3, 3, ...positions.slice(at + 6, at + 9));
      positions.splice(at + 6, 3, ...second);
    }
    const properties = await shapeProperties(meshShape(positions));

    expect(properties.volume).toBeCloseTo(24, 6);
    expect(properties.centerOfMass).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(1.5, 6), z: expect.closeTo(0, 6) });
    expect(properties.isValid).toBe(true);
  });

  it("puts a mirrored mesh's centre of mass where the shape stands", async () => {
    // An L of two boxes: its centre of mass is off-centre, so a mirror shows.
    const positions = [...boxTriangles([-6, 0, -2], [6, 2, 2]), ...boxTriangles([2, 2, -2], [6, 10, 2])];
    const plain = await shapeProperties(meshShape(positions));
    const mirrored = await shapeProperties(meshShape(positions, { mirrorX: true }));

    expect(plain.volume).toBeCloseTo(96 + 128, 6);
    expect(mirrored.volume).toBeCloseTo(plain.volume, 6);
    expect(plain.centerOfMass.x).toBeGreaterThan(0.5);
    expect(mirrored.centerOfMass.x).toBeCloseTo(-plain.centerOfMass.x, 6);
    expect(mirrored.centerOfMass.y).toBeCloseTo(plain.centerOfMass.y, 6);
    expect(mirrored.isValid).toBe(true);
  });

  it("welds corners that miss each other by a micron, as sewing did", async () => {
    const radius = 20;
    const exact = sphereTriangles(radius, 64, 48);
    // Every corner nudged by up to 1e-6 mm, as a mesh boolean can leave them.
    let seed = 12345;
    const jitter = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return (seed / 2 ** 31 - 0.5) * 2e-6;
    };
    const positions = exact.map((value) => value + jitter());
    const reference = await shapeProperties(meshShape(exact));
    kernelCalls.count = 0;
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.isValid).toBe(true);
    expect(properties.volume).toBeCloseTo(reference.volume, 2);
    expect(properties.centerOfMass.y).toBeCloseTo(reference.centerOfMass.y, 4);
  });

  it("measures two boxes stacked on a shared face as their union", async () => {
    const positions = [...boxTriangles([0, 0, 0], [1, 1, 1]), ...boxTriangles([0, 1, 0], [1, 3, 1])];
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(3, 6);
    expect(properties.centerOfMass.y).toBeCloseTo((1 * 0.5 + 2 * 2) / 3, 6);
    expect(properties.isValid).toBe(true);
  });

  it("ignores a triangle the file repeats", async () => {
    const positions = boxTriangles([-1, 0, -1], [1, 2, 1]);
    positions.push(...positions.slice(9 * 4, 9 * 5));
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(8, 6);
    expect(properties.centerOfMass).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(1, 6), z: expect.closeTo(0, 6) });
    expect(properties.isValid).toBe(true);
  });

  it("adds up many separate closed shells", async () => {
    // 400 unit cubes on a 20 x 20 grid, 2 mm apart: none encloses another.
    const positions: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      for (let k = 0; k < 20; k += 1) positions.push(...boxTriangles([2 * i, 0, 2 * k], [2 * i + 1, 1, 2 * k + 1]));
    }
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(400, 6);
    expect(properties.centerOfMass.y).toBeCloseTo(0.5, 6);
    expect(properties.isValid).toBe(true);
  });

  it("finds each void inside its own part among many", async () => {
    // 27 hollow 2 mm cubes, 3 mm apart, each with a 1 mm cavity off its centre.
    const positions: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        for (let k = 0; k < 3; k += 1) {
          const [x, y, z] = [3 * i, 3 * j, 3 * k];
          positions.push(...boxTriangles([x, y, z], [x + 2, y + 2, z + 2]));
          positions.push(...boxTriangles([x + 0.25, y + 0.25, z + 0.25], [x + 1.25, y + 1.25, z + 1.25]));
        }
      }
    }
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(27 * 7, 6);
    // Each part's centre of mass sits off its centre, away from the cavity.
    expect(properties.centerOfMass.y).toBeCloseTo(3 + (8 * 1 - 1 * 0.75) / 7, 6);
    expect(properties.isValid).toBe(true);
  });

  it.each([
    // The case #529 reported: B's corner poked 5 mm into A. Summed, 2000 mm^3; the union is 1875.
    ["one body's corner inside the other", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([5, 5, 5], [15, 15, 15])],
    // Sharing a 5 mm slab, every face of the overlap coplanar with one of theirs: no two faces cross.
    ["side by side, sharing a slab", boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([5, 0, 0], [15, 10, 10])],
    // Two bars crossing like a plus sign: no corner of either lies inside the other, only edges cross.
    ["crossing bars, no corner inside the other", boxTriangles([-10, -1, -1], [10, 1, 1]), boxTriangles([-1, -10, -0.5], [1, 10, 1.5])],
  ])("refuses closed bodies that overlap without nesting, as the exact path does: %s", async (_label, a, b) => {
    // Summing them would count the overlap twice. The refusal comes straight
    // from the triangles: sewing a large mesh only to refuse it held the kernel for minutes.
    await expect(shapeProperties(meshShape([...a, ...b]))).rejects.toThrow(/overlap without one enclosing the other/);
    expect(kernelCalls.count).toBe(0);
  });

  it("adds a body resting on another's face without sharing its triangles", async () => {
    // A 2 mm cube on top of a 10 mm cube: coplanar contact over 4 mm^2, no overlap volume.
    const positions = [...boxTriangles([0, 0, 0], [10, 10, 10]), ...boxTriangles([2, 10, 2], [4, 12, 4])];
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(1008, 6);
    expect(properties.centerOfMass.y).toBeCloseTo((1000 * 5 + 8 * 11) / 1008, 6);
    expect(properties.isValid).toBe(true);
  });

  it("adds bodies that touch only along an edge", async () => {
    const positions = [...boxTriangles([0, 0, 0], [1, 1, 1]), ...boxTriangles([1, 1, 0], [2, 2, 1])];
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(2, 6);
    expect(properties.centerOfMass.y).toBeCloseTo(1, 6);
  });

  it("subtracts a void that touches its wall at the corner the nesting ray leaves from", async () => {
    // The cavity's far corner is the part's own, so a ray from it never re-enters the part.
    const positions = [...boxTriangles([0, 0, 0], [10, 10, 10]), ...boxTriangles([2, 2, 2], [10, 10, 10])];
    const properties = await shapeProperties(meshShape(positions));

    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(1000 - 512, 6);
    expect(properties.centerOfMass.y).toBeCloseTo((1000 * 5 - 512 * 6) / 488, 6);
    expect(properties.isValid).toBe(true);
  });

  it("still measures an island floating in a void", async () => {
    const positions = [
      ...boxTriangles([-10, 0, -10], [10, 20, 10]),
      ...boxTriangles([-6, 4, -6], [6, 16, 6], true),
      ...boxTriangles([0, 8, -2], [4, 12, 2]),
    ];
    const properties = await shapeProperties(meshShape(positions));

    const volume = 8000 - 1728 + 64;
    expect(kernelCalls.count).toBe(0);
    expect(properties.volume).toBeCloseTo(volume, 6);
    expect(properties.centerOfMass.y).toBeCloseTo(10, 6);
    expect(properties.isValid).toBe(true);
  });

  it("leaves a mesh that is not closed to the CAD kernel, which refuses it as before", async () => {
    // Open fragments have no volume of their own, so nothing is made up for them.
    const positions = boxTriangles([-1, 0, -1], [1, 2, 1]).slice(0, 9 * 11);

    await expect(shapeProperties(meshShape(positions))).rejects.toThrow(/not a closed solid/);
    expect(kernelCalls.count).toBe(1);
  });
});
