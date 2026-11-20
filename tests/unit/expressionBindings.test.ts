import { describe, expect, it } from "vitest";
import {
  addParameter,
  bindableField,
  bindableFieldsFor,
  boundFieldsNamedBy,
  deleteParameter,
  EXPRESSION_BINDABLE_FIELDS,
  projectParameterDependents,
  renameParameter,
  resolveShapeBinding,
  shapeBindingIssues,
  type ProjectParameter,
  type ProjectParameterResult,
} from "@constructorfleet/sketchforge-engine";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

function ok<T>(result: ProjectParameterResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
}

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "box-1",
    kind: "box",
    name: "Box",
    color: "#ffffff",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...overrides,
  } as WorkplaneShape;
}

function parameters(...entries: Array<[string, string, ProjectParameter["dimension"]]>): ProjectParameter[] {
  let current: { parameters: ProjectParameter[] } = { parameters: [] };
  for (const [name, expression, dimension] of entries) current = ok(addParameter(current, { name, expression, dimension }));
  return current.parameters;
}

describe("bindable field catalog", () => {
  it("lists each field once with its dimension", () => {
    const fields = EXPRESSION_BINDABLE_FIELDS.map((spec) => spec.field);
    expect(new Set(fields).size).toBe(fields.length);
    expect(EXPRESSION_BINDABLE_FIELDS.every((spec) => ["length", "angle", "unitless"].includes(spec.dimension))).toBe(true);
  });

  it("answers per shape kind and retained feature", () => {
    const box = bindableFieldsFor(shape()).map((spec) => spec.field);
    expect(box).toEqual(expect.arrayContaining(["x", "z", "elevation", "width", "depth", "height", "rotation"]));
    expect(box).not.toContain("sides");
    expect(box).not.toContain("revolve.sweepAngle");
    expect(bindableField(shape({ kind: "cylinder" }), "sides")).toMatchObject({ dimension: "unitless", integer: true });
    expect(bindableField(shape(), "rotation")).toMatchObject({ dimension: "angle" });
    expect(bindableField(shape(), "edgeTreatments.0.amount")).toBeUndefined();

    const revolve = shape({
      kind: "mesh",
      sketchOperation: "revolve",
      sketchProfile: { points: [], segments: [] },
      sketchRevolve: { startAngle: 0, sweepAngle: 360, sides: 32, quality: 1, pitch: 0, turns: 1, coreRadius: 0 },
    });
    expect(bindableField(revolve, "revolve.sweepAngle")).toMatchObject({ dimension: "angle" });
    expect(bindableField(revolve, "revolve.pitch")).toMatchObject({ dimension: "length" });

    const filleted = shape({
      sketchOperation: "extrude",
      sketchSourceId: "sketch/a",
      sketchProfile: { points: [], segments: [] },
      edgeTreatments: [{ kind: "chamfer", amount: 1, edgeCount: 12, allEdges: true, chamferAngle: 45 }],
    });
    expect(bindableField(filleted, "edgeTreatments.0.amount")).toMatchObject({ dimension: "length", target: "feature" });
    expect(bindableField(filleted, "edgeTreatments.0.chamferAngle")).toMatchObject({ dimension: "angle" });
  });

  it("maps a change request to the binding keys it sets literally", () => {
    expect(boundFieldsNamedBy({ width: 3, size: 4, sweepAngle: 90, revolve: { pitch: 2 }, faceDraft: { angle: 5 } }).sort())
      .toEqual(["depth", "faceDraft.angle", "height", "revolve.pitch", "revolve.sweepAngle", "width"].sort());
  });
});

describe("resolving a binding", () => {
  const table = parameters(["wall", "2 mm", "length"], ["tilt", "30 deg", "angle"], ["count", "6", "unitless"]);

  it("evaluates against the table in the field's base unit", () => {
    expect(resolveShapeBinding(shape(), "width", "wall * 2 + 1in", table)).toEqual({ ok: true, value: 4 + 25.4 });
    expect(resolveShapeBinding(shape(), "width", "wall + 3", table)).toEqual({ ok: true, value: 5 });
    expect(resolveShapeBinding(shape(), "rotation", "tilt + 15", table)).toEqual({ ok: true, value: 45 });
    expect(resolveShapeBinding(shape({ kind: "cylinder" }), "sides", "count * 2", table)).toEqual({ ok: true, value: 12 });
  });

  it("reports a structured error for a wrong dimension, an unknown name, or a fractional count", () => {
    expect(resolveShapeBinding(shape(), "width", "tilt", table)).toMatchObject({
      ok: false, error: { code: "invalidExpression", field: "width", expressionError: { code: "dimensionMismatch" } },
    });
    expect(resolveShapeBinding(shape(), "width", "missing", table)).toMatchObject({
      ok: false, error: { code: "invalidExpression", expressionError: { code: "unknownName" } },
    });
    expect(resolveShapeBinding(shape({ kind: "cylinder" }), "sides", "count / 4", table)).toMatchObject({
      ok: false, error: { code: "notAnInteger", field: "sides" },
    });
    expect(resolveShapeBinding(shape(), "sides", "6", table)).toMatchObject({ ok: false, error: { code: "fieldNotBindable" } });
  });

  it("flags stale bindings without changing anything", () => {
    const shapes = [shape({ expressions: { width: "wall * 2", height: "gone", spin: "1" } })];
    const before = structuredClone(shapes);
    expect(shapeBindingIssues(shapes, table)).toEqual([
      expect.objectContaining({ shapeId: "box-1", field: "height", code: "invalidExpression" }),
      expect.objectContaining({ shapeId: "box-1", field: "spin", code: "fieldNotBindable" }),
    ]);
    expect(shapes).toEqual(before);
  });
});

describe("parameter operations and shape bindings", () => {
  const table = parameters(["wall", "2", "length"], ["lid", "wall * 2", "length"]);
  const child = shape({ id: "child", expressions: { width: "wall + lid" } });
  const project = {
    parameters: table,
    shapes: [
      shape({ id: "outer", expressions: { height: "wall*3" }, groupedShapes: [child] }),
      shape({
        id: "treated",
        expressions: { x: "wall" },
        edgeTreatmentHistory: [{ id: "t", createdAt: 1, feature: { kind: "fillet", amount: 1, edgeCount: 12 }, before: shape({ id: "treated", expressions: { x: "wall" } }) }],
      }),
    ],
  };

  it("rewrites shape and feature bindings on rename", () => {
    const renamed = ok(renameParameter(project, "wall", "thickness"));
    expect(renamed.parameters.map((parameter) => parameter.expression)).toEqual(["2", "thickness * 2"]);
    expect(renamed.shapes[0]!.expressions).toEqual({ height: "thickness*3" });
    expect(renamed.shapes[0]!.groupedShapes![0]!.expressions).toEqual({ width: "thickness + lid" });
    expect(renamed.shapes[1]!.expressions).toEqual({ x: "thickness" });
    expect(renamed.shapes[1]!.edgeTreatmentHistory![0]!.before.expressions).toEqual({ x: "thickness" });
    expect(project.shapes[0]!.expressions).toEqual({ height: "wall*3" });
  });

  it("refuses to delete a parameter a shape binds and names the shapes", () => {
    expect(projectParameterDependents(project, "lid")).toEqual({ parameters: [], shapes: [{ shapeId: "child", fields: ["width"] }] });
    const refused = deleteParameter(project, "lid");
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "parameterInUse", dependents: [], shapeDependents: [{ shapeId: "child", fields: ["width"] }] },
    });
    expect(projectParameterDependents(project, "wall").shapes.map((entry) => entry.shapeId)).toEqual(["outer", "child", "treated"]);
  });
});
