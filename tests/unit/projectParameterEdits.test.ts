import { describe, expect, it } from "vitest";
import { resolveProjectParameters } from "@constructorfleet/sketchforge-engine/projectParameters";
import { SOURCE_MESSAGES } from "@/i18n/locales";
import {
  parameterDeleteWarning,
  parameterEditFailureMessage,
  parameterErrorMessage,
  parameterNameOptions,
  parameterRows,
  parameterTableKey,
  planParameterEdit,
  type ParameterProject,
} from "@/lib/projectParameterEdits";
import type { ProjectParameterInput } from "@constructorfleet/sketchforge-engine/projectParameters";
import type { WorkplaneShape } from "@/types/sketchforge";

function table(entries: ProjectParameterInput[]) {
  const resolved = resolveProjectParameters(entries);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.parameters;
}

function box(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "box-1", name: "Box", kind: "box", color: "#d41721", x: 0, z: 0, elevation: 0,
    size: 20, width: 20, depth: 20, height: 20, rotation: 0, locked: false, hidden: false, ...overrides,
  };
}

function project(overrides: Partial<ParameterProject> = {}): ParameterProject {
  return {
    parameters: table([
      { name: "wall", expression: "2 mm", dimension: "length" },
      { name: "depth", expression: "wall * 5", dimension: "length" },
      { name: "spare", expression: "30 deg", dimension: "angle" },
    ]),
    shapes: [box({ expressions: { width: "depth * 2" } }), box({ id: "box-2", name: "Free box" })],
    ...overrides,
  };
}

function message(key: string) {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], SOURCE_MESSAGES);
}

describe("planParameterEdit", () => {
  it("adds a parameter locally when no binding reads it", () => {
    const planned = planParameterEdit(project(), { kind: "add", name: "gap", expression: "wall / 2", dimension: "length" });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.recompute).toBe(false);
    expect(planned.project.parameters.at(-1)).toMatchObject({ name: "gap", value: 1 });
  });

  it("asks for a recompute when a changed value feeds a shape binding, even through another parameter", () => {
    const planned = planParameterEdit(project(), { kind: "update", name: "wall", expression: "3 mm" });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.recompute).toBe(true);
    expect(planned.project.parameters.find((parameter) => parameter.name === "depth")?.value).toBe(15);
    // The local plan never moves geometry; the engine does that.
    expect(planned.project.shapes[0]!.width).toBe(20);
  });

  it("does not recompute when only an unbound parameter changes", () => {
    const planned = planParameterEdit(project(), { kind: "update", name: "spare", expression: "45 deg" });
    expect(planned.ok && planned.recompute).toBe(false);
  });

  it("refuses an invalid expression and a cycle, leaving the project untouched", () => {
    const before = project();
    const invalid = planParameterEdit(before, { kind: "update", name: "wall", expression: "2 +" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalidExpression", expressionError: { code: "parseError" } } });
    const cycle = planParameterEdit(before, { kind: "update", name: "wall", expression: "depth / 5" });
    expect(cycle).toMatchObject({ ok: false, error: { code: "invalidExpression", expressionError: { code: "cycle" } } });
    expect(before.parameters.find((parameter) => parameter.name === "wall")?.expression).toBe("2 mm");
  });

  it("renames references in the table and in shape bindings without a recompute", () => {
    const planned = planParameterEdit(project(), { kind: "rename", name: "depth", newName: "length" });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.recompute).toBe(false);
    expect(planned.project.parameters.map((parameter) => parameter.name)).toEqual(["wall", "length", "spare"]);
    expect(planned.project.shapes[0]!.expressions).toEqual({ width: "length * 2" });
  });

  it("refuses to delete a parameter in use unless its shape bindings are released", () => {
    const refused = planParameterEdit(project(), { kind: "delete", name: "depth" });
    expect(refused).toMatchObject({ ok: false, error: { code: "parameterInUse", shapeDependents: [{ shapeId: "box-1", fields: ["width"] }] } });

    const released = planParameterEdit(project(), { kind: "delete", name: "depth", releaseShapes: true });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.recompute).toBe(false);
    expect(released.project.parameters.map((parameter) => parameter.name)).toEqual(["wall", "spare"]);
    expect(released.project.shapes[0]!.expressions).toBeUndefined();
    expect(released.project.shapes[0]!.width).toBe(20);
  });

  it("releases bindings inside groups and treatment snapshots, and keeps other bindings", () => {
    const child = box({ id: "child", expressions: { "revolve.sweepAngle": "spare", width: "depth" } });
    const treated = box({
      id: "treated",
      expressions: { height: "depth" },
      edgeTreatmentHistory: [{ id: "entry", before: box({ id: "treated", expressions: { height: "depth" } }) } as never],
    });
    const group = box({ id: "group", groupedShapes: [child] });
    const released = planParameterEdit(project({ shapes: [group, treated] }), { kind: "delete", name: "depth", releaseShapes: true });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const [nextGroup, nextTreated] = released.project.shapes;
    expect(nextGroup!.groupedShapes![0]!.expressions).toEqual({ "revolve.sweepAngle": "spare" });
    expect(nextTreated!.expressions).toBeUndefined();
    expect(nextTreated!.edgeTreatmentHistory![0]!.before.expressions).toBeUndefined();
  });

  it("never releases shapes while a parameter still depends on the one deleted", () => {
    const refused = planParameterEdit(project(), { kind: "delete", name: "wall", releaseShapes: true });
    expect(refused).toMatchObject({ ok: false, error: { code: "parameterInUse", dependents: ["depth"] } });
  });
});

describe("parameterDeleteWarning", () => {
  it("lists dependent parameters and shapes by name", () => {
    expect(parameterDeleteWarning(project(), "depth")).toEqual({
      parameters: [],
      configurations: [],
      shapes: [{ shapeId: "box-1", name: "Box", fields: ["width"], constraints: [] }],
    });
    expect(parameterDeleteWarning(project(), "wall")).toEqual({ parameters: ["depth"], configurations: [], shapes: [] });
    expect(parameterDeleteWarning(project(), "spare")).toBeNull();
  });
});

describe("parameter rows and name options", () => {
  it("shows name, expression, resolved value, and unit, with an inline error for a stale entry", () => {
    const parameters = table([
      { name: "wall", expression: "2 mm", dimension: "length" },
      { name: "turn", expression: "90 deg", dimension: "angle" },
      { name: "count", expression: "4", dimension: "unitless" },
      { name: "broken", expression: "missing * 2", dimension: "length", value: 7 },
    ]);
    expect(parameterRows(parameters).map(({ name, expression, value, unit, error }) => ({ name, expression, value, unit, error: error?.key }))).toEqual([
      { name: "wall", expression: "2 mm", value: "2", unit: "mm", error: undefined },
      { name: "turn", expression: "90 deg", value: "90", unit: "°", error: undefined },
      { name: "count", expression: "4", value: "4", unit: "", error: undefined },
      { name: "broken", expression: "missing * 2", value: "7", unit: "mm", error: "editor.parameters.error.unknownName" },
    ]);
  });

  it("offers parameter names for autocomplete, prefix matches first", () => {
    const parameters = table([
      { name: "wall", expression: "2", dimension: "length" },
      { name: "sidewall", expression: "3", dimension: "length" },
      { name: "width", expression: "40", dimension: "length" },
      { name: "angle", expression: "30 deg", dimension: "angle" },
    ]);
    expect(parameterNameOptions(parameters, "wa").map((option) => option.name)).toEqual(["wall", "sidewall"]);
    expect(parameterNameOptions(parameters, "W").map((option) => option.name)).toEqual(["wall", "width", "sidewall"]);
    expect(parameterNameOptions(parameters, "", "angle").map((option) => option.name)).toEqual(["angle"]);
    expect(parameterNameOptions(parameters)[0]).toEqual({ name: "angle", dimension: "angle", expression: "30 deg", value: 30 });
  });

  it("keys a table by content so a repeated host prop is not a change", () => {
    const parameters = project().parameters;
    expect(parameterTableKey(parameters)).toBe(parameterTableKey(parameters.map((parameter) => ({ ...parameter }))));
    expect(parameterTableKey([])).not.toBe(parameterTableKey(parameters));
    expect(parameterTableKey(parameters)).not.toBe(parameterTableKey(planParameterEditOrThrow({ kind: "update", name: "wall", expression: "3" })));
  });
});

function planParameterEditOrThrow(edit: Parameters<typeof planParameterEdit>[1]) {
  const planned = planParameterEdit(project(), edit);
  if (!planned.ok) throw new Error(planned.error.message);
  return planned.project.parameters;
}

describe("parameter error messages", () => {
  it("maps every table and expression error to a catalog message", () => {
    const cycle = planParameterEdit(project(), { kind: "update", name: "wall", expression: "depth / 5" });
    expect(cycle.ok).toBe(false);
    if (cycle.ok) return;
    const cycleMessage = parameterErrorMessage(cycle.error);
    expect(cycleMessage).toEqual({ key: "editor.parameters.error.cycle", values: { cycle: "wall → depth → wall" } });

    const codes = ["invalidParameter", "invalidName", "duplicateName", "invalidDimension", "unknownParameter", "parameterInUse", "tooManyParameters",
      "duplicateConfigurationName", "invalidConfiguration", "invalidConfigurationName", "tooManyConfigurations", "unknownConfiguration"] as const;
    for (const code of codes) {
      const { key } = parameterErrorMessage({ code, message: "", parameter: "wall" });
      expect(typeof message(key), key).toBe("string");
    }
    const expressionCodes = ["parseError", "unknownName", "unknownFunction", "argumentCount", "dimensionMismatch", "divisionByZero", "nonFinite", "invalidArgument", "invalidDimension", "limitExceeded", "cycle", "dependencyFailed", "invalidName", "duplicateName"] as const;
    for (const code of expressionCodes) {
      const { key } = parameterErrorMessage({ code: "invalidExpression", message: "", parameter: "wall", expressionError: { code, message: "", span: { start: 0, end: 0 } } });
      expect(typeof message(key), key).toBe("string");
    }
  });

  it("names the shape and field a recompute refused", () => {
    const shapes = [box()];
    expect(parameterEditFailureMessage({ reason: "binding_invalid", error: { code: "outOfRange", message: "", shapeId: "box-1", field: "width", value: -3, min: 0 } }, shapes))
      .toEqual({ key: "editor.parameters.error.outOfRange", values: { shape: "Box", field: "width", value: "-3" } });
    expect(parameterEditFailureMessage({ reason: "binding_failed", shapeId: "box-1", fields: ["width"], failure: { reason: "shape_locked", ids: ["box-1"] } }, shapes))
      .toEqual({ key: "editor.parameters.error.shapeLocked", values: { shape: "Box" } });
    expect(parameterEditFailureMessage({ reason: "binding_failed", shapeId: "gone", fields: ["height", "width"], failure: { reason: "cad_failed" } }, shapes))
      .toEqual({ key: "editor.parameters.error.recomputeFailed", values: { shape: "gone", field: "height, width" } });
    expect(parameterEditFailureMessage(null, shapes)).toEqual({ key: "editor.parameters.error.serverUnavailable", values: {} });
    expect(parameterEditFailureMessage({ reason: "cad_failed" }, shapes)).toEqual({ key: "editor.parameters.error.recomputeFailedGeneric", values: {} });
  });
});
