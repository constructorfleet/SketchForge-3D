import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject, type SkfProjectDocumentV1, type SkfProjectExportInput } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE, normalizeWorkspaceSettings } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { workplaneShapesEqual } from "@constructorfleet/sketchforge-engine/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "box-1",
    name: "box",
    kind: "box",
    color: "#12a4cc",
    x: 1,
    z: 2,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 20,
    rotation: 0,
    ...overrides,
  };
}

function input(shapes: WorkplaneShape[], overrides: Partial<SkfProjectExportInput> = {}): SkfProjectExportInput {
  return {
    projectName: "Materials",
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_100_000,
    shapes,
    history: [editorHistoryEntry(shapes, [])],
    historyIndex: 0,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    ...overrides,
  };
}

function documentOf(bytes: Uint8Array) {
  return JSON.parse(strFromU8(unzipSync(bytes)["project.json"])) as SkfProjectDocumentV1;
}

function rewrite(bytes: Uint8Array, mutate: (document: SkfProjectDocumentV1) => void) {
  const files = unzipSync(bytes);
  const document = JSON.parse(strFromU8(files["project.json"])) as SkfProjectDocumentV1;
  mutate(document);
  files["project.json"] = strToU8(JSON.stringify(document));
  return zipSync(files);
}

describe("material in the .skf project format", () => {
  it("round-trips the chosen material through export and import", async () => {
    const bytes = await exportSkfProject(input([shape({ material: "petg" })]));
    const restored = await importSkfProject(bytes);
    expect(restored.shapes[0].material).toBe("petg");
    expect(restored.history[0].shapes[0].material).toBe("petg");
  });

  it("stores the material as a plain field on the shape definition", async () => {
    const document = documentOf(await exportSkfProject(input([shape({ material: "abs" })])));
    const node = document.states[0].nodes[0];
    expect((node.definition as Record<string, unknown>).material).toBe("abs");
    // Nothing about a material needs an archive asset of its own.
    expect(document.assets).toEqual([]);
  });

  it("round-trips a material on a grouped child", async () => {
    const child = shape({ id: "child-1", material: "tpu" });
    const group = shape({ id: "group-1", groupedShapes: [child] });
    const restored = await importSkfProject(await exportSkfProject(input([group])));
    expect(restored.shapes[0].groupedShapes?.[0].material).toBe("tpu");
  });

  it("opens a project written before materials existed", async () => {
    const bytes = await exportSkfProject(input([shape()]));
    const document = documentOf(bytes);
    expect("material" in (document.states[0].nodes[0].definition as Record<string, unknown>)).toBe(false);
    const restored = await importSkfProject(bytes);
    expect(restored.shapes[0].material).toBeUndefined();
  });

  it("keeps a material id this build does not know rather than dropping or coercing it", async () => {
    const bytes = rewrite(await exportSkfProject(input([shape({ material: "pla" })])), (document) => {
      (document.states[0].nodes[0].definition as Record<string, unknown>).material = "future-polymer";
    });
    const restored = await importSkfProject(bytes);
    expect(restored.shapes[0].material).toBe("future-polymer");
  });

  /**
   * The reason a project saved with a material still opens in a build that has
   * never heard of one: the reader validates the fields it knows and carries
   * every other definition field through untouched. An unknown field standing
   * in for `material` exercises exactly that path.
   */
  it("carries definition fields it does not know through import untouched", async () => {
    const bytes = rewrite(await exportSkfProject(input([shape()])), (document) => {
      (document.states[0].nodes[0].definition as Record<string, unknown>).materialFinish = "matte";
    });
    const restored = await importSkfProject(bytes);
    expect((restored.shapes[0] as unknown as Record<string, unknown>).materialFinish).toBe("matte");
  });

  it("rejects a material that is not a string", async () => {
    const bytes = rewrite(await exportSkfProject(input([shape()])), (document) => {
      (document.states[0].nodes[0].definition as Record<string, unknown>).material = 7;
    });
    await expect(importSkfProject(bytes)).rejects.toThrow();
  });

  it("round-trips the user's material prices with the project settings", async () => {
    const workspace = normalizeWorkspaceSettings({ ...DEFAULT_WORKPLANE_WORKSPACE, materialPricesPerKg: { pla: 27.5 } });
    const restored = await importSkfProject(await exportSkfProject(input([shape({ material: "pla" })], { workspace })));
    expect(restored.workspace.materialPricesPerKg).toEqual({ pla: 27.5 });
  });

  it("defaults the prices to none for a project saved before the setting existed", async () => {
    const bytes = rewrite(await exportSkfProject(input([shape()])), (document) => {
      delete (document.editor.workspace as unknown as Record<string, unknown>).materialPricesPerKg;
    });
    const restored = await importSkfProject(bytes);
    expect(restored.workspace.materialPricesPerKg).toEqual({});
  });

  it("treats a changed material as a change to the shape", () => {
    const pla = shape({ material: "pla" });
    expect(workplaneShapesEqual(pla, shape({ material: "pla" }))).toBe(true);
    expect(workplaneShapesEqual(pla, shape({ material: "petg" }))).toBe(false);
    expect(workplaneShapesEqual(pla, shape())).toBe(false);
  });
});
