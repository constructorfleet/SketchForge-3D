import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { OcctKernel } from "occt-wasm";
import { Euler, MathUtils, Vector3 } from "three";
import { buildCadSketchSweep } from "@/lib/sketchCadSweep";
import { placeSketchExtrusion } from "@/lib/sketchPlacement";
import type { SketchProfile, WorkplaneShape } from "@/types/sketchforge";


function profileWithSpine(spine: Array<{ x: number; z: number }>, sectionFrame = defaultSectionFrame()): SketchProfile {
  const sectionPoints = [
    { id: "a", x: -1, z: -1, sweepRole: "section" as const }, { id: "b", x: 1, z: -1, sweepRole: "section" as const },
    { id: "c", x: 1, z: 1, sweepRole: "section" as const }, { id: "d", x: -1, z: 1, sweepRole: "section" as const },
  ];
  const pathPoints = spine.map((point, index) => ({ id: `p${index}`, ...point, sweepRole: "spine" as const }));
  const profile = {
    points: [...sectionPoints, ...pathPoints],
    segments: [
      ...sectionPoints.map((point, index) => ({ id: `s${index}`, kind: "line" as const, startId: point.id, endId: sectionPoints[(index + 1) % sectionPoints.length].id })),
      ...pathPoints.slice(0, -1).map((point, index) => ({ id: `path${index}`, kind: "line" as const, startId: point.id, endId: pathPoints[index + 1].id })),
    ],
  } as SketchProfile;
  const spineFrame = {
    origin: sectionFrame.origin,
    xAxis: sectionFrame.normal,
    zAxis: sectionFrame.xAxis,
    normal: cross(sectionFrame.xAxis, sectionFrame.normal),
  };
  return { ...profile, sweepFrames: { section: sectionFrame, spine: spineFrame } } as SketchProfile;
}

function defaultSectionFrame() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  };
}

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

describe("planar sketch sweep (real OCCT kernel)", () => {
  it("sweeps an enclosed section loop as a through hole", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const profile = profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const holePoints = [
      { id: "h0", x: -0.5, z: -0.5, sweepRole: "section" as const },
      { id: "h1", x: 0.5, z: -0.5, sweepRole: "section" as const },
      { id: "h2", x: 0.5, z: 0.5, sweepRole: "section" as const },
      { id: "h3", x: -0.5, z: 0.5, sweepRole: "section" as const },
    ];
    profile.points.push(...holePoints);
    profile.segments.push(...holePoints.map((point, index) => ({
      id: `hole-${index}`, kind: "line" as const, startId: point.id, endId: holePoints[(index + 1) % holePoints.length]!.id,
    })));
    try {
      const solid = buildCadSketchSweep(cad, profile);
      expect(cad.isValid(solid)).toBe(true);
      expect(cad.isSolid(solid)).toBe(true);
      // 2x2 section minus a 1x1 hole, swept 10 mm.
      expect(cad.getVolume(solid)).toBeCloseTo(30, 3);
    } finally {
      cad.releaseAll();
    }
  });

  it("sweeps disjoint section loops into separate solids along one spine", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const profile = profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const islandPoints = [
      { id: "i0", x: 3, z: -1, sweepRole: "section" as const },
      { id: "i1", x: 5, z: -1, sweepRole: "section" as const },
      { id: "i2", x: 5, z: 1, sweepRole: "section" as const },
      { id: "i3", x: 3, z: 1, sweepRole: "section" as const },
    ];
    profile.points.push(...islandPoints);
    profile.segments.push(...islandPoints.map((point, index) => ({
      id: `island-${index}`, kind: "line" as const, startId: point.id, endId: islandPoints[(index + 1) % islandPoints.length]!.id,
    })));
    try {
      const solids = buildCadSketchSweep(cad, profile);
      expect(cad.isValid(solids)).toBe(true);
      expect(cad.isCompound(solids)).toBe(true);
      expect(cad.getSubShapes(solids, "solid")).toHaveLength(2);
      expect(cad.getVolume(solids)).toBeCloseTo(80, 3);
    } finally {
      cad.releaseAll();
    }
  });

  it.each([
    ["straight spine", [{ x: 0, z: 0 }, { x: 10, z: 0 }]],
    ["bent spine", [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }]],
  ])("builds a valid positive-volume solid along a %s", async (_label, spine) => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    try {
      const solid = buildCadSketchSweep(cad, profileWithSpine(spine));
      expect(cad.isValid(solid)).toBe(true);
      expect(cad.isSolid(solid)).toBe(true);
      expect(cad.getVolume(solid)).toBeGreaterThan(0);
      const positions = cad.tessellate(solid).positions;
      const bounds = [0, 1, 2].map((axis) => {
        const values = Array.from({ length: positions.length / 3 }, (_, index) => positions[index * 3 + axis]);
        return [Math.min(...values), Math.max(...values)];
      });
      expect(bounds[0][0]).toBeCloseTo(-1, 2);
      expect(bounds[0][1]).toBeCloseTo(_label === "straight spine" ? 1 : 10, 2);
      expect(bounds[1][0]).toBeCloseTo(0, 2);
      expect(bounds[1][1]).toBeCloseTo(_label === "straight spine" ? 10 : 11, 2);
      expect(bounds[2][0]).toBeCloseTo(-1, 2);
      expect(bounds[2][1]).toBeCloseTo(1, 2);
    } finally {
      cad.releaseAll();
    }
  });

  it("uses a spine point's out-of-plane offset to make a nonplanar 3D path", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const profile = profileWithSpine([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 20, z: 10 },
    ]);
    profile.points.find((point) => point.id === "p3")!.sweepDepth = 5;
    try {
      const solid = buildCadSketchSweep(cad, profile);
      expect(cad.isValid(solid)).toBe(true);
      expect(cad.isSolid(solid)).toBe(true);
      expect(cad.getBoundingBox(solid, false).zmax).toBeGreaterThan(5.9);
    } finally {
      cad.releaseAll();
    }
  });

  it("uses independent incoming and outgoing Bezier handle depths in the 3D sweep path", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const profile = profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }]);
    const start = profile.points.find((point) => point.id === "p1")!;
    const end = profile.points.find((point) => point.id === "p2")!;
    start.handleOut = { x: 13, z: 0, sweepDepth: 4 };
    end.handleIn = { x: 17, z: 0, sweepDepth: -3 };
    profile.segments.find((segment) => segment.id === "path1")!.kind = "bezier";
    try {
      const solid = buildCadSketchSweep(cad, profile);
      expect(cad.isValid(solid)).toBe(true);
      expect(cad.isSolid(solid)).toBe(true);
      const bounds = cad.getBoundingBox(solid, false);
      expect(bounds.zmax).toBeGreaterThan(2);
      expect(bounds.zmin).toBeLessThan(-1);
    } finally {
      cad.releaseAll();
    }
  });

  it("aligns cubic handle depth with the selected workplane third axis", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const sectionFrame = {
      origin: { x: 3, y: -2, z: 4 },
      normal: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 },
      xAxis: { x: 1, y: 0, z: 0 },
      zAxis: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 },
    };
    const profile = profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }], sectionFrame);
    const first = profile.points.find((point) => point.id === "p0")!;
    const middle = profile.points.find((point) => point.id === "p1")!;
    const last = profile.points.find((point) => point.id === "p2")!;
    first.handleOut = { x: 3, z: 0 };
    middle.handleIn = { x: 7, z: 0 };
    middle.handleOut = { x: 13, z: 0, sweepDepth: -3 };
    last.handleIn = { x: 17, z: 0, sweepDepth: 4 };
    profile.segments.filter((segment) => segment.id === "path0" || segment.id === "path1").forEach((segment) => { segment.kind = "bezier"; });
    try {
      const solid = buildCadSketchSweep(cad, profile);
      const positions = cad.tessellate(solid).positions;
      const bounds = [0, 1, 2].map((axis) => {
        const values = Array.from({ length: positions.length / 3 }, (_, index) => positions[index * 3 + axis]);
        return [Math.min(...values), Math.max(...values)];
      });
      const centerX = (bounds[0]![0]! + bounds[0]![1]!) / 2;
      const centerZ = (bounds[2]![0]! + bounds[2]![1]!) / 2;
      const height = bounds[1]![1]! - bounds[1]![0]!;
      const minY = bounds[1]![0]!;
      const source = {
        id: "rotated-sweep-depth-test", name: "Rotated sweep depth test", kind: "mesh" as const, color: "#d41721",
        x: centerX, z: centerZ, elevation: minY, size: Math.max(bounds[0]![1]! - bounds[0]![0]!, bounds[2]![1]! - bounds[2]![0]!),
        width: bounds[0]![1]! - bounds[0]![0]!, depth: bounds[2]![1]! - bounds[2]![0]!, height, rotation: 0,
        importedMesh: {
          positions: Array.from({ length: positions.length }, (_, index) => positions[index]! - (index % 3 === 0 ? centerX : index % 3 === 1 ? minY : centerZ)),
          baseWidth: bounds[0]![1]! - bounds[0]![0]!, baseDepth: bounds[2]![1]! - bounds[2]![0]!, baseHeight: height,
          triangleCount: positions.length / 9, sourceFormat: "json" as const,
        },
      } satisfies WorkplaneShape;
      const placed = placeSketchExtrusion(source, sectionFrame);
      const rotation = new Euler(MathUtils.degToRad(placed.rotationX ?? 0), MathUtils.degToRad(placed.rotation), MathUtils.degToRad(placed.rotationZ ?? 0), "XYZ");
      const center = new Vector3(placed.x, (placed.elevation ?? 0) + placed.height / 2, placed.z);
      const localDepths = Array.from({ length: positions.length / 3 }, (_, index) => {
        const point = new Vector3(positions[index * 3]! - centerX, positions[index * 3 + 1]! - minY - height / 2, positions[index * 3 + 2]! - centerZ)
          .applyEuler(rotation).add(center).sub(new Vector3(sectionFrame.origin.x, sectionFrame.origin.y, sectionFrame.origin.z));
        return point.x * sectionFrame.zAxis.x + point.y * sectionFrame.zAxis.y + point.z * sectionFrame.zAxis.z;
      });
      expect(Math.max(...localDepths)).toBeGreaterThan(2);
      expect(Math.min(...localDepths)).toBeLessThan(-1);
    } finally {
      cad.releaseAll();
    }
  });

  it("derives an orthogonal spine frame from non-axis-aligned section workplanes", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const frames = [
      defaultSectionFrame(),
      {
        origin: { x: 3, y: -2, z: 4 },
        normal: { x: 1, y: 0, z: 0 },
        xAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: -1 },
      },
      {
        origin: { x: -2, y: 1, z: 5 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        zAxis: { x: 0, y: -1, z: 0 },
      },
    ];
    try {
      for (const sectionFrame of frames) {
        const solid = buildCadSketchSweep(cad, profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 0 }], sectionFrame));
        expect(cad.isValid(solid)).toBe(true);
        expect(cad.isSolid(solid)).toBe(true);
        expect(cad.getVolume(solid)).toBeGreaterThan(0);
        const positions = cad.tessellate(solid).positions;
        const yValues = Array.from({ length: positions.length / 3 }, (_, index) => positions[index * 3 + 1]);
        expect(Math.min(...yValues)).toBeCloseTo(0, 2);
        expect(Math.max(...yValues)).toBeCloseTo(10, 2);
      }
    } finally {
      cad.releaseAll();
    }
  });

  it("places a non-axis-aligned sweep once and preserves its dimensions in the section frame", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const sectionFrame = {
      origin: { x: 7, y: -4, z: 3 },
      normal: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 },
      xAxis: { x: 1, y: 0, z: 0 },
      zAxis: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 },
    };
    try {
      const solid = buildCadSketchSweep(cad, profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 0 }], sectionFrame));
      const positions = cad.tessellate(solid).positions;
      const bounds = [0, 1, 2].map((axis) => {
        const values = Array.from({ length: positions.length / 3 }, (_, index) => positions[index * 3 + axis]);
        return [Math.min(...values), Math.max(...values)];
      });
      const centerX = (bounds[0][0] + bounds[0][1]) / 2;
      const centerZ = (bounds[2][0] + bounds[2][1]) / 2;
      const height = bounds[1][1] - bounds[1][0];
      const minY = bounds[1][0];
      const source = {
        id: "sweep-placement-test", name: "Sweep placement test", kind: "mesh" as const, color: "#d41721",
        x: centerX, z: centerZ, elevation: minY, size: Math.max(bounds[0][1] - bounds[0][0], bounds[2][1] - bounds[2][0]),
        width: bounds[0][1] - bounds[0][0], depth: bounds[2][1] - bounds[2][0], height, rotation: 0,
        importedMesh: {
          positions: Array.from({ length: positions.length }, (_, index) => positions[index] - (index % 3 === 0 ? centerX : index % 3 === 1 ? minY : centerZ)),
          baseWidth: bounds[0][1] - bounds[0][0], baseDepth: bounds[2][1] - bounds[2][0], baseHeight: height,
          triangleCount: positions.length / 9, sourceFormat: "json" as const,
        },
      } satisfies WorkplaneShape;
      const placed = placeSketchExtrusion(source, sectionFrame);
      const rotation = new Euler(
        MathUtils.degToRad(placed.rotationX ?? 0),
        MathUtils.degToRad(placed.rotation),
        MathUtils.degToRad(placed.rotationZ ?? 0),
        "XYZ",
      );
      const center = new Vector3(placed.x, (placed.elevation ?? 0) + placed.height / 2, placed.z);
      const projected: [number[], number[], number[]] = [[], [], []];
      for (let index = 0; index < positions.length; index += 3) {
        const world = new Vector3(
          source.importedMesh!.positions[index]!,
          source.importedMesh!.positions[index + 1]! - height / 2,
          source.importedMesh!.positions[index + 2]!,
        ).applyEuler(rotation).add(center).sub(new Vector3(sectionFrame.origin.x, sectionFrame.origin.y, sectionFrame.origin.z));
        for (const [axis, basis] of [sectionFrame.xAxis, sectionFrame.normal, sectionFrame.zAxis].entries()) {
          projected[axis].push(world.x * basis.x + world.y * basis.y + world.z * basis.z);
        }
      }
      expect(Math.min(...projected[0])).toBeCloseTo(-1, 2);
      expect(Math.max(...projected[0])).toBeCloseTo(1, 2);
      expect(Math.min(...projected[1])).toBeCloseTo(0, 2);
      expect(Math.max(...projected[1])).toBeCloseTo(10, 2);
      expect(Math.min(...projected[2])).toBeCloseTo(-1, 2);
      expect(Math.max(...projected[2])).toBeCloseTo(1, 2);
    } finally {
      cad.releaseAll();
    }
  });

  it("keeps legacy profiles valid and maps a horizontal spine stroke along the default section normal", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    const legacyProfile = profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    delete legacyProfile.sweepFrames;
    try {
      const solid = buildCadSketchSweep(cad, legacyProfile);
      expect(cad.isValid(solid)).toBe(true);
      expect(cad.isSolid(solid)).toBe(true);
      expect(cad.getVolume(solid)).toBeGreaterThan(0);
      const positions = cad.tessellate(solid).positions;
      const y = Array.from({ length: positions.length / 3 }, (_, index) => positions[index * 3 + 1]);
      expect(Math.min(...y)).toBeCloseTo(0, 2);
      expect(Math.max(...y)).toBeCloseTo(10, 2);
    } finally {
      cad.releaseAll();
    }
  });

  it("rejects a first spine tangent that leaves the orthogonal sweep plane", async () => {
    const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    try {
      expect(() => buildCadSketchSweep(cad, profileWithSpine([{ x: 0, z: 0 }, { x: 10, z: 2 }]))).toThrowError(
        expect.objectContaining({ key: "errors.sketch.sweepSpineDirection" }),
      );
    } finally {
      cad.releaseAll();
    }
  });
});
