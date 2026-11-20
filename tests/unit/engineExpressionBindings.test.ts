import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEngine,
  directoryProjectStore,
  exportProjectScene,
  type EngineResult,
  type ProjectStore,
} from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { measureMesh } from "./support/meshMeasure";

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

function extrusionProfile(halfWidth = 1): SketchProfile {
  return {
    points: [
      { id: "a", x: -halfWidth, z: -1 }, { id: "b", x: halfWidth, z: -1 },
      { id: "c", x: halfWidth, z: 1 }, { id: "d", x: -halfWidth, z: 1 },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
  };
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

describe("expression-bound fields and parameter recompute", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  async function project(projectId: string) {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
  }

  async function document(projectId: string) {
    return (await store.read(projectId))!;
  }

  /** Turns the first shape into a sketch extrusion recipe, as the recompute suite does. */
  async function asSketchExtrusion(projectId: string, sketchSourceId: string) {
    const current = await document(projectId);
    const [first, ...rest] = current.shapes;
    await store.write(projectId, current, [{
      ...first!,
      sketchOperation: "extrude",
      sketchProfile: extrusionProfile(),
      sketchSourceId,
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 2, depth: 2, height: 3 },
    }, ...rest]);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-bindings-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("updates every bound shape in one write and one undo step, and exports the resolved geometry", async () => {
    await project("boxes");
    const [sized, placed] = value(await engine.addShapes("boxes", [
      { kind: "box", width: 10, depth: 10, height: 10 },
      { kind: "box", width: 4, depth: 4, height: 4, x: 0 },
    ])).shapes;
    value(await engine.addParameter("boxes", { name: "wall", expression: "2", dimension: "length" }));
    value(await engine.bindShapeField("boxes", sized!.id, "width", "wall * 5"));
    value(await engine.bindShapeField("boxes", placed!.id, "x", "wall * 10 + 1cm"));
    const before = await document("boxes");

    const changed = value(await engine.updateParameter("boxes", "wall", { expression: "3" }));

    expect(changed.parameters).toEqual([{ name: "wall", expression: "3", dimension: "length", value: 3 }]);
    const after = await document("boxes");
    expect(after.metadata.revision).toBeGreaterThan(before.metadata.revision as number);
    expect(after.history).toHaveLength(before.history.length + 1);
    expect(after.historyIndex).toBe(before.historyIndex + 1);
    const sizedProperties = value(await engine.properties("boxes", sized!.id));
    expect(sizedProperties.volume).toBeCloseTo(15 * 10 * 10, 3);
    expect(sizedProperties.centerOfMass.x).toBeCloseTo(0, 6);
    const placedProperties = value(await engine.properties("boxes", placed!.id));
    expect(placedProperties.volume).toBeCloseTo(64, 3);
    expect(placedProperties.centerOfMass.x).toBeCloseTo(40, 6);
    expect(after.shapes.find((shape) => shape.id === sized!.id)?.expressions).toEqual({ width: "wall * 5" });

    // Undo is the previous entry: the old table and the old geometry together.
    const undone = after.history[after.historyIndex - 1]!;
    expect(undone.parameters).toEqual([{ name: "wall", expression: "2", dimension: "length", value: 2 }]);
    expect(undone.shapes.find((shape) => shape.id === sized!.id)?.width).toBe(10);
    expect(undone.shapes.find((shape) => shape.id === placed!.id)?.x).toBe(30);

    const stl = stlMeasure((await exportProjectScene(after, { format: "stl", shapeIds: [sized!.id] })).data);
    expect(stl.volume).toBeCloseTo(1500, 1);
  }, CAD_TEST_TIMEOUT_MS);

  it("leaves the model unchanged and reports a structured error for invalid or cyclic changes", async () => {
    await project("invalid");
    const [shape] = value(await engine.addShapes("invalid", [{ kind: "box", width: 10, depth: 10, height: 10 }])).shapes;
    value(await engine.addParameter("invalid", { name: "wall", expression: "2", dimension: "length" }));
    value(await engine.addParameter("invalid", { name: "lip", expression: "wall + 1", dimension: "length" }));
    value(await engine.bindShapeField("invalid", shape!.id, "width", "lip * 2"));
    const before = await document("invalid");

    const cyclic = await engine.updateParameter("invalid", "wall", { expression: "lip" });
    expect(cyclic).toMatchObject({ ok: false, failure: { reason: "parameter_invalid", error: { code: "invalidExpression", expressionError: { code: "cycle" } } } });

    const wrongDimension = await engine.updateParameter("invalid", "lip", { expression: "30 deg", dimension: "angle" });
    expect(wrongDimension).toMatchObject({
      ok: false,
      failure: { reason: "binding_invalid", error: { code: "invalidExpression", shapeId: shape!.id, field: "width", expressionError: { code: "dimensionMismatch" } } },
    });

    const badBinding = await engine.bindShapeField("invalid", shape!.id, "width", "wall *");
    expect(badBinding).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "invalidExpression" } } });
    const unbindable = await engine.bindShapeField("invalid", shape!.id, "sides", "6");
    expect(unbindable).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "fieldNotBindable" } } });

    const after = await document("invalid");
    expect(after.metadata.revision).toBe(before.metadata.revision);
    expect(after.parameters).toEqual(before.parameters);
    expect(after.shapes).toEqual(before.shapes);
  });

  it("drops a binding when its field is set to a literal, and keeps the others", async () => {
    await project("literal");
    const [shape] = value(await engine.addShapes("literal", [{ kind: "box", width: 10, depth: 10, height: 10 }])).shapes;
    value(await engine.addParameter("literal", { name: "wall", expression: "2", dimension: "length" }));
    value(await engine.bindShapeField("literal", shape!.id, "width", "wall * 2"));
    value(await engine.bindShapeField("literal", shape!.id, "height", "wall * 3"));

    const changed = value(await engine.changeShape("literal", shape!.id, { width: 7 }));

    expect(changed.shape).toMatchObject({ width: 7, height: 6, expressions: { height: "wall * 3" } });
    value(await engine.updateParameter("literal", "wall", { expression: "4" }));
    expect((await document("literal")).shapes[0]).toMatchObject({ width: 7, height: 12 });
  });

  it("renames bindings with the parameter and refuses to delete one a shape uses", async () => {
    await project("rename");
    const [shape] = value(await engine.addShapes("rename", [{ kind: "box", width: 10, depth: 10, height: 10 }])).shapes;
    value(await engine.addParameter("rename", { name: "wall", expression: "2", dimension: "length" }));
    value(await engine.bindShapeField("rename", shape!.id, "width", "wall * 2"));

    value(await engine.renameParameter("rename", "wall", "thickness"));
    expect((await document("rename")).shapes[0]!.expressions).toEqual({ width: "thickness * 2" });

    const refused = await engine.deleteParameter("rename", "thickness");
    expect(refused).toMatchObject({
      ok: false,
      failure: { reason: "parameter_invalid", error: { code: "parameterInUse", shapeDependents: [{ shapeId: shape!.id, fields: ["width"] }] } },
    });
    value(await engine.bindShapeField("rename", shape!.id, "width", null));
    value(await engine.deleteParameter("rename", "thickness"));
    expect((await document("rename")).parameters).toEqual([]);
  });

  it("does not let a stale entry and its stale binding block an unrelated parameter change", async () => {
    await project("stale");
    const [staleShape, liveShape] = value(await engine.addShapes("stale", [
      { kind: "box", width: 10, depth: 10, height: 10 },
      { kind: "box", width: 10, depth: 10, height: 10 },
    ])).shapes;
    const current = await document("stale");
    await store.write("stale", {
      ...current,
      parameters: [
        { name: "wall", expression: "2", dimension: "length", value: 2 },
        { name: "gone", expression: "missing * 2", dimension: "length", value: Number.NaN },
      ],
    }, [
      { ...current.shapes[0]!, expressions: { width: "gone" } },
      { ...current.shapes[1]!, width: 4, expressions: { width: "wall * 2" } },
    ]);
    expect((await document("stale")).parameters?.[1]?.error).toBeDefined();

    value(await engine.updateParameter("stale", "wall", { expression: "3" }));

    const after = await document("stale");
    expect(after.shapes.find((shape) => shape.id === liveShape!.id)?.width).toBe(6);
    expect(after.shapes.find((shape) => shape.id === staleShape!.id)).toMatchObject({ width: 10, expressions: { width: "gone" } });
  });

  it("replays a retained all-edge fillet when its bound amount changes", async () => {
    await project("fillet");
    await project("fillet-reference");
    for (const projectId of ["fillet", "fillet-reference"]) {
      value(await engine.addShapes(projectId, [{ kind: "box", width: 2, depth: 2, height: 3 }]));
      await asSketchExtrusion(projectId, `sketch/${projectId}`);
    }
    const bound = (await document("fillet")).shapes[0]!;
    value(await engine.treat("fillet", bound.id, { kind: "fillet", amount: 0.2 }));
    value(await engine.treat("fillet-reference", (await document("fillet-reference")).shapes[0]!.id, { kind: "fillet", amount: 0.4 }));
    value(await engine.addParameter("fillet", { name: "fillet", expression: "0.2", dimension: "length" }));
    value(await engine.bindShapeField("fillet", bound.id, "edgeTreatments.0.amount", "fillet"));
    const smaller = value(await engine.properties("fillet", bound.id));

    value(await engine.updateParameter("fillet", "fillet", { expression: "0.4" }));

    const updated = (await document("fillet")).shapes[0]!;
    expect(updated.edgeTreatments).toEqual([expect.objectContaining({ kind: "fillet", amount: 0.4, allEdges: true })]);
    expect(updated.edgeTreatmentHistory?.[0]?.feature.amount).toBe(0.4);
    const rebuilt = value(await engine.properties("fillet", bound.id));
    const reference = value(await engine.properties("fillet-reference", (await document("fillet-reference")).shapes[0]!.id));
    expect(rebuilt.volume).toBeLessThan(smaller.volume - 1e-3);
    expect(rebuilt.volume).toBeCloseTo(reference.volume, 4);
    expect(rebuilt.centerOfMass.x).toBeCloseTo(reference.centerOfMass.x, 5);
    expect(rebuilt.centerOfMass.y).toBeCloseTo(reference.centerOfMass.y, 5);
    expect(rebuilt.centerOfMass.z).toBeCloseTo(reference.centerOfMass.z, 5);
  }, CAD_TEST_TIMEOUT_MS);

  it("rebuilds a cut around a bound draft-prism angle exactly as a manual edit does", async () => {
    const setUp = async (projectId: string) => {
      await project(projectId);
      const created = value(await engine.addShapes(projectId, [
        { kind: "box", width: 2, depth: 2, height: 3, x: 12, z: -4, elevation: 7 },
        { kind: "box", width: 0.5, depth: 0.5, height: 1, x: 12, z: -4, elevation: 8, hole: true },
      ])).shapes;
      await asSketchExtrusion(projectId, "sketch/drafted");
      value(await engine.draftPrism(projectId, created[0]!.id, 5));
      return value(await engine.cut(projectId, { solidIds: [created[0]!.id], holeIds: [created[1]!.id] })).shape;
    };
    const boundCut = await setUp("bound-draft");
    const manualCut = await setUp("manual-draft");
    const child = boundCut.groupedShapes!.find((shape) => shape.sketchSourceId === "sketch/drafted")!;
    value(await engine.addParameter("bound-draft", { name: "taper", expression: "5 deg", dimension: "angle" }));
    value(await engine.bindShapeField("bound-draft", child.id, "draftPrismAngle", "taper"));
    const original = value(await engine.properties("bound-draft", boundCut.id));

    value(await engine.updateParameter("bound-draft", "taper", { expression: "12" }));
    value(await engine.changeShape("manual-draft", "sketch/drafted", { draftPrismAngle: 12 }));

    const bound = value(await engine.properties("bound-draft", boundCut.id));
    const manual = value(await engine.properties("manual-draft", manualCut.id));
    expect(Math.abs(bound.volume - original.volume)).toBeGreaterThan(1e-3);
    expect(bound.volume).toBeCloseTo(manual.volume, 6);
    expect(bound.centerOfMass.x).toBeCloseTo(manual.centerOfMass.x, 6);
    expect(bound.centerOfMass.y).toBeCloseTo(manual.centerOfMass.y, 6);
    expect(bound.centerOfMass.z).toBeCloseTo(manual.centerOfMass.z, 6);
    const stored = (await document("bound-draft")).shapes[0]!.groupedShapes!.find((shape) => shape.id === child.id)!;
    expect(stored).toMatchObject({ draftPrismAngle: 12, expressions: { draftPrismAngle: "taper" } });
  }, CAD_TEST_TIMEOUT_MS);
});
