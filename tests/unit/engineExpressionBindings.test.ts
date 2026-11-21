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
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
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

  it("lets a stale binding on the changed parameter stay stale, but refuses a change that breaks a live one", async () => {
    await project("stale-dependent");
    const [box] = value(await engine.addShapes("stale-dependent", [{ kind: "box", width: 10, depth: 10, height: 10 }])).shapes;
    value(await engine.addParameter("stale-dependent", { name: "wall", expression: "2", dimension: "length" }));
    const current = await document("stale-dependent");
    await store.write("stale-dependent", current, [{ ...current.shapes[0]!, expressions: { sides: "wall", height: "wall * 3" } }]);

    value(await engine.updateParameter("stale-dependent", "wall", { expression: "3" }));
    expect((await document("stale-dependent")).shapes[0]).toMatchObject({ height: 9, expressions: { sides: "wall", height: "wall * 3" } });

    const broken = await engine.updateParameter("stale-dependent", "wall", { expression: "30 deg", dimension: "angle" });
    expect(broken).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { shapeId: box!.id, field: "height" } } });
  });

  it("writes nothing when a later bound shape refuses the change", async () => {
    await project("partial");
    const [first, second] = value(await engine.addShapes("partial", [
      { kind: "box", width: 10, depth: 10, height: 10 },
      { kind: "box", width: 10, depth: 10, height: 10 },
    ])).shapes;
    value(await engine.addParameter("partial", { name: "wall", expression: "2", dimension: "length" }));
    value(await engine.bindShapeField("partial", first!.id, "width", "wall * 2"));
    value(await engine.bindShapeField("partial", second!.id, "width", "wall * 3"));
    value(await engine.changeShape("partial", second!.id, { locked: true }));
    const before = await document("partial");

    const refused = await engine.updateParameter("partial", "wall", { expression: "5" });

    expect(refused).toMatchObject({ ok: false, failure: { reason: "binding_failed", shapeId: second!.id, failure: { reason: "shape_locked" } } });
    const after = await document("partial");
    expect(after.metadata.revision).toBe(before.metadata.revision);
    expect(after.shapes).toEqual(before.shapes);
    expect(after.parameters).toEqual(before.parameters);
  });

  it("drops placement bindings that a group, align or pattern replaces with literals, and keeps size bindings", async () => {
    await project("literal-ops");
    const [a, b, c] = value(await engine.addShapes("literal-ops", [
      { kind: "box", width: 4, depth: 4, height: 4, x: 0 },
      { kind: "box", width: 4, depth: 4, height: 4, x: 20 },
      { kind: "box", width: 4, depth: 4, height: 4, x: 40 },
    ])).shapes;
    value(await engine.addParameter("literal-ops", { name: "wall", expression: "2", dimension: "length" }));
    for (const shape of [a!, b!, c!]) {
      value(await engine.bindShapeField("literal-ops", shape.id, "z", shape === c ? "wall * 4" : "wall"));
      value(await engine.bindShapeField("literal-ops", shape.id, "height", "wall * 3"));
    }

    value(await engine.align("literal-ops", { ids: [a!.id, c!.id], axis: "z", target: "min", anchorId: a!.id }));
    const copies = value(await engine.pattern("literal-ops", { ids: [c!.id], kind: "linear", count: 2, stepZ: 10 })).shapes;
    const group = value(await engine.group("literal-ops", [a!.id, b!.id])).shape;
    value(await engine.updateParameter("literal-ops", "wall", { expression: "5" }));

    const after = await document("literal-ops");
    const copy = after.shapes.find((shape) => shape.id === copies[0]!.id)!;
    expect(copy.expressions).toEqual({ height: "wall * 3" });
    expect(copy).toMatchObject({ z: 12, height: 15 });
    // Align moved c from z 8 to a's 2, so its z binding went and it stays put.
    expect(after.shapes.find((shape) => shape.id === c!.id)).toMatchObject({ z: 2, height: 15, expressions: { height: "wall * 3" } });
    const children = after.shapes.find((shape) => shape.id === group.id)!.groupedShapes!;
    expect(children.every((child) => child.expressions === undefined)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

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
    expect(updated.expressions).toEqual({ "edgeTreatments.0.amount": "fillet" });
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

  async function boundBoxes(projectId: string, count: number, extra: Record<string, unknown> = {}) {
    await project(projectId);
    const shapes = value(await engine.addShapes(projectId, Array.from({ length: count }, (_, index) => ({
      kind: "box", width: 4, depth: 4, height: 4, x: index * 20, ...extra,
    })))).shapes;
    value(await engine.addParameter(projectId, { name: "wall", expression: "2", dimension: "length" }));
    value(await engine.addParameter(projectId, { name: "tilt", expression: "30 deg", dimension: "angle" }));
    return shapes;
  }

  async function filletedExtrusion(projectId: string, kind: "fillet" | "chamfer" = "fillet", angle?: number) {
    await project(projectId);
    value(await engine.addShapes(projectId, [{ kind: "box", width: 2, depth: 2, height: 3 }]));
    await asSketchExtrusion(projectId, `sketch/${projectId}`);
    const shape = (await document(projectId)).shapes[0]!;
    value(await engine.treat(projectId, shape.id, { kind, amount: 0.2, ...(angle === undefined ? {} : { angle }) }));
    return shape.id;
  }

  async function revolve(projectId: string) {
    await project(projectId);
    return value(await engine.addShapes(projectId, [{ kind: "revolve", profile: [[1, -5], [2, -5], [2, 5], [1, 5]], sides: 48 }])).shapes[0]!;
  }

  async function faceDrafted(projectId: string, angle = 5) {
    await project(projectId);
    const extrusion = await sketchExtrusionShapeFromRequest({
      id: `drafted-${projectId}`, sketchSourceId: `sketch/drafted-${projectId}`, name: "Drafted",
      profile: extrusionProfile(), height: 3, x: 0, z: 0, elevation: 0,
    });
    await store.write(projectId, await document(projectId), [extrusion]);
    const face = (await shapeFaces(extrusion)).find((candidate) => candidate.normal && candidate.surfaceType === "plane"
      && Math.abs(candidate.normal.x) > 0.99)!;
    value(await engine.changeShape(projectId, extrusion.id, { faceDraft: { sourceFaceId: face.id, angle, pullDirection: "y" } }));
    return { id: extrusion.id, faceId: face.id };
  }

  async function unchanged(projectId: string, run: () => Promise<EngineResult<unknown>>) {
    const before = await document(projectId);
    const result = await run();
    const after = await document(projectId);
    expect(after.metadata.revision).toBe(before.metadata.revision);
    expect(after.shapes).toEqual(before.shapes);
    expect(after.parameters).toEqual(before.parameters);
    return result;
  }

  it("drops placement bindings on a baked mirror, a distribute and a cut", async () => {
    const [a, b, c, hole] = await boundBoxes("bakes", 4);
    for (const shape of [a!, b!, c!]) value(await engine.bindShapeField("bakes", shape.id, "x", `wall * ${shape === b ? 3 : shape === a ? 0 : 20}`));
    value(await engine.bindShapeField("bakes", a!.id, "rotation", "tilt"));
    value(await engine.bindShapeField("bakes", a!.id, "height", "wall * 3"));

    value(await engine.mirrorBaked("bakes", [a!.id], "x"));
    expect((await document("bakes")).shapes.find((shape) => shape.id === a!.id)!.expressions).toBeUndefined();

    value(await engine.distribute("bakes", { ids: [a!.id, b!.id, c!.id], axis: "x" }));
    const middle = (await document("bakes")).shapes.find((shape) => shape.id === b!.id)!;
    expect(middle.expressions).toBeUndefined();
    const middleX = middle.x;

    value(await engine.changeShape("bakes", hole!.id, { x: 40, width: 1, depth: 1, hole: true }));
    value(await engine.bindShapeField("bakes", hole!.id, "height", "wall * 4"));
    const cut = value(await engine.cut("bakes", { solidIds: [c!.id], holeIds: [hole!.id] })).shape;
    expect(cut.groupedShapes!.every((child) => child.expressions === undefined)).toBe(true);

    value(await engine.updateParameter("bakes", "wall", { expression: "4" }));
    expect((await document("bakes")).shapes.find((shape) => shape.id === b!.id)!.x).toBe(middleX);
  }, CAD_TEST_TIMEOUT_MS);

  it("drops shape-field bindings on children an ungroup puts back in world placement", async () => {
    const [a, b] = await boundBoxes("ungroup", 2);
    const group = value(await engine.group("ungroup", [a!.id, b!.id])).shape;
    const current = await document("ungroup");
    await store.write("ungroup", current, current.shapes.map((shape) => shape.id === group.id
      ? { ...shape, groupedShapes: shape.groupedShapes!.map((child) => ({ ...child, expressions: { x: "wall", height: "wall * 2" } })) }
      : shape));

    const children = value(await engine.ungroup("ungroup", group.id)).shapes;

    expect(children.every((child) => child.expressions === undefined)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("drops a draft binding when draftPrism sets the angle", async () => {
    await project("redraft");
    value(await engine.addShapes("redraft", [{ kind: "box", width: 2, depth: 2, height: 3 }]));
    await asSketchExtrusion("redraft", "sketch/redraft");
    const drafted = (await document("redraft")).shapes[0]!;
    value(await engine.draftPrism("redraft", drafted.id, 5));
    value(await engine.addParameter("redraft", { name: "taper", expression: "5", dimension: "angle" }));
    value(await engine.bindShapeField("redraft", drafted.id, "draftPrismAngle", "taper"));
    value(await engine.draftPrism("redraft", drafted.id, 8));
    expect((await document("redraft")).shapes[0]!.expressions).toBeUndefined();
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses, atomically, a parameter change that would alter a locked shape through any binding", async () => {
    const treated = await filletedExtrusion("locked-treatment");
    const turned = await revolve("locked-revolve");
    const drafted = await faceDrafted("locked-draft");
    const cases: Array<[string, string, string, string]> = [
      ["locked-treatment", treated, "edgeTreatments.0.amount", "0.3"],
      ["locked-revolve", turned.id, "revolve.sweepAngle", "180"],
      ["locked-draft", drafted.id, "faceDraft.angle", "8"],
    ];
    for (const [projectId, shapeId, field, next] of cases) {
      const [other] = value(await engine.addShapes(projectId, [{ kind: "box", width: 4, depth: 4, height: 4, x: 50 }])).shapes;
      const initial = field === "edgeTreatments.0.amount" ? "0.2" : field === "faceDraft.angle" ? "5" : "360";
      value(await engine.addParameter(projectId, { name: "p", expression: initial, dimension: field === "edgeTreatments.0.amount" ? "length" : "angle" }));
      value(await engine.bindShapeField(projectId, shapeId, field, "p"));
      value(await engine.addParameter(projectId, { name: "q", expression: "p", dimension: field === "edgeTreatments.0.amount" ? "length" : "angle" }));
      value(await engine.bindShapeField(projectId, other!.id, field === "edgeTreatments.0.amount" ? "height" : "rotation", "q"));
      value(await engine.changeShape(projectId, shapeId, { locked: true }));

      const refused = await unchanged(projectId, () => engine.updateParameter(projectId, "p", { expression: next }));

      expect(refused, `${projectId}`).toMatchObject({ ok: false, failure: { reason: "binding_failed", shapeId, failure: { reason: "shape_locked" } } });
    }
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses out-of-range values when binding and when a parameter changes, and accepts periodic angles", async () => {
    const [box] = await boundBoxes("ranges", 1);
    const [cylinder] = value(await engine.addShapes("ranges", [{ kind: "cylinder", width: 10, height: 10 }])).shapes;
    const [gear] = value(await engine.addShapes("ranges", [{ kind: "gear", width: 40, depth: 40, height: 5 }])).shapes;
    value(await engine.addParameter("ranges", { name: "n", expression: "2", dimension: "unitless" }));

    for (const [shapeId, field, expression, code] of [
      [cylinder!.id, "sides", "n", "outOfRange"],
      [box!.id, "width", "-5", "outOfRange"],
      [gear!.id, "teeth", "n", "outOfRange"],
      [gear!.id, "helixAngle", "60", "outOfRange"],
      [cylinder!.id, "sides", "n / 4", "notAnInteger"],
    ] as const) {
      const refused = await unchanged("ranges", () => engine.bindShapeField("ranges", shapeId, field, expression));
      expect(refused, `${field} = ${expression}`).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code, field } } });
    }

    value(await engine.bindShapeField("ranges", box!.id, "width", "wall * 2"));
    const shrunk = await unchanged("ranges", () => engine.updateParameter("ranges", "wall", { expression: "-1" }));
    expect(shrunk).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "outOfRange", field: "width", min: 0.01 } } });

    value(await engine.bindShapeField("ranges", box!.id, "rotation", "tilt - 60"));
    expect((await document("ranges")).shapes[0]!.rotation).toBe(330);
    value(await engine.bindShapeField("ranges", box!.id, "rotationX", "12.34"));
    expect((await document("ranges")).shapes[0]!.rotationX).toBe(12.3);
    const same = value(await engine.updateParameter("ranges", "tilt", { expression: "30.0 deg" }));
    expect(same.shapes).toEqual([]);
  }, CAD_TEST_TIMEOUT_MS);

  it("rebuilds revolve settings, a face draft angle, a chamfer angle and a rotation from their bindings", async () => {
    // Volume and the full centre of mass, against a directly built reference.
    const sameMass = (actual: { volume: number; centerOfMass: { x: number; y: number; z: number } },
      expected: typeof actual, digits = 6) => {
      expect(actual.volume).toBeCloseTo(expected.volume, digits);
      expect(actual.centerOfMass.x).toBeCloseTo(expected.centerOfMass.x, digits);
      expect(actual.centerOfMass.y).toBeCloseTo(expected.centerOfMass.y, digits);
      expect(actual.centerOfMass.z).toBeCloseTo(expected.centerOfMass.z, digits);
    };

    const turned = await revolve("revolve-bound");
    value(await engine.addParameter("revolve-bound", { name: "sweep", expression: "360", dimension: "angle" }));
    value(await engine.bindShapeField("revolve-bound", turned.id, "revolve.sweepAngle", "sweep"));
    value(await engine.bindShapeField("revolve-bound", turned.id, "revolve.startAngle", "-90"));
    value(await engine.updateParameter("revolve-bound", "sweep", { expression: "180" }));
    expect((await document("revolve-bound")).shapes[0]!.sketchRevolve).toMatchObject({ sweepAngle: 180, startAngle: 270 });
    await project("revolve-reference");
    const halfTurn = value(await engine.addShapes("revolve-reference", [{
      kind: "revolve", profile: [[1, -5], [2, -5], [2, 5], [1, 5]], sides: 48, startAngle: 270, sweepAngle: 180,
    }])).shapes[0]!;
    const revolveBound = value(await engine.properties("revolve-bound", turned.id));
    sameMass(revolveBound, value(await engine.properties("revolve-reference", halfTurn.id)));
    expect(Math.abs(revolveBound.centerOfMass.x) + Math.abs(revolveBound.centerOfMass.z)).toBeGreaterThan(0.1);

    const bound = await faceDrafted("draft-bound");
    const manual = await faceDrafted("draft-manual", 8);
    value(await engine.addParameter("draft-bound", { name: "taper", expression: "5", dimension: "angle" }));
    value(await engine.bindShapeField("draft-bound", bound.id, "faceDraft.angle", "taper"));
    value(await engine.updateParameter("draft-bound", "taper", { expression: "8" }));
    expect((await document("draft-bound")).shapes[0]!.faceDraft?.angle).toBe(8);
    sameMass(value(await engine.properties("draft-bound", bound.id)), value(await engine.properties("draft-manual", manual.id)));

    const chamfered = await filletedExtrusion("chamfer-bound", "chamfer", 45);
    const reference = await filletedExtrusion("chamfer-reference", "chamfer", 60);
    value(await engine.addParameter("chamfer-bound", { name: "bevel", expression: "45", dimension: "angle" }));
    value(await engine.bindShapeField("chamfer-bound", chamfered, "edgeTreatments.0.chamferAngle", "bevel"));
    value(await engine.updateParameter("chamfer-bound", "bevel", { expression: "60" }));
    // A manual source edit replays a non-45° chamfer with a 4e-4 mm offset in x and z
    // against a direct treatment, so the binding is held to the manual replay exactly.
    const replayed = await filletedExtrusion("chamfer-replayed", "chamfer", 60);
    value(await engine.changeShape("chamfer-replayed", "sketch/chamfer-replayed", { sketchProfile: extrusionProfile() }));
    const chamferBound = value(await engine.properties("chamfer-bound", chamfered));
    sameMass(chamferBound, value(await engine.properties("chamfer-replayed", replayed)));
    sameMass(chamferBound, value(await engine.properties("chamfer-reference", reference)), 3);

    const [wedge] = await boundBoxes("rotation-bound", 1, { kind: "wedge", x: 0 });
    value(await engine.bindShapeField("rotation-bound", wedge!.id, "rotation", "tilt"));
    value(await engine.updateParameter("rotation-bound", "tilt", { expression: "120 deg" }));
    expect((await document("rotation-bound")).shapes[0]!.rotation).toBe(120);
    await project("rotation-reference");
    const turnedWedge = value(await engine.addShapes("rotation-reference", [{ kind: "wedge", width: 4, depth: 4, height: 4, rotation: 120 }])).shapes[0]!;
    const rotationBound = value(await engine.properties("rotation-bound", wedge!.id));
    sameMass(rotationBound, value(await engine.properties("rotation-reference", turnedWedge.id)));
    const unturned = value(await engine.properties("rotation-reference", value(await engine.addShapes("rotation-reference", [{ kind: "wedge", width: 4, depth: 4, height: 4, x: 0 }])).shapes[0]!.id));
    expect(Math.hypot(rotationBound.centerOfMass.x - unturned.centerOfMass.x, rotationBound.centerOfMass.z - unturned.centerOfMass.z)).toBeGreaterThan(0.1);
  }, CAD_TEST_TIMEOUT_MS);

  it("replays a bound treatment on a sketch output inside a cut", async () => {
    const setUp = async (projectId: string, amount: number) => {
      await project(projectId);
      const created = value(await engine.addShapes(projectId, [
        { kind: "box", width: 2, depth: 2, height: 3 },
        { kind: "box", width: 0.5, depth: 0.5, height: 1, elevation: 2.5, hole: true },
      ])).shapes;
      await asSketchExtrusion(projectId, `sketch/${projectId}`);
      value(await engine.treat(projectId, created[0]!.id, { kind: "fillet", amount }));
      const cut = value(await engine.cut(projectId, { solidIds: [created[0]!.id], holeIds: [created[1]!.id] })).shape;
      return { cut, child: cut.groupedShapes!.find((shape) => shape.sketchSourceId === `sketch/${projectId}`)!.id };
    };
    const bound = await setUp("nested-treatment", 0.2);
    const reference = await setUp("nested-reference", 0.4);
    value(await engine.addParameter("nested-treatment", { name: "rounding", expression: "0.2", dimension: "length" }));
    value(await engine.bindShapeField("nested-treatment", bound.child, "edgeTreatments.0.amount", "rounding"));

    value(await engine.updateParameter("nested-treatment", "rounding", { expression: "0.4" }));

    const rebuilt = value(await engine.properties("nested-treatment", bound.cut.id));
    const expected = value(await engine.properties("nested-reference", reference.cut.id));
    expect(rebuilt.volume).toBeCloseTo(expected.volume, 4);
    expect(rebuilt.centerOfMass.y).toBeCloseTo(expected.centerOfMass.y, 5);
    const child = (await document("nested-treatment")).shapes[0]!.groupedShapes!.find((shape) => shape.id === bound.child)!;
    expect(child.expressions).toEqual({ "edgeTreatments.0.amount": "rounding" });
  }, CAD_TEST_TIMEOUT_MS);

  it("renames into treatment before snapshots and refuses to delete a parameter only a snapshot uses", async () => {
    const id = await filletedExtrusion("snapshot");
    const current = await document("snapshot");
    const shape = current.shapes[0]!;
    value(await engine.addParameter("snapshot", { name: "wall", expression: "0", dimension: "length" }));
    const withParameter = await document("snapshot");
    await store.write("snapshot", withParameter, [{
      ...shape,
      edgeTreatmentHistory: shape.edgeTreatmentHistory!.map((entry) => ({ ...entry, before: { ...entry.before, expressions: { x: "wall" } } })),
    }]);

    value(await engine.renameParameter("snapshot", "wall", "offset"));
    expect((await document("snapshot")).shapes[0]!.edgeTreatmentHistory![0]!.before.expressions).toEqual({ x: "offset" });

    const refused = await unchanged("snapshot", () => engine.deleteParameter("snapshot", "offset"));
    expect(refused).toMatchObject({ ok: false, failure: { reason: "parameter_invalid", error: { code: "parameterInUse", shapeDependents: [{ shapeId: id, fields: ["x"] }] } } });
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps bindings through a revolve rebuild, dropping only those whose value the rebuild changed", async () => {
    const turned = await revolve("revolve-rebuild");
    value(await engine.addParameter("revolve-rebuild", { name: "wall", expression: "3", dimension: "length" }));
    value(await engine.bindShapeField("revolve-rebuild", turned.id, "x", "wall"));
    value(await engine.bindShapeField("revolve-rebuild", turned.id, "height", "wall * 4"));
    const before = (await document("revolve-rebuild")).shapes[0]!;

    const rebuilt = value(await engine.changeShape("revolve-rebuild", turned.id, { pitch: 2, turns: 3 })).shape;

    expect(rebuilt.height).not.toBeCloseTo(before.height, 3);
    expect(rebuilt.expressions).toEqual({ x: "wall" });
    value(await engine.updateParameter("revolve-rebuild", "wall", { expression: "7" }));
    expect((await document("revolve-rebuild")).shapes[0]).toMatchObject({ x: 7, expressions: { x: "wall" } });
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps a group's own binding when a source edit rebuilds the group around its child", async () => {
    await project("group-rebuild");
    const created = value(await engine.addShapes("group-rebuild", [
      { kind: "box", width: 2, depth: 2, height: 3 },
      { kind: "box", width: 0.5, depth: 0.5, height: 1, elevation: 2.5, hole: true },
    ])).shapes;
    await asSketchExtrusion("group-rebuild", "sketch/group-rebuild");
    value(await engine.draftPrism("group-rebuild", created[0]!.id, 5));
    const cut = value(await engine.cut("group-rebuild", { solidIds: [created[0]!.id], holeIds: [created[1]!.id] })).shape;
    value(await engine.addParameter("group-rebuild", { name: "offset", expression: "10", dimension: "length" }));
    value(await engine.bindShapeField("group-rebuild", cut.id, "x", "offset"));

    value(await engine.changeShape("group-rebuild", "sketch/group-rebuild", { draftPrismAngle: 12 }));

    expect((await document("group-rebuild")).shapes[0]!.expressions).toEqual({ x: "offset" });
  }, CAD_TEST_TIMEOUT_MS);

  it("checks dependent ranges against the shape as the whole change leaves it", async () => {
    const gear = async (projectId: string) => {
      await project(projectId);
      const [shape] = value(await engine.addShapes(projectId, [{ kind: "gear", width: 20, depth: 20, height: 5, toothSize: 4 }])).shapes;
      value(await engine.addParameter(projectId, { name: "W", expression: "20", dimension: "length" }));
      value(await engine.bindShapeField(projectId, shape!.id, "width", "W"));
      value(await engine.bindShapeField(projectId, shape!.id, "depth", "W"));
      return shape!;
    };

    // Grows with its blank: legal once width and depth are 40, so not refused against the old 20.
    const growing = await gear("gear-grow");
    value(await engine.bindShapeField("gear-grow", growing.id, "toothSize", "W * 0.2"));
    value(await engine.updateParameter("gear-grow", "W", { expression: "40" }));
    expect((await document("gear-grow")).shapes[0]).toMatchObject({ width: 40, depth: 40, toothSize: 8 });

    // A fixed tooth the shrunken blank cannot hold: refused, though its own parameter did not change.
    const fixed = await gear("gear-shrink");
    value(await engine.addParameter("gear-shrink", { name: "T", expression: "4", dimension: "length" }));
    value(await engine.bindShapeField("gear-shrink", fixed.id, "toothSize", "T"));
    const refused = await unchanged("gear-shrink", () => engine.updateParameter("gear-shrink", "W", { expression: "10" }));
    expect(refused).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "outOfRange", field: "toothSize", value: 4 } } });
  }, CAD_TEST_TIMEOUT_MS);
});
