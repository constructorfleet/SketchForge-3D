import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { exactCutPartsForSelection } from "@constructorfleet/sketchforge-engine/exactBooleanParts";
import { boundsForShapes as boundsForMirrorSelection } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";

function engineWithShapes(shapes: WorkplaneShape[]) {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Baked mirror test", createdAt: 0, shapes,
    history: [], historyIndex: -1, assets: [], workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === "mirror" ? document : null,
    write: async (_projectId, _previous, nextShapes) => { writes += 1; document.shapes = nextShapes; document.metadata.revision = writes; return { revision: writes }; },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { engine: createEngine(store), writeCount: () => writes };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

function wedge(id: string, x: number, overrides: Record<string, unknown> = {}) {
  return { ...(shapeFromRequest({ kind: "wedge", width: 30, depth: 18, height: 12, x, ...overrides }) as WorkplaneShape), id };
}

describe("engine baked mirror", () => {
  it("mirrors selected exact solids about their shared bounds and stores unflagged BREP", async () => {
    const left = wedge("left", -20, { mirrorX: true });
    const right = wedge("right", 20);
    const { engine } = engineWithShapes([left, right]);

    const outcome = value(await engine.mirrorBaked("mirror", ["left", "right"], "x"));

    expect(outcome.moved).toBe(2);
    expect(outcome.shapes.map((shape) => shape.id)).toEqual(["left", "right"]);
    const bounds = boundsForMirrorSelection([left, right]);
    const pivotX = (bounds.minX + bounds.maxX) / 2;
    expect(outcome.shapes[0]?.x).toBeCloseTo(2 * pivotX - left.x, 4);
    expect(outcome.shapes[1]?.x).toBeCloseTo(2 * pivotX - right.x, 4);
    for (const shape of outcome.shapes) {
      expect(shape.cadBrep).toContain("CASCADE Topology");
      expect(shape).toMatchObject({ kind: "mesh", rotation: 0, mirrorX: undefined, mirrorY: undefined, mirrorZ: undefined });
    }
    const properties = value(await engine.properties("mirror", "left"));
    expect(properties.isValid).toBe(true);
    expect(properties.provenance).toEqual({ source: "mesh", precision: "tessellated" });
    const hole = { ...(shapeFromRequest({ kind: "cylinder", width: 6, depth: 6, height: 14 }) as WorkplaneShape), id: "hole", hole: true };
    const cut = exactCutPartsForSelection([outcome.shapes[0]!, hole]);
    expect(cut?.parts[0]).toMatchObject({ brep: expect.stringContaining("CASCADE Topology"), hole: false });
  });

  it("refuses the entire selection when one operand has no exact parameter geometry", async () => {
    const exact = wedge("exact", 0);
    const mesh = { ...wedge("mesh", 40), kind: "mesh", importedMesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 1 } } as WorkplaneShape;
    const { engine, writeCount } = engineWithShapes([exact, mesh]);

    const outcome = await engine.mirrorBaked("mirror", ["exact", "mesh"], "x");

    expect(outcome.ok).toBe(false);
    expect(writeCount()).toBe(0);
  });
});
