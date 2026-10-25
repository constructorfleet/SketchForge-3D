import { describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject, type SkfProjectExportInput } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { newerBackupSource, projectBackupEntryNames, storedBackupRevision, projectsBackupFileName, readProjectsBackup, writeProjectsBackup } from "@/lib/projectBackup";
import type { ShapeKind, WorkplaneShape } from "@/types/sketchforge";

function shape(kind: ShapeKind, id: string, x: number): WorkplaneShape {
  return {
    id,
    name: kind,
    kind,
    color: "#12a4cc",
    x,
    z: 0,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 20,
    rotation: 0,
    locked: false,
    hidden: false,
  };
}

function project(projectName: string, modifiedAt: number, shapeCount: number): SkfProjectExportInput {
  const shapes = Array.from({ length: shapeCount }, (_, index) => shape(index % 2 ? "cylinder" : "box", `${projectName}-${index}`, index * 25));
  return {
    projectId: `id-${projectName}-${modifiedAt}`,
    projectName,
    createdAt: 1_700_000_000_000,
    modifiedAt,
    shapes,
    history: [editorHistoryEntry(shapes, [])],
    historyIndex: 0,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
  };
}

describe("project backup ZIP", () => {
  it("re-imports every project with identical shape counts and revisions", async () => {
    const inputs = [
      project("Desk organizer", 1_700_000_100_000, 3),
      project("Key tag", 1_700_000_200_000, 1),
      project("Key tag", 1_700_000_300_000, 0),
    ];
    const entries = await Promise.all(inputs.map(async (input) => ({
      projectName: input.projectName,
      modifiedAt: input.modifiedAt,
      package: await exportSkfProject(input),
    })));

    const backup = writeProjectsBackup(entries);
    const restored = await Promise.all(readProjectsBackup(backup).map(async (entry) => ({
      fileName: entry.fileName,
      project: await importSkfProject(entry.package),
    })));

    expect(restored.map((entry) => entry.fileName)).toEqual(["Desk organizer.skf", "Key tag.skf", "Key tag (2).skf"]);
    expect(restored.map((entry) => entry.project.projectName)).toEqual(inputs.map((input) => input.projectName));
    expect(restored.map((entry) => entry.project.shapes.length)).toEqual([3, 1, 0]);
    expect(restored.map((entry) => entry.project.modifiedAt)).toEqual(inputs.map((input) => input.modifiedAt));
  });

  it("holds only the .skf packages, stored byte for byte, with no generated thumbnails", async () => {
    const packageBytes = await exportSkfProject(project("Bracket", 1_700_000_100_000, 2));
    const backup = writeProjectsBackup([{ projectName: "Bracket", modifiedAt: 1_700_000_100_000, package: packageBytes }]);
    const compression: Record<string, number> = {};
    const files = unzipSync(backup, { filter: (file) => {
      compression[file.name] = file.compression;
      return true;
    } });

    expect(compression).toEqual({ "Bracket.skf": 0 });

    expect(Object.keys(files)).toEqual(["Bracket.skf"]);
    expect(files["Bracket.skf"]).toEqual(packageBytes);
    expect(Object.keys(unzipSync(files["Bracket.skf"])).filter((name) => /thumbnail|\.png$/i.test(name))).toEqual([]);
  });

  it("names entries safely and uniquely, ignoring case", () => {
    expect(projectBackupEntryNames(["a/b", "A/B", "  ", "Plate.", "plate"])).toEqual([
      "a-b.skf",
      "A-B (2).skf",
      "SketchForge design.skf",
      "Plate.skf",
      "plate (2).skf",
    ]);
  });

  it("never names an entry after a Windows device or as a hidden file", () => {
    expect(projectBackupEntryNames(["CON", "nul", "Aux.backup", "COM1", "lpt9", "PRN ", ".hidden", "...", "COM0", "Console", "LPT10"])).toEqual([
      "_CON.skf",
      "_nul.skf",
      "_Aux.backup.skf",
      "_COM1.skf",
      "_lpt9.skf",
      "_PRN.skf",
      "hidden.skf",
      "SketchForge design.skf",
      "COM0.skf",
      "Console.skf",
      "LPT10.skf",
    ]);
    expect(projectBackupEntryNames(["CONIN$", "conout$", "COM\u00b9", "com\u00b2", "COM\u00b3", "LPT\u00b9", "lpt\u00b2", "LPT\u00b3", "CONIN", "COM\u2074"])).toEqual([
      "_CONIN$.skf",
      "_conout$.skf",
      "_COM\u00b9.skf",
      "_com\u00b2.skf",
      "_COM\u00b3.skf",
      "_LPT\u00b9.skf",
      "_lpt\u00b2.skf",
      "_LPT\u00b3.skf",
      "CONIN.skf",
      "COM\u2074.skf",
    ]);
  });

  it("ignores entries that are not project packages when reading", () => {
    const backup = zipSync({
      "Only.skf": new Uint8Array([1, 2, 3]),
      "Only.skf.png": new Uint8Array([4]),
      "notes.txt": new Uint8Array([5]),
      "nested/Other.skf": new Uint8Array([6]),
    });
    expect(readProjectsBackup(backup)).toEqual([{ fileName: "Only.skf", package: new Uint8Array([1, 2, 3]) }]);
  });

  it("backs up whichever copy of a project has the higher revision", () => {
    const inSession = { revision: 20, label: "in session" };
    const stored = { revision: 30, label: "stored by another tab" };
    expect(newerBackupSource(inSession, stored)).toBe(stored);
    expect(newerBackupSource({ revision: 40, label: "unsaved edit" }, stored)?.label).toBe("unsaved edit");
    expect(newerBackupSource({ revision: 30, label: "same revision" }, stored)?.label).toBe("same revision");
    expect(newerBackupSource(null, stored)).toBe(stored);
    expect(newerBackupSource(inSession, null)).toBe(inSession);
    expect(newerBackupSource(null, null)).toBeNull();
  });

  it("treats a stored package without a modification time as the oldest revision", () => {
    // A browser record carries its own revision.
    expect(storedBackupRevision({ revision: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    // A server package's revision is its modifiedAt; a missing one must not stand in as "now".
    expect(storedBackupRevision({ revision: Date.now(), packageModifiedAt: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(storedBackupRevision({ revision: Date.now(), packageModifiedAt: 0 })).toBe(0);
    expect(storedBackupRevision({ revision: Date.now(), packageModifiedAt: Number.NaN })).toBe(0);
    const unsaved = { revision: 1_700_000_500_000, label: "unsaved edit" };
    const serverCopy = { revision: storedBackupRevision({ revision: Date.now(), packageModifiedAt: 0 }), label: "server" };
    expect(newerBackupSource(unsaved, serverCopy)?.label).toBe("unsaved edit");
  });

  it("names the archive by date", () => {
    expect(projectsBackupFileName(new Date(2026, 9, 5, 14, 30))).toBe("sketchforge-projects-2026-10-05.zip");
  });
});
