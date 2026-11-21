import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEngine,
  directoryProjectStore,
  exportProjectScene,
  importSkfProject,
  type EngineResult,
  type ProjectStore,
} from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { measureMesh } from "./support/meshMeasure";

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

function stlMeasure(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const positions: number[] = [];
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const offset = 84 + triangle * 50 + 12;
    for (let index = 0; index < 9; index += 1) positions.push(view.getFloat32(offset + index * 4, true));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const measured = measureMesh(geometry);
  geometry.dispose();
  return measured;
}

describe("parameter configurations in the engine", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  async function document(projectId: string) {
    return (await store.read(projectId))!;
  }

  /** Two boxes: one sized by `wall`, one placed by it. Large sets wall = 4 mm; Small keeps the base 2 mm. */
  async function configuredBoxes(projectId: string) {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
    const [sized, placed] = value(await engine.addShapes(projectId, [
      { kind: "box", width: 10, depth: 10, height: 10 },
      { kind: "box", width: 4, depth: 4, height: 4, x: 0 },
    ])).shapes;
    value(await engine.addParameter(projectId, { name: "wall", expression: "2", dimension: "length" }));
    value(await engine.bindShapeField(projectId, sized!.id, "width", "wall * 5"));
    value(await engine.bindShapeField(projectId, placed!.id, "x", "wall * 10"));
    value(await engine.addConfiguration(projectId, "Small"));
    value(await engine.addConfiguration(projectId, "Large", { wall: "4" }));
    return { sized: sized!.id, placed: placed!.id };
  }

  async function unchanged(projectId: string, run: () => Promise<EngineResult<unknown>>) {
    const before = await document(projectId);
    const result = await run();
    const after = await document(projectId);
    expect(after.metadata.revision).toBe(before.metadata.revision);
    expect(after.shapes).toEqual(before.shapes);
    expect(after.parameters).toEqual(before.parameters);
    expect(after.configurations).toEqual(before.configurations);
    expect(after.activeConfiguration).toEqual(before.activeConfiguration);
    expect(after.history).toHaveLength(before.history.length);
    return result;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-configurations-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stores configurations without changing geometry, and persists them", async () => {
    const { sized } = await configuredBoxes("store");
    const stored = await document("store");

    expect(stored.configurations).toEqual([{ name: "Small", overrides: {} }, { name: "Large", overrides: { wall: "4" } }]);
    expect(stored.activeConfiguration).toBeNull();
    expect(stored.parameters).toEqual([{ name: "wall", expression: "2", dimension: "length", value: 2 }]);
    expect(stored.shapes.find((shape) => shape.id === sized)?.width).toBe(10);

    const skf = await importSkfProject((await exportProjectScene(stored, { format: "skf" })).data);
    expect(skf.configurations).toEqual(stored.configurations);

    value(await engine.activateConfiguration("store", "Large"));
    value(await engine.addShapes("store", [{ kind: "box", width: 4, x: 60 }]));
    const kept = await document("store");
    expect(kept.configurations).toEqual(stored.configurations);
    expect(kept.activeConfiguration).toBe("Large");
    expect(kept.history[kept.historyIndex]).toMatchObject({ activeConfiguration: "Large", configurations: stored.configurations });
  }, CAD_TEST_TIMEOUT_MS);

  it("activates a configuration in one write and one undo step, and exports its geometry", async () => {
    const { sized, placed } = await configuredBoxes("activate");
    const before = await document("activate");
    const baseStl = stlMeasure((await exportProjectScene(before, { format: "stl", shapeIds: [sized] })).data);

    const activated = value(await engine.activateConfiguration("activate", "Large"));

    expect(activated.activeConfiguration).toBe("Large");
    expect(activated.parameters).toEqual([{ name: "wall", expression: "2", dimension: "length", value: 4 }]);
    expect(activated.shapes.map((shape) => shape.id).sort()).toEqual([sized, placed].sort());
    const after = await document("activate");
    expect(after.activeConfiguration).toBe("Large");
    expect(after.history).toHaveLength(before.history.length + 1);
    const sizedProperties = value(await engine.properties("activate", sized));
    expect(sizedProperties.volume).toBeCloseTo(20 * 10 * 10, 3);
    expect(sizedProperties.centerOfMass).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(5, 6), z: expect.closeTo(0, 6) });
    const placedProperties = value(await engine.properties("activate", placed));
    expect(placedProperties.volume).toBeCloseTo(64, 3);
    expect(placedProperties.centerOfMass).toMatchObject({ x: expect.closeTo(40, 6), y: expect.closeTo(2, 6), z: expect.closeTo(0, 6) });

    // The export follows the active configuration: 1000 mm3 under the base, 2000 mm3 under Large.
    const largeStl = stlMeasure((await exportProjectScene(after, { format: "stl", shapeIds: [sized] })).data);
    expect(baseStl.volume).toBeCloseTo(1000, 1);
    expect(largeStl.volume).toBeCloseTo(2000, 1);
    expect(largeStl.centroid[0]).toBeCloseTo(0, 4);
    expect(Math.abs(largeStl.centroid[1]) + Math.abs(largeStl.centroid[2])).toBeCloseTo(5, 4);
    const placedStl = stlMeasure((await exportProjectScene(after, { format: "stl", shapeIds: [placed] })).data);
    expect(placedStl.volume).toBeCloseTo(64, 1);
    expect(placedStl.centroid[0]).toBeCloseTo(40, 4);
    expect(Math.abs(placedStl.centroid[1]) + Math.abs(placedStl.centroid[2])).toBeCloseTo(2, 4);

    // Undo is the previous entry: the base selection and the base geometry together.
    const undone = after.history[after.historyIndex - 1]!;
    expect(undone.activeConfiguration).toBeNull();
    expect(undone.parameters).toEqual([{ name: "wall", expression: "2", dimension: "length", value: 2 }]);
    expect(undone.shapes.find((shape) => shape.id === sized)?.width).toBe(10);
    expect(undone.shapes.find((shape) => shape.id === placed)?.x).toBe(20);

    const back = value(await engine.activateConfiguration("activate", null));
    expect(back.activeConfiguration).toBeNull();
    expect(value(await engine.properties("activate", sized)).volume).toBeCloseTo(1000, 3);
  }, CAD_TEST_TIMEOUT_MS);

  it("recomputes geometry when an override in the active configuration changes, and only then", async () => {
    const { sized } = await configuredBoxes("overrides");
    value(await engine.activateConfiguration("overrides", "Large"));

    const inactive = value(await engine.setConfigurationOverride("overrides", "Small", "wall", "3"));
    expect(inactive.shapes).toEqual([]);
    expect((await document("overrides")).configurations![0]).toEqual({ name: "Small", overrides: { wall: "3" } });

    const active = value(await engine.setConfigurationOverride("overrides", "Large", "wall", "5"));
    expect(active.shapes.map((shape) => shape.id)).toContain(sized);
    expect(value(await engine.properties("overrides", sized)).volume).toBeCloseTo(25 * 10 * 10, 3);

    // A base change under an override does not move the active geometry.
    const base = value(await engine.updateParameter("overrides", "wall", { expression: "1" }));
    expect(base.shapes).toEqual([]);
    expect(value(await engine.properties("overrides", sized)).volume).toBeCloseTo(2500, 3);

    value(await engine.clearConfigurationOverride("overrides", "Large", "wall"));
    expect(value(await engine.properties("overrides", sized)).volume).toBeCloseTo(5 * 10 * 10, 3);
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses an activation that a locked shape, a range or a broken table blocks, and changes nothing", async () => {
    const { sized } = await configuredBoxes("refusals");
    value(await engine.addConfiguration("refusals", "Negative", { wall: "-1" }));
    value(await engine.addConfiguration("refusals", "Tiny", { wall: "1" }));

    const range = await unchanged("refusals", () => engine.activateConfiguration("refusals", "Negative"));
    expect(range).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "outOfRange", field: "width", shapeId: sized } } });

    const missing = await unchanged("refusals", () => engine.activateConfiguration("refusals", "Medium"));
    expect(missing).toMatchObject({ ok: false, failure: { reason: "parameter_invalid", error: { code: "unknownConfiguration", configuration: "Medium" } } });

    const cycle = await unchanged("refusals", () => engine.setConfigurationOverride("refusals", "Tiny", "wall", "wall"));
    expect(cycle).toMatchObject({ ok: false, failure: { reason: "parameter_invalid", error: { code: "invalidExpression", configuration: "Tiny" } } });

    value(await engine.changeShape("refusals", sized, { locked: true }));
    const locked = await unchanged("refusals", () => engine.activateConfiguration("refusals", "Large"));
    expect(locked).toMatchObject({ ok: false, failure: { reason: "binding_failed", shapeId: sized, failure: { reason: "shape_locked" } } });
    const lockedOverride = await unchanged("refusals", () => engine.activateConfiguration("refusals", "Tiny"));
    expect(lockedOverride).toMatchObject({ ok: false, failure: { reason: "binding_failed", failure: { reason: "shape_locked" } } });
  }, CAD_TEST_TIMEOUT_MS);

  it("deletes the active configuration by switching back to the base geometry", async () => {
    const { sized } = await configuredBoxes("delete");
    value(await engine.activateConfiguration("delete", "Large"));

    const deleted = value(await engine.deleteConfiguration("delete", "Large"));
    expect(deleted.activeConfiguration).toBeNull();
    expect(deleted.configurations).toEqual([{ name: "Small", overrides: {} }]);
    expect(value(await engine.properties("delete", sized)).volume).toBeCloseTo(1000, 3);
  }, CAD_TEST_TIMEOUT_MS);

  it("renames configurations and parameters through the rows, and refuses to delete a parameter an override uses", async () => {
    await configuredBoxes("rename");
    value(await engine.activateConfiguration("rename", "Large"));
    value(await engine.renameConfiguration("rename", "Large", "XL"));
    value(await engine.addParameter("rename", { name: "lip", expression: "1", dimension: "length" }));
    value(await engine.setConfigurationOverride("rename", "Small", "lip", "wall / 2"));

    value(await engine.renameParameter("rename", "wall", "shell"));
    const renamed = await document("rename");
    expect(renamed.activeConfiguration).toBe("XL");
    expect(renamed.configurations).toEqual([
      { name: "Small", overrides: { lip: "shell / 2" } },
      { name: "XL", overrides: { shell: "4" } },
    ]);

    const refused = await unchanged("rename", () => engine.deleteParameter("rename", "shell"));
    expect(refused).toMatchObject({ ok: false, failure: { reason: "parameter_invalid", error: { code: "parameterInUse", configurationDependents: ["Small"] } } });
  }, CAD_TEST_TIMEOUT_MS);
});
