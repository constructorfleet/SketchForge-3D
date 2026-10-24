import { describe, expect, it } from "vitest";
import { createEngine } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

function engineFor(projectId: string) {
  const document: ProjectDocument = {
    metadata: { revision: 0 }, projectName: "Thread cut", createdAt: 0, shapes: [], history: [], historyIndex: -1, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  const store = {
    read: async (id: string) => id === projectId ? document : null,
    write: async (_id: string, _doc: ProjectDocument, shapes: ProjectDocument["shapes"]) => {
      document.shapes = shapes;
      return { revision: 1 };
    },
    withLock: async <T>(_id: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { engine: createEngine(store), document };
}

describe("thread cutters in exact booleans", () => {
  it("cuts an M8 threaded cutter through a plate", async () => {
    const { engine } = engineFor("thread-cut");
    const added = await engine.addShapes("thread-cut", [
      { kind: "box", width: 60, depth: 40, height: 8, name: "Plate" },
      { kind: "thread", size: "M8", length: 8, elevation: 0, x: 10, name: "Tap" },
    ]);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(JSON.stringify(added.failure));
    const [plate, cutter] = added.value.shapes;
    expect(plate).toBeDefined();
    expect(cutter).toBeDefined();

    const cut = await engine.cut("thread-cut", { solidIds: [plate!.id], holeIds: [cutter!.id] });

    if (!cut.ok) throw new Error(JSON.stringify(cut.failure));
    const result = await engine.properties("thread-cut", cut.value.shape.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.value.volume).toBeLessThan(60 * 40 * 8);
    expect(result.value.centerOfMass.x).toBeLessThan(0);
  }, CAD_TEST_TIMEOUT_MS);

  it("returns a specific geometry failure when the kernel cannot import a longer thread mesh", async () => {
    const { engine, document } = engineFor("long-thread-cut");
    const added = await engine.addShapes("long-thread-cut", [
      { kind: "box", width: 60, depth: 40, height: 8, name: "Plate" },
      { kind: "thread", size: "M8", length: 10, elevation: -1, x: 10, name: "Tap" },
    ]);
    if (!added.ok) throw new Error(JSON.stringify(added.failure));
    const [plate, cutter] = added.value.shapes;
    if (!plate || !cutter) throw new Error("Expected the plate and thread cutter.");

    const result = await engine.cut("long-thread-cut", { solidIds: [plate.id], holeIds: [cutter.id] });

    expect(result).toMatchObject({ ok: false, failure: { reason: "geometry_failed", status: 422, message: expect.stringContaining("importStl:") } });
    expect(document.shapes).toHaveLength(2);
  });
});
