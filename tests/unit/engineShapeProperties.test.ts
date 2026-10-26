import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { worldMeshForShape } from "@constructorfleet/sketchforge-engine/serverShapeGroups";

function engineWithShapes(shapes: WorkplaneShape[]) {
  const document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Properties test",
    createdAt: 0,
    shapes,
    history: [],
    historyIndex: -1,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(),
    sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  const store = {
    read: async (projectId: string) => projectId === "properties" ? document : null,
    write: async () => ({ revision: 1 }),
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return createEngine(store);
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

function unitCubeTriangles() {
  const vertices = [
    [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5],
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ];
  return faces.flatMap((face) => face.flatMap((index) => vertices[index]));
}

describe("engine shape properties", () => {
  it("keeps an imported mesh on its elevation when it is rotated", async () => {
    const mesh = sceneShape({
      id: "mesh",
      name: "Imported mesh",
      kind: "mesh",
      color: "#123456",
      width: 49,
      depth: 150,
      height: 49,
    } as never);
    const imported = {
      ...mesh,
      importedMesh: {
        positions: [0, 0, -75, 49, 0, -75, 0, 49, 75],
        baseWidth: 49,
        baseDepth: 150,
        baseHeight: 49,
        triangleCount: 1,
        sourceFormat: "stl",
      },
    } as WorkplaneShape;
    const updated = value(await engineWithShapes([imported]).changeShape("properties", "mesh", { rotationX: -90 }));

    expect(updated.shape.elevation).toBeCloseTo(50.5, 6);
    const worldMesh = worldMeshForShape(updated.shape)!;
    expect(Math.min(...worldMesh.vertices.map((vertex) => vertex[1]))).toBeCloseTo(0, 6);
  });

  it("reports exact box mass properties in project coordinates", async () => {
    const box = sceneShape({
      id: "box",
      name: "Box",
      kind: "box",
      color: "#123456",
      width: 10,
      depth: 6,
      height: 8,
      x: 13,
      elevation: 4,
      z: -7,
    });
    const properties = value(await engineWithShapes([box]).properties("properties", "box"));

    expect(properties.volume).toBeCloseTo(480, 7);
    expect(properties.area).toBeCloseTo(376, 7);
    expect(properties.centerOfMass).toEqual({ x: 13, y: 8, z: -7 });
    expect(properties.bbox.xmin).toBeCloseTo(8, 6);
    expect(properties.bbox.xmax).toBeCloseTo(18, 6);
    expect(properties.bbox.ymin).toBeCloseTo(4, 6);
    expect(properties.bbox.ymax).toBeCloseTo(12, 6);
    expect(properties.bbox.zmin).toBeCloseTo(-10, 6);
    expect(properties.bbox.zmax).toBeCloseTo(-4, 6);
    expect(properties.isValid).toBe(true);
    expect(properties.provenance).toEqual({ source: "parametric", precision: "exact" });
  });

  it("reports a cylinder's closed-form volume and area", async () => {
    const cylinder = sceneShape({
      id: "cylinder",
      name: "Cylinder",
      kind: "cylinder",
      color: "#123456",
      width: 10,
      depth: 10,
      height: 14,
    });
    const properties = value(await engineWithShapes([cylinder]).properties("properties", "cylinder"));

    expect(properties.volume).toBeCloseTo(Math.PI * 25 * 14, 6);
    expect(properties.area).toBeCloseTo(2 * Math.PI * 5 * (5 + 14), 6);
  });

  it("rotates a cone's center of mass into project space", async () => {
    const cone = sceneShape({
      id: "cone",
      name: "Cone",
      kind: "cone",
      color: "#123456",
      width: 12,
      depth: 12,
      height: 12,
      x: 5,
      elevation: 5,
      z: 7,
      rotationX: 90,
    });
    const properties = value(await engineWithShapes([cone]).properties("properties", "cone"));

    expect(properties.centerOfMass.x).toBeCloseTo(5, 7);
    expect(properties.centerOfMass.y).toBeCloseTo(11, 7);
    expect(properties.centerOfMass.z).toBeCloseTo(4, 7);
  });

  it("marks imported triangle geometry as tessellated", async () => {
    const mesh = sceneShape({
      id: "mesh",
      name: "Imported cube",
      kind: "mesh",
      color: "#123456",
      width: 1,
      depth: 1,
      height: 1,
      importedMesh: {
        positions: unitCubeTriangles(),
        baseWidth: 1,
        baseDepth: 1,
        baseHeight: 1,
        triangleCount: 12,
        sourceFormat: "stl",
      },
    });
    const properties = value(await engineWithShapes([mesh]).properties("properties", "mesh"));

    expect(properties.volume).toBeCloseTo(1, 6);
    expect(properties.isValid).toBe(true);
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
  });
});
