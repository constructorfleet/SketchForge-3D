import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject, type SkfProjectDocumentV1, type SkfProjectExportInput } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { ProjectParameter, WorkplaneShape } from "@/types/sketchforge";

const wall = (value: number): ProjectParameter[] => [{ name: "wall", expression: String(value), dimension: "length", value }];

function box(width: number, expressions?: Record<string, string>): WorkplaneShape {
  return {
    id: "box-1", name: "Box", kind: "box", color: "#12a4cc",
    x: 0, z: 0, elevation: 0, size: width, width, depth: 10, height: 10, rotation: 0,
    ...(expressions ? { expressions } : {}),
  };
}

function input(shapes: WorkplaneShape[], parameters: ProjectParameter[], history = [editorHistoryEntry(shapes, [], parameters)]): SkfProjectExportInput {
  return {
    projectId: "bindings",
    projectName: "Bindings",
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_100_000,
    shapes,
    history,
    historyIndex: history.length - 1,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    parameters,
  } as SkfProjectExportInput;
}

function mutateProject(bytes: Uint8Array, mutate: (document: SkfProjectDocumentV1) => void) {
  const files = unzipSync(bytes);
  const document = JSON.parse(strFromU8(files["project.json"])) as SkfProjectDocumentV1;
  mutate(document);
  files["project.json"] = strToU8(JSON.stringify(document));
  return zipSync(files);
}

function sceneDefinitions(document: SkfProjectDocumentV1) {
  return document.states.find((state) => state.id === document.sceneStateId)!.nodes.map((node) => node.definition);
}

describe(".skf shape bindings", () => {
  it("round-trips bindings and their resolved numbers", async () => {
    const bound = box(4, { width: "wall * 2" });
    const restored = await importSkfProject(await exportSkfProject(input([bound], wall(2))));

    expect(restored.shapes[0]).toMatchObject({ width: 4, expressions: { width: "wall * 2" } });
    expect(restored.bindingIssues).toEqual([]);
  });

  it("restores each history state with its own table, so undo restores the old value", async () => {
    const before = editorHistoryEntry([box(4, { width: "wall * 2" })], [], wall(2));
    const after = editorHistoryEntry([box(6, { width: "wall * 2" })], [], wall(3));
    const restored = await importSkfProject(await exportSkfProject(input(after.shapes, wall(3), [before, after])));

    expect(restored.historyIndex).toBe(1);
    expect(restored.parameters).toEqual(wall(3));
    expect(restored.history[0]).toMatchObject({ parameters: wall(2), shapes: [{ width: 4 }] });
    expect(restored.history[1]).toMatchObject({ parameters: wall(3), shapes: [{ width: 6 }] });
  });

  it("keeps undo history from files whose states carry no table", async () => {
    const before = editorHistoryEntry([box(4)], []);
    const after = editorHistoryEntry([box(6)], []);
    const exported = await exportSkfProject(input(after.shapes, wall(3), [before, after]));
    const legacy = mutateProject(exported, (document) => {
      document.states.forEach((state) => { delete state.parameters; });
    });

    const restored = await importSkfProject(legacy);

    expect(restored.history).toHaveLength(2);
    expect(restored.history[0]!.parameters).toBeUndefined();
    expect(restored.parameters).toEqual(wall(3));
  });

  it("writes a known empty undo-state table, so undo can clear the table", async () => {
    const empty = editorHistoryEntry([box(4)], [], []);
    const after = editorHistoryEntry([box(6)], [], wall(3));
    const restored = await importSkfProject(await exportSkfProject(input(after.shapes, wall(3), [empty, after])));

    expect(restored.history[0]!.parameters).toEqual([]);
  });

  it("keeps a stale binding and its stored number on load, and flags it", async () => {
    const exported = await exportSkfProject(input([box(4, { width: "wall * 2" })], wall(2)));
    const stale = mutateProject(exported, (document) => {
      sceneDefinitions(document)[0]!.expressions = { width: "missing * 2", sides: "6" };
    });

    const restored = await importSkfProject(stale);

    expect(restored.shapes[0]).toMatchObject({ width: 4, expressions: { width: "missing * 2", sides: "6" } });
    expect(restored.bindingIssues).toEqual([
      expect.objectContaining({ shapeId: "box-1", field: "width", code: "invalidExpression" }),
      expect.objectContaining({ shapeId: "box-1", field: "sides", code: "fieldNotBindable" }),
    ]);
  });

  it("rejects a malformed bindings record", async () => {
    const exported = await exportSkfProject(input([box(4, { width: "wall * 2" })], wall(2)));
    for (const malformed of [["wall"], { width: 4 }, "wall", { "": "wall" }]) {
      const broken = mutateProject(exported, (document) => {
        sceneDefinitions(document)[0]!.expressions = malformed;
      });
      await expect(importSkfProject(broken), JSON.stringify(malformed)).rejects.toThrow(/expressions/);
    }
  });
});
