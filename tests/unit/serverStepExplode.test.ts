import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { importedShapeFromStepOnKernel } from "@constructorfleet/sketchforge-engine/stepImportKernel";
import { explodeStepAssembly } from "@constructorfleet/sketchforge-engine/serverStepExplode";
import { restoreGroupedChildren } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import type { ProjectAsset } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

describe("STEP assembly explosion", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("rebuilds a real STEP product tree as editable nested project groups", async () => {
    const step = await readFile(new URL("../fixtures/step/nested-assembly.step", import.meta.url), "utf8");
    const bytes = new TextEncoder().encode(step);
    const source: ProjectAsset = { id: "source", name: "nested-assembly.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const imported = await importedShapeFromStepOnKernel(source.name, step);
    imported.shape.importedMesh!.assetId = source.id;

    const result = await explodeStepAssembly(imported.shape, source);

    expect(imported.shape.stepAssembly?.[0]?.name).toBe("MainAssembly");
    expect(result).toHaveLength(1);
    const root = result[0]!;
    expect(root.name).toBe("MainAssembly");
    expect(root.groupedShapes?.map((part) => part.name)).toEqual(["Frame", "Sensors"]);
    const sensors = root.groupedShapes?.find((part) => part.name === "Sensors");
    expect(sensors?.groupedShapes?.map((part) => part.name)).toEqual(["SensorLeft", "SensorRight"]);

    const leaves = [root.groupedShapes?.[0], ...sensors?.groupedShapes ?? []].filter((part) => part && !part.groupedShapes?.length);
    expect(leaves).toHaveLength(3);
    expect(leaves.every((part) => part!.importedMesh?.positions.length && part!.importedMesh.brepStep)).toBe(true);
    expect(leaves.every((part) => part!.stepComponent?.path.length === 2 || part!.stepComponent?.path.length === 3)).toBe(true);
    expect(leaves.map((part) => part!.stepComponent?.path.at(-1)?.name).sort()).toEqual(["Frame", "SensorLeft", "SensorRight"]);

    const flat = await explodeStepAssembly({ ...imported.shape, stepAssembly: undefined }, source);
    const restored = restoreGroupedChildren(root).flatMap((part) => part.groupedShapes?.length ? restoreGroupedChildren(part) : [part]);
    expect(restored.map(({ name, x, z, elevation }) => ({ name, x, z, elevation })).sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual(flat.map(({ name, x, z, elevation }) => ({ name, x, z, elevation })).sort((a, b) => a.name.localeCompare(b.name)));
  });

  it("uses stable occurrence ids when stored tree order differs", async () => {
    const step = await readFile(new URL("../fixtures/step/nested-assembly.step", import.meta.url), "utf8");
    const bytes = new TextEncoder().encode(step);
    const source: ProjectAsset = { id: "source", name: "nested-assembly.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const imported = await importedShapeFromStepOnKernel(source.name, step);
    imported.shape.importedMesh!.assetId = source.id;

    // A stored tree's order is not proof that it matches OCCT's solid order.
    // Reverse the two uniquely named sensor leaves but keep their identities.
    const sensors = imported.shape.stepAssembly?.[0]?.children.find((node) => node.name === "Sensors");
    expect(sensors?.children.map((node) => node.name)).toEqual(["SensorLeft", "SensorRight"]);
    sensors!.children.reverse();

    const parts = await explodeStepAssembly(imported.shape, source);
    expect(parts).toHaveLength(1);
    const restored = restoreGroupedChildren(parts[0]!).flatMap((part) => part.groupedShapes?.length ? restoreGroupedChildren(part) : [part]);
    expect(restored.map((part) => [part.name, part.stepComponent?.path.at(-1)?.name]).sort())
      .toEqual([["Frame", "Frame"], ["SensorLeft", "SensorLeft"], ["SensorRight", "SensorRight"]]);
    expect(restored.every((part) => part.importedMesh?.positions.length && part.importedMesh.brepStep)).toBe(true);
  });

  it("falls back to flat solids when an occurrence cannot be matched to the stored source tree", async () => {
    const step = await readFile(new URL("../fixtures/step/nested-assembly.step", import.meta.url), "utf8");
    const bytes = new TextEncoder().encode(step);
    const source: ProjectAsset = { id: "source", name: "nested-assembly.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const imported = await importedShapeFromStepOnKernel(source.name, step);
    imported.shape.importedMesh!.assetId = source.id;
    imported.shape.stepAssembly![0]!.children[0]!.id = "step-occurrence:missing";

    const parts = await explodeStepAssembly(imported.shape, source);

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.importedMesh?.positions.length && part.importedMesh.brepStep)).toBe(true);
    expect(parts.every((part) => !part.groupedShapes?.length)).toBe(true);
  });

  it("preserves STEP product names when exploding a multi-product STEP file", async () => {
    const step = await withCadKernel((cad) => {
      const document = cad.createXCAFDocument();
      try {
        const first = cad.makeBox(10, 8, 6);
        const second = cad.translate(cad.makeBox(5, 4, 3), 20, 0, 0);
        document.addShape(first, { name: "Red Housing", color: [0.8, 0.1, 0.2] });
        document.addShape(second, { name: "Blue Pin", color: [0.1, 0.2, 0.9] });
        return document.exportSTEP();
      } finally {
        document.close();
      }
    });
    const bytes = new TextEncoder().encode(step);
    const source: ProjectAsset = { id: "source", name: "named.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const imported = await importedShapeFromStepOnKernel(source.name, step);
    imported.shape.importedMesh!.assetId = source.id;

    const faceGroups = imported.shape.importedMesh!.faceGroups ?? [];
    expect(faceGroups.length).toBeGreaterThan(0);
    expect(faceGroups.every((value, index) => index % 3 !== 2 || Number.isInteger(value) && value >= 0)).toBe(true);

    const parts = await explodeStepAssembly(imported.shape, source);

    expect(parts.map((part) => part.name).sort()).toEqual(["Blue Pin", "Red Housing"]);
    expect(Object.fromEntries(parts.map(({ name, color }) => [name, color]))).toEqual({
      "Blue Pin": "#1a33e5",
      "Red Housing": "#cc1a33",
    });
  });

  it("does not use GLB name colors for duplicate XCAF component names", async () => {
    const step = await withCadKernel((cad) => {
      const document = cad.createXCAFDocument();
      try {
        document.addShape(cad.makeBox(10, 8, 6), { name: "Repeated", color: [0.8, 0.1, 0.2] });
        document.addShape(cad.translate(cad.makeBox(5, 4, 3), 20, 0, 0), { name: "Repeated" });
        return document.exportSTEP();
      } finally {
        document.close();
      }
    });
    const bytes = new TextEncoder().encode(step);
    const source: ProjectAsset = { id: "source", name: "duplicate.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const imported = await importedShapeFromStepOnKernel(source.name, step);
    imported.shape.importedMesh!.assetId = source.id;

    const parts = await explodeStepAssembly(imported.shape, source);

    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.color)).toEqual(["#0098c7", "#0098c7"]);
  });

  it("returns separately positioned solids with exact BREP geometry", async () => {
    const step = await withCadKernel((cad) => {
      const first = cad.makeBox(10, 8, 6);
      const second = cad.translate(cad.makeBox(5, 4, 3), 20, 0, 0);
      return cad.exportStep(cad.makeCompound([first, second]));
    });
    const bytes = new TextEncoder().encode(step);
    const source: ProjectAsset = { id: "source", name: "assembly.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const imported = await importedShapeFromStepOnKernel(source.name, step);
    imported.shape.importedMesh!.assetId = source.id;

    const parts = await explodeStepAssembly(imported.shape, source);

    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.importedMesh?.brepStep && !part.importedMesh.assetId)).toBe(true);
    const properties = await Promise.all(parts.map(shapeProperties));
    expect(properties.map((entry) => entry.volume).sort((a, b) => a - b)).toEqual([60, 480]);
    expect(properties.map((entry) => entry.centerOfMass.x).sort((a, b) => a - b)).toEqual([-7.5, 10]);
  });

  it("replaces the imported assembly in one project write", async () => {
    const step = await withCadKernel((cad) => cad.exportStep(cad.makeCompound([
      cad.makeBox(10, 8, 6), cad.translate(cad.makeBox(5, 4, 3), 20, 0, 0),
    ])));
    const bytes = new TextEncoder().encode(step);
    const source: ProjectAsset = { id: "asset", name: "case.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const original = await importedShapeFromStepOnKernel(source.name, step);
    original.shape.importedMesh!.assetId = source.id;
    const document: ProjectDocument = {
      metadata: { revision: 0 }, projectName: "test", createdAt: 0, shapes: [original.shape], history: [], historyIndex: -1,
      assets: [source], workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
      placementWorkplane: horizontalPlacementWorkplane(), sketchPlacementWorkplane: horizontalPlacementWorkplane(),
    };
    let writes = 0;
    const store: ProjectStore = {
      read: async () => document,
      write: async (_id, _previous, shapes) => { writes += 1; document.shapes = shapes; return { revision: writes }; },
      withLock: async <T>(_id: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
      list: async () => [],
    };

    const outcome = await createEngine(store).explode("p1", original.shape.id);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.shapes).toHaveLength(2);
    expect(writes).toBe(1);
    expect(document.shapes).toHaveLength(2);
  });
});
