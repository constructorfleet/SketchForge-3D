import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult, MAX_INTERFERENCE_CANDIDATES, MAX_INTERFERENCE_SHAPES } from "@constructorfleet/sketchforge-engine";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";

function box(id: string, x: number, extras: Partial<WorkplaneShape> = {}) {
  return sceneShape({ id, name: id, kind: "box", color: "#123456", width: 2, depth: 2, height: 2, x, ...extras });
}

function engineWithShapes(shapes: WorkplaneShape[]) {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Interference test", createdAt: 0, shapes, history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  const store = {
    read: async (id: string) => id === "interference" ? document : null,
    write: async () => ({ revision: 1 }),
    withLock: async <T>(_id: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return createEngine(store);
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

describe("engine exact interference", () => {
  it("reports exact gaps, touching and penetration, excluding distant pairs", async () => {
    const report = value(await engineWithShapes([box("left", 0), box("overlap", 1), box("gap", 4), box("far", 20), box("cutter", 0, { hole: true }), box("hidden", 0, { hidden: true })]).interference("interference", { clearance: 2 }));
    expect(report.shapesChecked).toBe(4);
    expect(report.pairs.map(({ a, b, gap }) => [a.id, b.id, gap])).toEqual([["left", "overlap", 0], ["overlap", "gap", 1], ["left", "gap", 2]]);
    expect(report.pairs[0]?.overlapVolume).toBeCloseTo(4, 6);
    expect(report.pairs.slice(1).every(({ overlapVolume }) => overlapVolume === 0)).toBe(true);
    const touching = value(await engineWithShapes([box("touch-a", 0), box("touch-b", 2)]).interference("interference"));
    expect(touching.pairs[0]).toMatchObject({ gap: 0, overlapVolume: 0 });
    expect(report.method).toContain("OCCT exact distance");
  });

  it("selects ids and refuses invalid or oversized requests explicitly", async () => {
    const engine = engineWithShapes([box("a", 0), box("b", 3)]);
    expect(value(await engine.interference("interference", { ids: ["a"], clearance: 5 })).shapesChecked).toBe(1);
    expect(await engine.interference("interference", { clearance: -1 })).toMatchObject({ ok: false, failure: { reason: "interference_refused", refusal: { reason: "invalid_clearance" } } });
    const tooMany = engineWithShapes(Array.from({ length: MAX_INTERFERENCE_SHAPES + 1 }, (_, i) => box(`shape-${i}`, i * 4)));
    expect(await tooMany.interference("interference")).toMatchObject({ ok: false, failure: { reason: "interference_refused", refusal: { reason: "too_many_shapes", limit: MAX_INTERFERENCE_SHAPES } } });
    const dense = engineWithShapes(Array.from({ length: 33 }, (_, i) => box(`dense-${i}`, 0)));
    expect(await dense.interference("interference")).toMatchObject({ ok: false, failure: { reason: "interference_refused", refusal: { reason: "too_many_candidates", limit: MAX_INTERFERENCE_CANDIDATES } } });
  });
});
