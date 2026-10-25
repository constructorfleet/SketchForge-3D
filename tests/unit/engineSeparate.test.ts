import * as THREE from "three";
import { worldMeshForShape } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import { measureMesh } from "./support/meshMeasure";
import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { importedShapeFromTriangleSoup } from "@constructorfleet/sketchforge-engine/stlImport";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function boxTriangles(centerX: number, half: number) {
  const corners = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ].map(([x, y, z]) => [centerX + x! * half, y! * half + 1, z! * half]);
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ];
  return faces.flatMap((face) => face.flatMap((index) => corners[index]!));
}

function projectStore(shape: WorkplaneShape) {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Separate transformed mesh", createdAt: 0,
    shapes: [shape], history: [], historyIndex: -1, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  const store = {
    read: async (id: string) => id === "separate" ? document : null,
    write: async (_id: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      document.shapes = shapes;
      return { revision: 1 };
    },
    withLock: async <T>(_id: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { document, engine: createEngine(store) };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("engine separation of transformed imported meshes", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("splits each body at its rotated and mirrored world position", async () => {
    const shape = importedShapeFromTriangleSoup("two-bodies.stl", [
      ...boxTriangles(-3, 1),
      ...boxTriangles(3, 0.5),
    ], undefined);
    Object.assign(shape, { x: 10, z: 6, elevation: 3, rotation: 90, mirrorX: true });
    const { engine } = projectStore(shape);

    const parts = value(await engine.separate("separate", shape.id)).shapes;

    expect(parts).toHaveLength(2);
    // Measure the actual closed meshes, including winding, independently of
    // their stored dimensions. The unequal bodies also expose a lost mirror.
    const measured = parts.map((part) => {
      const mesh = worldMeshForShape(part)!;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(
        mesh.faces.flatMap((face) => face.flatMap((index) => mesh.vertices[index]!)), 3,
      ));
      try { return measureMesh(geometry); } finally { geometry.dispose(); }
    }).sort((a, b) => b.volume - a.volume);
    for (const [index, expected] of [
      { volume: 8, centroid: [10, 4, 3.25] },
      { volume: 1, centroid: [10, 4, 9.25] },
    ].entries()) {
      expect(measured[index]!.volume).toBeCloseTo(expected.volume, 4);
      expected.centroid.forEach((coordinate, axis) => {
        expect(measured[index]!.centroid[axis]).toBeCloseTo(coordinate, 4);
      });
    }

    const larger = parts.find((part) => part.width > 1.5)!;
    const smaller = parts.find((part) => part.width < 1.5)!;
    expect([larger.width, larger.depth, larger.height]).toEqual([2, 2, 2]);
    expect([smaller.width, smaller.depth, smaller.height]).toEqual([1, 1, 1]);
    expect(larger.x).toBeCloseTo(10, 4);
    expect(larger.z).toBeCloseTo(3.25, 3);
    expect(larger.elevation).toBeCloseTo(3, 4);
    expect(smaller.x).toBeCloseTo(10, 4);
    expect(smaller.z).toBeCloseTo(9.25, 3);
    expect(smaller.elevation).toBeCloseTo(3.5, 4);
  });
});
