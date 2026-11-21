import { describe, expect, it } from "vitest";
import { resolveProjectParameters, type ProjectParameterInput } from "@constructorfleet/sketchforge-engine/projectParameters";
import {
  applyExpressionCompletion,
  bindResponseMessage,
  bindScope,
  bindShapeFieldLocally,
  bindingFailureMessage,
  constraintBindingMessage,
  expressionCompletionAt,
  isLiteralNumberEntry,
  propertyBindingField,
  releaseEditedBindings,
  withRebuiltBindings,
  resolveConstraintEntry,
} from "@/lib/expressionFields";
import { getShapePropertiesWithAppLimits, placementProperties, type RangePropertyConfig } from "@/lib/shapeProperties";
import type { SketchConstraint, WorkplaneShape } from "@/types/sketchforge";

function table(entries: ProjectParameterInput[]) {
  const resolved = resolveProjectParameters(entries);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.parameters;
}

const parameters = table([
  { name: "wall", expression: "2 mm", dimension: "length" },
  { name: "width_total", expression: "wall * 20", dimension: "length" },
  { name: "tilt", expression: "30 deg", dimension: "angle" },
  { name: "count", expression: "5", dimension: "unitless" },
]);

function box(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "box-1", name: "Box", kind: "box", color: "#d41721", x: 0, z: 0, elevation: 0,
    size: 20, width: 20, depth: 20, height: 20, rotation: 0, locked: false, hidden: false, ...overrides,
  };
}

const noop = () => undefined;
function range(shape: WorkplaneShape, id: string) {
  const all = [
    ...getShapePropertiesWithAppLimits(shape, noop),
    ...placementProperties(shape, noop, { halfWidth: 100, halfDepth: 100, maxElevation: 100 }),
  ];
  return all.find((property) => property.id === id) as RangePropertyConfig;
}

describe("isLiteralNumberEntry", () => {
  it("accepts plain numbers in either decimal style", () => {
    for (const text of ["12", " -3.5 ", "+4", ".5", "2,5", "1.234,5", "1,234.5", "1e3", "2.5E-2", "-1e+2"]) expect(isLiteralNumberEntry(text), text).toBe(true);
  });

  it("treats anything with a name, unit or operator as an expression", () => {
    for (const text of ["wall", "wall * 2", "2 mm", "1+1", "(3)", "", "  ", "2e3x", "2e", "e3"]) expect(isLiteralNumberEntry(text), text).toBe(false);
  });
});

describe("propertyBindingField", () => {
  it("names the engine field each inspector row drives", () => {
    const shape = box();
    expect(propertyBindingField(shape, range(shape, "length"))?.field).toBe("depth");
    expect(propertyBindingField(shape, range(shape, "width"))?.field).toBe("width");
    expect(propertyBindingField(shape, range(shape, "positionX"))?.field).toBe("x");
    expect(propertyBindingField(shape, range(shape, "positionY"))?.field).toBe("elevation");
    expect(propertyBindingField(shape, range(shape, "rotationY"))?.dimension).toBe("angle");
  });

  it("refuses a row whose displayed number is not the stored field", () => {
    // A tapered box shows its overall footprint, not its base width.
    const tapered = box({ taperTopWidth: 40, taperTopDepth: 20 });
    const row = range(tapered, "width");
    expect(row.value).not.toBe(tapered.width);
    expect(propertyBindingField(tapered, row)).toBeUndefined();
  });

  it("refuses rows the engine cannot bind", () => {
    const gear = { ...box({ kind: "gear", teeth: 20 }), gearType: "helical" } as WorkplaneShape;
    expect(propertyBindingField(gear, range(gear, "quality"))).toBeUndefined();
    expect(propertyBindingField(gear, range(gear, "teeth"))?.field).toBe("teeth");
  });
});

describe("releaseEditedBindings", () => {
  it("drops a binding whose number a local edit changed", () => {
    const before = [box({ x: 4, expressions: { x: "wall * 2", width: "width_total" } })];
    const after = [{ ...before[0]!, x: 9 }];
    const [released] = releaseEditedBindings(before, after);
    expect(released!.expressions).toEqual({ width: "width_total" });
    expect(released!.x).toBe(9);
  });

  it("keeps a binding the edit set, and shapes it did not touch by reference", () => {
    const before = [box({ id: "a" }), box({ id: "b", expressions: { width: "width_total" } })];
    const after = [{ ...before[0]!, width: 40, expressions: { width: "width_total" } }, before[1]!];
    const released = releaseEditedBindings(before, after);
    expect(released[0]!.expressions).toEqual({ width: "width_total" });
    expect(released[1]).toBe(before[1]);
    expect(releaseEditedBindings(after, after)).toBe(after);
  });

  it("drops the last binding without leaving an empty map", () => {
    const before = [box({ expressions: { height: "wall * 10" } })];
    const [released] = releaseEditedBindings(before, [{ ...before[0]!, height: 25 }]);
    expect(Object.hasOwn(released!, "expressions")).toBe(false);
  });

  it("releases bindings inside groups", () => {
    const child = { ...box({ id: "c" }), sketchRevolve: undefined, expressions: { "faceDraft.angle": "tilt" }, faceDraft: { sourceFaceId: "f", angle: 30, pullDirection: [0, 1, 0] } } as unknown as WorkplaneShape;
    const before = [box({ id: "g", groupedShapes: [child] })];
    const moved = { ...child, faceDraft: { ...child.faceDraft!, angle: 12 } } as WorkplaneShape;
    const [group] = releaseEditedBindings(before, [{ ...before[0]!, groupedShapes: [moved] }]);
    expect(group!.groupedShapes![0]!.expressions).toBeUndefined();
  });

  it("drops a sketch constraint's expression when its value changes", () => {
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distance", pointIds: ["a", "b"], valueMm: 4, expression: "wall * 2" },
      { id: "a1", kind: "angle", segmentIds: ["s", "t"], valueDeg: 30, expression: "tilt" },
    ];
    const sketch = box({ id: "s", kind: "sketch", sketchProfile: { points: [], segments: [], constraints } } as Partial<WorkplaneShape>);
    const edited = { ...sketch, sketchProfile: { ...sketch.sketchProfile!, constraints: [{ ...constraints[0]!, valueMm: 7 } as SketchConstraint, constraints[1]!] } };
    const [released] = releaseEditedBindings([sketch], [edited]);
    const [distance, angle] = released!.sketchProfile!.constraints!;
    expect(distance).not.toHaveProperty("expression");
    expect((distance as { valueMm: number }).valueMm).toBe(7);
    expect(angle).toHaveProperty("expression", "tilt");
  });
});

describe("withRebuiltBindings", () => {
  const revolve = (settings: Record<string, number>, expressions?: Record<string, string>) => box({
    kind: "mesh",
    sketchOperation: "revolve",
    sketchRevolve: { startAngle: 0, sweepAngle: 360, sides: 48, quality: 3, pitch: 0, turns: 1, coreRadius: 0, ...settings },
    ...(expressions ? { expressions } : {}),
  } as Partial<WorkplaneShape>);

  it("keeps the bindings a rebuild did not change, and drops those it did", () => {
    const previous = revolve({}, { "revolve.sweepAngle": "tilt * 12", "revolve.startAngle": "tilt", x: "wall" });
    const rebuilt = revolve({ startAngle: 45 });
    const kept = withRebuiltBindings(previous, rebuilt);
    expect(kept.expressions).toEqual({ "revolve.sweepAngle": "tilt * 12", x: "wall" });
    expect(kept.sketchRevolve?.startAngle).toBe(45);
  });

  it("returns the rebuilt shape unchanged when nothing was bound", () => {
    const rebuilt = revolve({ startAngle: 45 });
    expect(withRebuiltBindings(revolve({}), rebuilt)).toBe(rebuilt);
  });

  it("drops the bindings named as released", () => {
    const previous = revolve({}, { "revolve.sweepAngle": "tilt * 12", x: "wall" });
    expect(withRebuiltBindings(previous, revolve({}), ["revolve.sweepAngle"]).expressions).toEqual({ x: "wall" });
  });
});

describe("bindShapeFieldLocally", () => {
  it("resolves the expression through the engine and stores value and binding", () => {
    const result = bindShapeFieldLocally([box()], parameters, "box-1", "width", "wall * 15");
    expect(result).toMatchObject({ ok: true });
    if (!result?.ok) throw new Error("expected a local bind");
    expect(result.shapes[0]!.width).toBe(30);
    expect(result.shapes[0]!.expressions).toEqual({ width: "wall * 15" });
  });

  it("gives a bare number the field's unit", () => {
    const result = bindShapeFieldLocally([box()], parameters, "box-1", "rotation", "tilt + 15");
    if (!result?.ok) throw new Error("expected a local bind");
    expect(result.shapes[0]!.rotation).toBe(45);
  });

  it("refuses an invalid expression without a new shape array", () => {
    const shapes = [box()];
    const unknown = bindShapeFieldLocally(shapes, parameters, "box-1", "width", "nope * 2");
    expect(unknown).toMatchObject({ ok: false, failure: { reason: "binding_invalid", error: { code: "invalidExpression" } } });
    const wrongUnit = bindShapeFieldLocally(shapes, parameters, "box-1", "width", "tilt");
    expect(wrongUnit).toMatchObject({ ok: false, failure: { error: { expressionError: { code: "dimensionMismatch" } } } });
    expect(shapes[0]!.expressions).toBeUndefined();
  });

  it("refuses a value outside the field's range instead of clamping", () => {
    expect(bindShapeFieldLocally([box()], parameters, "box-1", "width", "wall * -1")).toMatchObject({
      ok: false, failure: { reason: "binding_invalid", error: { code: "outOfRange" } },
    });
  });

  it("removes a binding locally for any shape", () => {
    const sketch = box({ kind: "sketch", sketchProfile: { points: [], segments: [] }, expressions: { x: "wall" } } as Partial<WorkplaneShape>);
    const result = bindShapeFieldLocally([sketch], parameters, "box-1", "x", null);
    if (!result?.ok) throw new Error("expected a local unbind");
    expect(result.shapes[0]!.expressions).toBeUndefined();
  });

  it("defers to the server when the shape needs kernel work", () => {
    const sketch = box({ kind: "sketch", sketchProfile: { points: [], segments: [] } } as Partial<WorkplaneShape>);
    expect(bindShapeFieldLocally([sketch], parameters, "box-1", "x", "wall")).toBeNull();
    expect(bindShapeFieldLocally([box({ edgeTreatments: [] as never })], parameters, "box-1", "x", "wall")).toBeNull();
  });

  it("refuses a locked shape", () => {
    expect(bindShapeFieldLocally([box({ locked: true })], parameters, "box-1", "x", "wall")).toMatchObject({
      ok: false, failure: { reason: "binding_failed", failure: { reason: "shape_locked" } },
    });
  });
});

describe("bindingFailureMessage", () => {
  it("names the expression problem for the field", () => {
    const shapes = [box()];
    const failure = bindShapeFieldLocally(shapes, parameters, "box-1", "width", "tilt");
    if (!failure || failure.ok) throw new Error("expected a refusal");
    const message = bindingFailureMessage(failure.failure, shapes);
    expect(message).toEqual({ key: "editor.expressionField.error.needsLength", values: {} });
  });

  it("names the bound constraints when a size bind would rescale the sketch", () => {
    const failure = { reason: "binding_invalid", error: { code: "conflictingBinding", shapeId: "box-1", field: "width", constraintIds: ["d1", "d2"] } };
    expect(bindingFailureMessage(failure, [box()])).toEqual({ key: "editor.expressionField.error.sizeConflictsWithConstraints", values: { constraints: "d1, d2" } });
  });

  it("maps out-of-range and unknown names", () => {
    const shapes = [box()];
    const range = bindShapeFieldLocally(shapes, parameters, "box-1", "width", "wall * -1");
    if (!range || range.ok) throw new Error("expected a refusal");
    expect(bindingFailureMessage(range.failure, shapes)).toEqual({ key: "editor.expressionField.error.outOfRange", values: { value: "-2" } });
    const unknown = bindShapeFieldLocally(shapes, parameters, "box-1", "width", "nope");
    if (!unknown || unknown.ok) throw new Error("expected a refusal");
    expect(bindingFailureMessage(unknown.failure, shapes).key).toBe("editor.parameters.error.unknownName");
  });
});

describe("bindScope", () => {
  it("sends the tree that holds the shape and trees sharing its sketch source", () => {
    const output = box({ id: "out", sketchSourceId: "src" } as Partial<WorkplaneShape>);
    const group = box({ id: "group", groupedShapes: [output] });
    const twin = box({ id: "twin", sketchSourceId: "src" } as Partial<WorkplaneShape>);
    const other = box({ id: "other" });
    expect(bindScope([group, other, twin], "out").map((shape) => shape.id)).toEqual(["group", "twin"]);
    expect(bindScope([group, other], "other").map((shape) => shape.id)).toEqual(["other"]);
    expect(bindScope([other], "missing")).toEqual([]);
  });
});

describe("bindResponseMessage", () => {
  it("maps an engine failure to the field message, and transport failures to the panel's", () => {
    const shapes = [box()];
    const failure = { reason: "binding_invalid", error: { code: "notAnInteger", shapeId: "box-1", field: "sides" } };
    expect(bindResponseMessage(422, { failure }, shapes).key).toBe("editor.expressionField.error.notAnInteger");
    expect(bindResponseMessage(413, null, shapes).key).toBe("editor.parameters.error.requestTooLarge");
    expect(bindResponseMessage(500, "oops", shapes).key).toBe("editor.parameters.error.serverError");
  });
});

describe("resolveConstraintEntry", () => {
  const distance: SketchConstraint = { id: "d1", kind: "distance", pointIds: ["a", "b"], valueMm: 4 };

  it("binds an expression and resolves its value", () => {
    expect(resolveConstraintEntry(distance, "wall * 3", parameters)).toEqual({ ok: true, value: 6, expression: "wall * 3" });
  });

  it("refuses a constraint expression when the output's profile size is bound, as the engine does", () => {
    const output = box({ kind: "sketch", sketchProfile: { points: [], segments: [], constraints: [distance] }, sketchOperation: "extrude", expressions: { width: "wall * 10" } } as Partial<WorkplaneShape>);
    const refused = resolveConstraintEntry(distance, "wall * 3", parameters, output);
    expect(refused).toMatchObject({ ok: false, error: { code: "conflictingBinding", fields: ["width"] } });
    if (refused.ok) return;
    expect(constraintBindingMessage(refused.error)).toEqual({ key: "editor.expressionField.error.constraintConflictsWithSize", values: { fields: "width" } });
    // A literal is not a binding, so it does not conflict.
    expect(resolveConstraintEntry(distance, "8", parameters, output)).toEqual({ ok: true, value: 8, expression: null });
    // An extrusion's height is not in the profile.
    const tall = { ...output, expressions: { height: "wall * 10" } };
    expect(resolveConstraintEntry(distance, "wall * 3", parameters, tall).ok).toBe(true);
  });

  it("takes a plain number as a literal that clears the binding", () => {
    expect(resolveConstraintEntry({ ...distance, expression: "wall" }, "8", parameters)).toEqual({ ok: true, value: 8, expression: null });
  });

  it("refuses a wrong dimension or an out-of-range value", () => {
    const wrong = resolveConstraintEntry(distance, "tilt", parameters);
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(constraintBindingMessage(wrong.error)).toEqual({ key: "editor.expressionField.error.needsLength", values: {} });
    const angle: SketchConstraint = { id: "a1", kind: "angle", segmentIds: ["s", "t"], valueDeg: 30 };
    const wrongAngle = resolveConstraintEntry(angle, "wall", parameters);
    if (wrongAngle.ok) throw new Error("expected a refusal");
    expect(constraintBindingMessage(wrongAngle.error, "angle").key).toBe("editor.expressionField.error.needsAngle");
    const negative = resolveConstraintEntry({ id: "a1", kind: "angle", segmentIds: ["s", "t"], valueDeg: 30 }, "tilt * 7", parameters);
    if (negative.ok) throw new Error("expected a refusal");
    expect(constraintBindingMessage(negative.error).key).toBe("editor.expressionField.error.constraintOutOfRange");
    const literal = resolveConstraintEntry(distance, "-1", parameters);
    expect(literal.ok).toBe(false);
  });
});

describe("expression completion", () => {
  it("finds the name being typed at the caret", () => {
    expect(expressionCompletionAt("wall * wi", 9)).toEqual({ start: 7, end: 9, query: "wi" });
    expect(expressionCompletionAt("wall * wi", 2)).toEqual({ start: 0, end: 4, query: "wa" });
    expect(expressionCompletionAt("2 * ", 4)).toBeNull();
    expect(expressionCompletionAt("12", 2)).toBeNull();
  });

  it("replaces the whole word and moves the caret after it", () => {
    expect(applyExpressionCompletion("wall * wi + 1", { start: 7, end: 9, query: "wi" }, "width_total")).toEqual({
      text: "wall * width_total + 1",
      caret: 18,
    });
  });
});
