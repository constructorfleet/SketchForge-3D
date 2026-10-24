import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { importedShapeFromStepOnKernel } from "@constructorfleet/sketchforge-engine/stepImportKernel";
import { restoreGroupedChildren } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import { explodeStepAssembly } from "@constructorfleet/sketchforge-engine/serverStepExplode";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import type { ProjectAsset, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { canExplodeStepAssembly, explodeAssemblyInScene } from "@/lib/assemblyExplode";

async function nestedAssembly() {
  const step = await readFile(new URL("../fixtures/step/nested-assembly.step", import.meta.url), "utf8");
  const bytes = new TextEncoder().encode(step);
  const source: ProjectAsset = { id: "source", name: "nested-assembly.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
  const imported = await importedShapeFromStepOnKernel(source.name, step);
  imported.shape.importedMesh!.assetId = source.id;
  return { shape: imported.shape, source };
}

const box = (id: string): WorkplaneShape => ({ id, name: id, kind: "box", color: "#000", x: 0, z: 0, elevation: 0, size: 10, width: 10, depth: 10, height: 10, rotation: 0 });

function leafNames(shape: WorkplaneShape): string[] {
  return shape.groupedShapes?.length ? restoreGroupedChildren(shape).flatMap(leafNames) : [shape.name];
}

describe("exploding a STEP assembly in the editor", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("offers the action only for a STEP import with a product tree and its source", async () => {
    const { shape } = await nestedAssembly();
    expect(canExplodeStepAssembly(shape)).toBe(true);
    expect(canExplodeStepAssembly({ ...shape, stepAssembly: undefined })).toBe(false);
    expect(canExplodeStepAssembly({ ...shape, stepAssembly: [] })).toBe(false);
    expect(canExplodeStepAssembly({ ...shape, importedMesh: { ...shape.importedMesh!, assetId: undefined } })).toBe(false);
    expect(canExplodeStepAssembly({ ...shape, importedMesh: { ...shape.importedMesh!, sourceFormat: "stl" } })).toBe(false);
    expect(canExplodeStepAssembly(box("plain"))).toBe(false);
  });

  it("replaces the assembly in place with the nested product groups", async () => {
    const { shape, source } = await nestedAssembly();
    const before = box("before");
    const after = box("after");

    const result = await explodeAssemblyInScene([before, shape, after], shape.id, [source]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hierarchy).toBe("nested");
    expect(result.parts).toHaveLength(1);
    expect(result.shapes.map((entry) => entry.id)).toEqual(["before", result.parts[0]!.id, "after"]);
    const root = result.parts[0]!;
    expect(root.name).toBe("MainAssembly");
    expect(root.groupedShapes?.map((part) => part.name)).toEqual(["Frame", "Sensors"]);
    expect(root.groupedShapes?.find((part) => part.name === "Sensors")?.groupedShapes?.map((part) => part.name)).toEqual(["SensorLeft", "SensorRight"]);
    expect(leafNames(root).sort()).toEqual(["Frame", "SensorLeft", "SensorRight"]);

    // The editor runs on the browser kernel, the server on its own; each leaf
    // must land with the same solid in the same place either way.
    const leaves = (shape: WorkplaneShape): WorkplaneShape[] => shape.groupedShapes?.length ? restoreGroupedChildren(shape).flatMap(leaves) : [shape];
    const measured = async (parts: WorkplaneShape[]) => Object.fromEntries(await Promise.all(parts.flatMap(leaves).map(async (part) => {
      const { volume, centerOfMass } = await shapeProperties(part);
      // `+ 0` folds -0 into 0 so a centred axis compares equal.
      return [part.name, [volume, centerOfMass.x, centerOfMass.y, centerOfMass.z].map((value) => Number(value.toFixed(3)) + 0)] as const;
    })));
    const editorLeaves = await measured(result.parts);
    expect(editorLeaves).toEqual(await measured(await explodeStepAssembly(shape, source)));
    // [volume mm3, centre of mass x, y, z]: a 16x20x2 frame on the floor and
    // two 2x2x4 sensors standing on it either side of centre.
    expect(editorLeaves).toEqual({
      Frame: [640, 0, 1, 0],
      SensorLeft: [16, -4, 4, 0],
      SensorRight: [16, 4, 4, 0],
    });
  });

  it("reports the flat fallback when a source occurrence cannot be matched", async () => {
    const { shape, source } = await nestedAssembly();
    shape.stepAssembly![0]!.children[0]!.id = "step-occurrence:missing";

    const result = await explodeAssemblyInScene([shape], shape.id, [source]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hierarchy).toBe("flat");
    expect(result.parts).toHaveLength(3);
    expect(result.parts.every((part) => !part.groupedShapes?.length)).toBe(true);
    expect(result.shapes.map((entry) => entry.id)).toEqual(result.parts.map((part) => part.id));
  });

  it("refuses a locked shape, a missing source, and a missing shape with a localized reason", async () => {
    const { shape, source } = await nestedAssembly();

    expect(await explodeAssemblyInScene([{ ...shape, locked: true }], shape.id, [source])).toEqual({ ok: false, messageKey: "editor.explode.unlock" });
    expect(await explodeAssemblyInScene([shape], shape.id, [])).toEqual({ ok: false, messageKey: "editor.explode.sourceMissing" });
    expect(await explodeAssemblyInScene([shape], "absent", [source])).toEqual({ ok: false, messageKey: "editor.explode.selectOne" });
  });

  it("refuses a source with a single solid", async () => {
    const { shape, source } = await nestedAssembly();
    // The fixture has three solids; a one-box STEP file is made from scratch.
    const { withCadKernel } = await import("@constructorfleet/sketchforge-engine/serverCadKernel");
    const oneBox = await withCadKernel((cad) => cad.exportStep(cad.makeBox(4, 4, 4)));
    const bytes = new TextEncoder().encode(oneBox);
    const oneSource: ProjectAsset = { ...source, id: "one", bytes, byteLength: bytes.byteLength };
    const target = { ...shape, importedMesh: { ...shape.importedMesh!, assetId: "one" } };

    expect(await explodeAssemblyInScene([target], target.id, [oneSource])).toEqual({ ok: false, messageKey: "editor.explode.singleSolid" });
  });
});
