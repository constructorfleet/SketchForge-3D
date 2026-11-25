import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, directoryProjectStore, validateBinding, type EngineResult, type ProjectStore } from "@constructorfleet/sketchforge-engine";
import { writeProjectMetadata } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import type { SketchConstraint, SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import * as engineEntry from "@constructorfleet/sketchforge-engine";
import * as oldConstraintPath from "@constructorfleet/sketchforge-engine/sketchConstraintBindings";
import * as oldFieldPath from "@constructorfleet/sketchforge-engine/expressionBindings";
import { resolveConstraintEntry } from "@/lib/expressionFields";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// Pins which refusal wins when one bind breaks several rules, and the lock reply each bind path gives.

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

const widthConstraint = (expression?: string) =>
  ({ id: "width", kind: "distance", pointIds: ["a", "b"], valueMm: 2, ...(expression ? { expression } : {}) }) as SketchConstraint;

function rectangle(expression?: string): SketchProfile {
  return {
    points: [{ id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 }, { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 }],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
    constraints: [widthConstraint(expression), { id: "depth", kind: "distance", pointIds: ["b", "c"], valueMm: 2 }],
  };
}

let template: WorkplaneShape;
const plain = { sketchProfile: undefined, sketchOperation: undefined, sketchSourceId: undefined };

/** A sketch extrusion of `rectangle()`; pass `plain` for a box with no sketch. */
function output(id: string, extra: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return { ...template, id, name: id, sketchOperation: "extrude", sketchProfile: rectangle(), sketchSourceId: `sketch/${id}`, ...extra };
}

describe("binding validation order", () => {
  let root: string;
  let store: ProjectStore;
  let engine: ReturnType<typeof createEngine>;

  async function project(projectId: string, shapes: WorkplaneShape[]) {
    await writeProjectMetadata(root, projectId, { id: projectId, name: projectId, createdAt: 1, revision: 1 });
    await store.write(projectId, (await store.read(projectId))!, shapes);
    value(await engine.addParameter(projectId, { name: "w", expression: "3", dimension: "length" }));
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-binding-order-"));
    store = directoryProjectStore(root);
    engine = createEngine(store);
    await writeProjectMetadata(root, "template", { id: "template", name: "template", createdAt: 1, revision: 1 });
    template = value(await engine.addShapes("template", [{ kind: "box", width: 2, depth: 2, height: 3 }])).shapes[0]!;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves a field expression before it checks for a conflicting constraint binding", async () => {
    await project("field", [output("out", { sketchProfile: rectangle("w") })]);
    expect(await engine.bindShapeField("field", "out", "width", "nope")).toMatchObject({
      ok: false, failure: { reason: "binding_invalid", error: { code: "invalidExpression", field: "width" } },
    });
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a locked field bind before it reads the expression, without naming a top-level group", async () => {
    const child = output("child", plain);
    const inner = { ...output("inner", plain), locked: true, groupedShapes: [child] };
    const outer = { ...output("outer", plain), groupedShapes: [inner] };
    await project("locked-field", [outer, output("top", { locked: true, sketchProfile: undefined, sketchOperation: undefined, sketchSourceId: undefined })]);
    expect(await engine.bindShapeField("locked-field", "top", "width", "nope")).toEqual({ ok: false, failure: { reason: "shape_locked", ids: ["top"] } });
    expect(await engine.bindShapeField("locked-field", "child", "width", "w")).toEqual({ ok: false, failure: { reason: "shape_locked", ids: ["inner"] } });
  }, CAD_TEST_TIMEOUT_MS);

  it("names the top-level group for a constraint bind under a nested lock, before it looks up the constraint", async () => {
    const sketch = output("sketch");
    const inner = { ...output("inner", plain), locked: true, groupedShapes: [sketch] };
    const outer = { ...output("outer", plain), groupedShapes: [inner] };
    await project("locked-constraint", [outer]);
    const refusal = { ok: false, failure: { reason: "shape_locked", ids: ["inner"], topLevelId: "outer" } };
    expect(await engine.bindSketchConstraint("locked-constraint", "sketch", "width", "nope")).toEqual(refusal);
    expect(await engine.bindSketchConstraint("locked-constraint", "sketch", "missing", null)).toEqual(refusal);
  }, CAD_TEST_TIMEOUT_MS);

  it("checks the rebuild recipe, then the expression, then a conflicting size binding", async () => {
    await project("constraint", [
      output("plain", { sketchOperation: undefined }),
      output("sized", { expressions: { width: "w" }, width: 3 }),
    ]);
    expect(await engine.bindSketchConstraint("constraint", "plain", "width", "nope")).toMatchObject({
      ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "sketchNotRebuildable", shapeId: "plain" } },
    });
    expect(await engine.bindSketchConstraint("constraint", "sized", "width", "nope")).toMatchObject({
      ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "invalidExpression", constraintId: "width" } },
    });
    expect(await engine.bindSketchConstraint("constraint", "sized", "width", "w")).toMatchObject({
      ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "conflictingBinding", fields: ["width"] } },
    });
  }, CAD_TEST_TIMEOUT_MS);

  it("refuses a constraint bind inside a group whose size is bound, naming the group's fields", async () => {
    const sketch = output("nested");
    const group = { ...output("group", plain), expressions: { depth: "w" }, depth: 3, groupedShapes: [sketch] };
    await project("group", [group]);
    expect(await engine.bindSketchConstraint("group", "nested", "width", "w")).toMatchObject({
      ok: false, failure: { reason: "constraint_binding_invalid", error: { code: "conflictingBinding", shapeId: "nested", fields: ["depth"] } },
    });
  }, CAD_TEST_TIMEOUT_MS);
});

describe("the editor's constraint entry", () => {
  it("reports a conflicting size binding before it reads the expression", () => {
    const sized = output("sized", { expressions: { width: "w" } });
    expect(resolveConstraintEntry(widthConstraint(), "nope", [], sized)).toMatchObject({ ok: false, error: { code: "conflictingBinding" } });
  });

  it("leaves locks and rebuild recipes to the sketch's commit", () => {
    const locked = output("locked", { locked: true, shell: { thickness: 0.2 } } as Partial<WorkplaneShape>);
    expect(resolveConstraintEntry(widthConstraint(), "3", [], locked)).toEqual({ ok: true, value: 3, expression: null });
    expect(resolveConstraintEntry(widthConstraint(), "3 mm", [], locked)).toEqual({ ok: true, value: 3, expression: "3 mm" });
  });
});

describe("validateBinding", () => {
  const parameters = [{ name: "w", expression: "3", dimension: "length" as const, value: 3 }];
  const sized = output("sized", { expressions: { width: "w" } });

  it("refuses a clear only for a lock", () => {
    const target = { shape: { ...sized, sketchProfile: rectangle("w") }, topLevel: true };
    expect(validateBinding({ roots: [target.shape], target, parameters }, { field: "width", expression: null })).toEqual({ ok: true });
    expect(validateBinding({ roots: [target.shape], target: { ...target, locked: "sized" } }, { field: "width", expression: null }))
      .toEqual({ ok: false, failure: { reason: "shape_locked", ids: ["sized"] } });
  });

  it("returns the resolved value, and runs only the tree rules without a table", () => {
    const target = { shape: output("free"), topLevel: true };
    expect(validateBinding({ roots: [target.shape], target, parameters }, { field: "width", expression: "w * 2" })).toEqual({ ok: true, value: 6 });
    expect(validateBinding({ roots: [target.shape], target }, { field: "width", expression: "nope" })).toEqual({ ok: true, value: undefined });
  });

  it("does not count a size binding the same request clears", () => {
    const target = { shape: sized, topLevel: true };
    const change = { constraintId: "width", constraint: widthConstraint(), expression: "w" };
    expect(validateBinding({ roots: [sized], target }, change)).toMatchObject({ ok: false, failure: { error: { code: "conflictingBinding" } } });
    expect(validateBinding({ roots: [sized], target }, { ...change, clearedFields: ["width"] })).toEqual({ ok: true, value: undefined });
  });
});

describe("deprecated binding predicates", () => {
  // Published importers reach these through the package entry and the old module paths.
  it("keep their old import paths and results", () => {
    const sized = output("sized", { expressions: { width: "w" } });
    const nested = output("nested", { sketchProfile: rectangle("w") });
    const group = { ...output("group", plain), expressions: { depth: "w" }, groupedShapes: [nested] };

    expect(engineEntry.conflictingConstraintBinding).toBe(oldConstraintPath.conflictingConstraintBinding);
    expect(engineEntry.boundProfileSizeFields(sized)).toEqual(["width"]);
    expect(engineEntry.rebuildableSketch(sized, true)).toBe(true);
    expect(oldConstraintPath.conflictingConstraintBinding(sized, "width")).toMatchObject({ code: "conflictingBinding", fields: ["width"] });
    expect(oldConstraintPath.conflictingGroupSizeBinding("nested", "width", ["depth"])).toEqual({
      code: "conflictingBinding",
      shapeId: "nested",
      constraintId: "width",
      fields: ["depth"],
      message: "width cannot bind: depth is bound on a group that holds nested, and a re-solve would refit that group. Clear one binding first.",
    });
    expect(oldConstraintPath.conflictingGroupSizeBinding("nested", "width", [])).toBeUndefined();
    expect(oldConstraintPath.boundAncestorSizeFields([group], "nested")).toEqual(["depth"]);
    expect(oldConstraintPath.boundGroupSizeFields(group)).toEqual(["depth"]);
    expect(oldConstraintPath.groupRefitBindings(group)).toEqual({ constraintIds: ["width"], fields: [] });
    expect(oldConstraintPath.sketchNotRebuildable("s", "c")).toMatchObject({ code: "sketchNotRebuildable", shapeId: "s", constraintId: "c" });
    expect(typeof oldConstraintPath.sketchConstraintBindingIssues).toBe("function");
    expect(oldFieldPath.GROUP_SIZE_FIELDS).toEqual(["width", "depth", "height"]);
    expect(oldFieldPath.refitsParent("edgeTreatments.0.amount")).toBe(false);
    expect(oldFieldPath.nestedRefitFields({ ...group, groupedShapes: [{ ...nested, expressions: { x: "w" } }] })).toEqual(["nested.x"]);
    expect(typeof oldFieldPath.shapeBindingIssues).toBe("function");
  });
});
