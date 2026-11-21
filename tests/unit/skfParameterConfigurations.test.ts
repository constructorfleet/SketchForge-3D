import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { editorHistoryEntry, type ProjectConfigurationState } from "@constructorfleet/sketchforge-engine/editorHistory";
import {
  exportSkfProject,
  importSkfProject,
  inspectSkfProjectPackage,
  SKF_FORMAT_VERSION,
  type SkfProjectDocumentV1,
  type SkfProjectExportInput,
} from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { ProjectParameter, WorkplaneShape } from "@/types/sketchforge";

// Base wall = 2, depth = wall * 5. Large overrides wall = 4.
const table = (wall: number): ProjectParameter[] => [
  { name: "wall", expression: "2", dimension: "length", value: wall },
  { name: "depth", expression: "wall * 5", dimension: "length", value: wall * 5 },
];
const rows = (activeConfiguration: string | null): ProjectConfigurationState => ({
  configurations: [{ name: "Small", overrides: {} }, { name: "Large", overrides: { wall: "4" } }],
  activeConfiguration,
});

function box(width: number): WorkplaneShape {
  return {
    id: "box-1", name: "Box", kind: "box", color: "#12a4cc",
    x: 0, z: 0, elevation: 0, size: width, width, depth: 10, height: 10, rotation: 0,
    expressions: { width: "wall * 2" },
  };
}

function input(
  shapes: WorkplaneShape[],
  parameters: ProjectParameter[],
  configuration: ProjectConfigurationState | undefined,
  history = [editorHistoryEntry(shapes, [], parameters, configuration)],
): SkfProjectExportInput {
  return {
    projectId: "configurations",
    projectName: "Configurations",
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
    ...configuration,
  } as SkfProjectExportInput;
}

function packageDocument(bytes: Uint8Array) {
  return JSON.parse(strFromU8(unzipSync(bytes)["project.json"])) as SkfProjectDocumentV1;
}

function mutateProject(bytes: Uint8Array, mutate: (document: SkfProjectDocumentV1) => void) {
  const files = unzipSync(bytes);
  const document = JSON.parse(strFromU8(files["project.json"])) as SkfProjectDocumentV1;
  mutate(document);
  files["project.json"] = strToU8(JSON.stringify(document));
  return zipSync(files);
}

describe(".skf parameter configurations", () => {
  it("round-trips configurations and the active name as format 4, which format 3 readers refuse", async () => {
    const exported = await exportSkfProject(input([box(8)], table(4), rows("Large")));
    const document = packageDocument(exported);

    expect(SKF_FORMAT_VERSION).toBe(4);
    expect(document.formatVersion).toBe(4);
    // A format 3 reader refuses a newer format instead of dropping the configurations.
    expect(document.minimumReaderVersion).toBe(4);
    expect(document.configurations).toEqual(rows("Large").configurations);
    expect(document.activeConfiguration).toBe("Large");
    expect(document.parameters).toEqual(table(4));
    await expect(inspectSkfProjectPackage(exported)).resolves.toMatchObject({ formatVersion: 4 });

    const restored = await importSkfProject(exported);
    expect(restored.configurations).toEqual(rows("Large").configurations);
    expect(restored.activeConfiguration).toBe("Large");
    expect(restored.parameters).toEqual(table(4));
    expect(restored.configurationIssues).toEqual([]);
  });

  it("keeps format 3 and 2 for projects without configurations, and omits the fields", async () => {
    const withTable = packageDocument(await exportSkfProject(input([box(4)], table(2), undefined)));
    expect(withTable.formatVersion).toBe(3);
    expect("configurations" in withTable).toBe(false);
    expect("activeConfiguration" in withTable).toBe(false);

    const plain = packageDocument(await exportSkfProject(input([{ ...box(4), expressions: undefined }], [], { configurations: [], activeConfiguration: null })));
    expect(plain.formatVersion).toBe(2);

    const restored = await importSkfProject(await exportSkfProject(input([box(4)], table(2), undefined)));
    expect(restored.configurations).toEqual([]);
    expect(restored.activeConfiguration).toBeNull();
  });

  it("writes the active name only when a configuration is active", async () => {
    const document = packageDocument(await exportSkfProject(input([box(4)], table(2), rows(null))));
    expect(document.formatVersion).toBe(4);
    expect("activeConfiguration" in document).toBe(false);
    expect((await importSkfProject(await exportSkfProject(input([box(4)], table(2), rows(null))))).activeConfiguration).toBeNull();
  });

  it("restores each undo state with its configurations, so undoing an activation restores the base", async () => {
    const before = editorHistoryEntry([box(4)], [], table(2), rows(null));
    const after = editorHistoryEntry([box(8)], [], table(4), rows("Large"));
    const restored = await importSkfProject(await exportSkfProject(input(after.shapes, table(4), rows("Large"), [before, after])));

    expect(restored.historyIndex).toBe(1);
    expect(restored.history[0]).toMatchObject({ ...rows(null), parameters: table(2), shapes: [{ width: 4 }] });
    expect(restored.history[1]).toMatchObject({ ...rows("Large"), parameters: table(4), shapes: [{ width: 8 }] });
  });

  it("keeps an undo state without configurations unknown when only another undo state has some", async () => {
    const legacy = editorHistoryEntry([box(5)], [], table(2));
    const large = editorHistoryEntry([box(8)], [], table(4), rows("Large"));
    const scene = editorHistoryEntry([box(4)], [], table(2), { configurations: [], activeConfiguration: null });
    const exported = await exportSkfProject(input(scene.shapes, table(2), { configurations: [], activeConfiguration: null }, [legacy, large, scene]));
    expect(packageDocument(exported).formatVersion).toBe(4);

    const restored = await importSkfProject(exported);
    expect(restored.history[0]!.configurations).toBeUndefined();
    expect(restored.history[1]).toMatchObject(rows("Large"));
  });

  it("does not merge an unknown undo state with a known empty one that has the same fingerprint, in either order", async () => {
    const unknownRows = editorHistoryEntry([box(4)], [], table(2));
    const emptyRows = editorHistoryEntry([box(4)], [], table(2), { configurations: [], activeConfiguration: null });
    const unknownTable = editorHistoryEntry([box(5)], []);
    const emptyTable = editorHistoryEntry([box(5)], [], [], { configurations: [], activeConfiguration: null });
    const scene = editorHistoryEntry([box(4)], [], table(2), rows(null));
    expect(unknownRows.fingerprint).toBe(emptyRows.fingerprint);
    expect(unknownTable.fingerprint).toBe(emptyTable.fingerprint);
    const known = (entry: { configurations?: unknown; parameters?: unknown }) =>
      `${Array.isArray(entry.parameters) ? "p" : "-"}${Array.isArray(entry.configurations) ? "c" : "-"}`;

    for (const order of [[unknownRows, emptyRows, unknownTable, emptyTable], [emptyRows, unknownRows, emptyTable, unknownTable]]) {
      const history = [...order, scene];
      const restored = await importSkfProject(await exportSkfProject(input(scene.shapes, table(2), rows(null), history)));
      expect(restored.history.map(known)).toEqual(history.map(known));
    }
  });

  it("recomputes values under the active configuration instead of trusting stored ones", async () => {
    const exported = mutateProject(await exportSkfProject(input([box(8)], table(4), rows("Large"))), (document) => {
      document.parameters![0]!.value = 999;
    });
    expect((await importSkfProject(exported)).parameters).toEqual(table(4));
  });

  it("keeps a stale override with its last value and reports it", async () => {
    const exported = mutateProject(await exportSkfProject(input([box(8)], table(4), rows("Large"))), (document) => {
      document.configurations![1]!.overrides.wall = "4 deg";
      document.configurations![0]!.overrides.gone = "1";
    });
    const restored = await importSkfProject(exported);

    expect(restored.configurations[1]!.overrides).toEqual({ wall: "4 deg" });
    expect(restored.parameters[0]).toMatchObject({ name: "wall", expression: "2", value: 4, error: { code: "invalidExpression", configuration: "Large" } });
    expect(restored.shapes[0]!.width).toBe(8);
    expect(restored.configurationIssues.map(({ configuration, parameter }) => [configuration, parameter])).toEqual([
      ["Small", "gone"], ["Large", "wall"], ["Large", "depth"],
    ]);
  });

  it("rejects malformed configurations and an unknown active name", async () => {
    const exported = await exportSkfProject(input([box(8)], table(4), rows("Large")));
    const cases: Array<[string, (document: SkfProjectDocumentV1) => void]> = [
      ["not a list", (document) => { (document as { configurations: unknown }).configurations = {}; }],
      ["duplicate name", (document) => { document.configurations![0]!.name = "Large"; }],
      ["blank name", (document) => { document.configurations![0]!.name = " "; }],
      ["non-text override", (document) => { (document.configurations![1]!.overrides as Record<string, unknown>).wall = 4; }],
      ["unknown active", (document) => { document.activeConfiguration = "Medium"; }],
      ["active without configurations", (document) => { document.configurations = []; }],
    ];
    for (const [label, mutate] of cases) {
      await expect(importSkfProject(mutateProject(exported, mutate)), label).rejects.toThrow(/configuration/i);
    }
  });
});
