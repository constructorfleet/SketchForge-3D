import { describe, expect, it } from "vitest";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { WorkplaneShape } from "@/types/sketchforge";

const sketch: WorkplaneShape = {
  id: "profile", name: "profile", kind: "box", color: "#12a4cc", x: 0, z: 0,
  size: 10, width: 10, depth: 10, height: 10, rotation: 0,
  sketchProfile: {
    points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }],
    segments: [{ id: "line", startId: "a", endId: "b" }],
    constraints: [
      { id: "c", kind: "coincident", pointIds: ["a", "b"] },
      { id: "h", kind: "horizontal", segmentId: "line" },
      { id: "v", kind: "vertical", segmentId: "line" },
      { id: "d", kind: "distance", pointIds: ["a", "b"], valueMm: 10 },
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
