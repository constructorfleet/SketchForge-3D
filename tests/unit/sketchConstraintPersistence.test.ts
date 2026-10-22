import { expect, it } from "vitest";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { WorkplaneShape } from "@/types/sketchforge";

const sketch: WorkplaneShape = {
  id: "profile", name: "profile", kind: "box", color: "#12a4cc", x: 0, z: 0,
  size: 10, width: 10, depth: 10, height: 10, rotation: 0,
  sketchProfile: {
    points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }],
    segments: [
      { id: "line", startId: "a", endId: "b" },
      { id: "other", startId: "b", endId: "a" },
    ],
    constraints: [
      { id: "c", kind: "coincident", pointIds: ["a", "b"] },
      { id: "h", kind: "horizontal", segmentId: "line" },
      { id: "v", kind: "vertical", segmentId: "line" },
      { id: "parallel", kind: "parallel", segmentIds: ["line", "other"] },
      { id: "p", kind: "perpendicular", segmentIds: ["line", "other"] },
      { id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10 },
      { id: "fixed-a", kind: "fixed", pointId: "a", xMm: 0, zMm: 0 },
    ],
  },
};

it("round-trips sketch constraints in the native project format", async () => {
  const bytes = await exportSkfProject({
    projectName: "Constraints", createdAt: 1, modifiedAt: 1, shapes: [sketch],
    history: [editorHistoryEntry([sketch], [])], historyIndex: 0, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
  });
  const restored = await importSkfProject(bytes);
  expect(restored.shapes[0]?.sketchProfile?.constraints).toEqual(sketch.sketchProfile?.constraints);
});

it("rejects fixed-point constraints with invalid coordinates or missing points", async () => {
  for (const fixed of [
    { id: "fixed-a", kind: "fixed", pointId: "missing", xMm: 0, zMm: 0 },
    { id: "fixed-a", kind: "fixed", pointId: "a", xMm: Number.NaN, zMm: 0 },
  ]) {
    const invalid = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, constraints: [fixed as never] } };
    const bytes = await exportSkfProject({
      projectName: "Invalid fixed constraint", createdAt: 1, modifiedAt: 1, shapes: [invalid],
      history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    });
    await expect(importSkfProject(bytes)).rejects.toThrow();
  }
});

it("rejects parallel constraints that reference a missing segment", async () => {
  const invalid = {
    ...sketch,
    sketchProfile: {
      ...sketch.sketchProfile!,
      constraints: [{ id: "parallel", kind: "parallel" as const, segmentIds: ["line", "missing"] as [string, string] }],
    },
  };
  const bytes = await exportSkfProject({
    projectName: "Invalid parallel constraint", createdAt: 1, modifiedAt: 1, shapes: [invalid],
    history: [editorHistoryEntry([invalid], [])], historyIndex: 0, assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
  });
  await expect(importSkfProject(bytes)).rejects.toThrow(/constraints\[0\]\.segmentIds/);
});
