import { describe, expect, it } from "vitest";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import {
  projectShapeCacheEntry,
  projectShapeCacheEntryFromEditor,
  projectSkfPackage,
  type ProjectShapeSaveContext,
} from "@/lib/projectShapeCache";
import type { ProjectParameter, WorkplaneShape } from "@/types/sketchforge";

const box: WorkplaneShape = {
  id: "box-1",
  name: "Box",
  kind: "box",
  color: "#12a4cc",
  x: 0,
  z: 0,
  elevation: 0,
  size: 10,
  width: 10,
  depth: 10,
  height: 10,
  rotation: 0,
};

const parameters: ProjectParameter[] = [
  { name: "wall", expression: "2", dimension: "length", value: 2 },
  { name: "depth", expression: "wall * 4", dimension: "length", value: 8 },
];

const context: ProjectShapeSaveContext = {
  projectName: "Parameters",
  createdAt: 1_700_000_000_000,
  workspace: DEFAULT_WORKPLANE_WORKSPACE,
  snapGrid: DEFAULT_SNAP_GRID,
  placementElevation: 0,
  placementWorkplane: horizontalPlacementWorkplane(),
  sketchPlacementWorkplane: horizontalPlacementWorkplane(),
};

describe("browser project shape cache", () => {
  it("keeps the parameter table through an autosave package", async () => {
    const entry = projectShapeCacheEntry(1, [box], undefined, undefined, [], parameters);

    const restored = await importSkfProject(await projectSkfPackage("project-1", entry, context));

    expect(entry.parameters).toEqual(parameters);
    expect(restored.parameters).toEqual(parameters);
  });

  it("carries the editor's table into the cache entry", () => {
    const history = [editorHistoryEntry([box], [])];

    expect(projectShapeCacheEntryFromEditor(2, [box], history, 0, [], parameters).parameters).toEqual(parameters);
    expect(projectShapeCacheEntryFromEditor(2, [box], [], 0, [], parameters).parameters).toEqual(parameters);
  });

  it("defaults to an empty table", () => {
    expect(projectShapeCacheEntry(1, []).parameters).toEqual([]);
  });

  it("keeps undo history whose entries carry the table, through an autosave package", async () => {
    const older = { ...parameters[0]!, expression: "1", value: 1 };
    const history = [
      editorHistoryEntry([{ ...box, width: 4 }], [], [older, { ...parameters[1]!, value: 4 }]),
      editorHistoryEntry([box], [], parameters),
    ];

    const entry = projectShapeCacheEntry(3, [box], history, 1, [], parameters);
    const restored = await importSkfProject(await projectSkfPackage("project-1", entry, context));

    expect(entry.history).toHaveLength(2);
    expect(restored.history).toHaveLength(2);
    expect(restored.history[0]!.parameters?.[0]).toEqual(older);
  });
});
