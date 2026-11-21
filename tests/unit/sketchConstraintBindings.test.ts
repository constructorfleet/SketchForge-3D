import { describe, expect, it } from "vitest";
import {
  bindableSketchConstraint,
  deleteParameter,
  literalSketchProfile,
  profileSizeFields,
  projectParameterDependents,
  renameParameter,
  resolveSketchConstraintBinding,
  SKETCH_CONSTRAINT_BINDABLE_KINDS,
  sketchConstraintBindingIssues,
  withSketchConstraintValues,
  type ProjectParameter,
  type ProjectParameterResult,
} from "@constructorfleet/sketchforge-engine";
import type { SketchConstraint, SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

function ok<T>(result: ProjectParameterResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
}

const table: ProjectParameter[] = [
  { name: "w", expression: "3", dimension: "length", value: 3 },
  { name: "tilt", expression: "30 deg", dimension: "angle", value: 30 },
];

function profile(constraints: SketchConstraint[]): SketchProfile {
  return {
    points: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 2, z: 0 }, { id: "c", x: 2, z: 2 }],
    segments: [{ id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" }],
    constraints,
  };
}

function sketch(id: string, constraints: SketchConstraint[], extra: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id, kind: "mesh", name: id, color: "#ffffff", x: 0, z: 0, size: 2, width: 2, depth: 2, height: 1, rotation: 0,
    sketchOperation: "extrude", sketchSourceId: `sketch/${id}`, sketchProfile: profile(constraints), ...extra,
  } as WorkplaneShape;
}

const distance = (expression?: string, valueMm = 2): SketchConstraint => ({
  id: "d1", kind: "distance", pointIds: ["a", "b"], valueMm, ...(expression ? { expression } : {}),
});

describe("sketch constraint bindings", () => {
  it("lists the dimensional kinds with the value field and dimension each binds", () => {
    expect(SKETCH_CONSTRAINT_BINDABLE_KINDS).toEqual([
      { kind: "distance", valueField: "valueMm", dimension: "length" },
      { kind: "radius", valueField: "valueMm", dimension: "length" },
      { kind: "diameter", valueField: "valueMm", dimension: "length" },
      { kind: "angle", valueField: "valueDeg", dimension: "angle" },
    ]);
    expect(bindableSketchConstraint(distance())?.valueField).toBe("valueMm");
    expect(bindableSketchConstraint({ id: "h", kind: "horizontal", segmentId: "ab" })).toBeUndefined();
    expect(bindableSketchConstraint({ id: "f", kind: "fixed", pointId: "a", xMm: 0, zMm: 0 })).toBeUndefined();
  });

  it("resolves an expression in the constraint's unit and refuses values the constraint cannot hold", () => {
    expect(resolveSketchConstraintBinding("s", distance(), "w * 2", table)).toEqual({ ok: true, value: 6 });
    expect(resolveSketchConstraintBinding("s", distance(), "1cm", table)).toEqual({ ok: true, value: 10 });
    const angle: SketchConstraint = { id: "a1", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 90 };
    expect(resolveSketchConstraintBinding("s", angle, "tilt + 15", table)).toEqual({ ok: true, value: 45 });

    const wrongUnit = resolveSketchConstraintBinding("s", distance(), "tilt", table);
    expect(wrongUnit).toMatchObject({ ok: false, error: { code: "invalidExpression", shapeId: "s", constraintId: "d1" } });
    expect(resolveSketchConstraintBinding("s", distance(), "-w", table))
      .toMatchObject({ ok: false, error: { code: "outOfRange", constraintId: "d1" } });
    expect(resolveSketchConstraintBinding("s", { id: "r", kind: "radius", pointIds: ["a", "b"], valueMm: 1 }, "w - 3", table))
      .toMatchObject({ ok: false, error: { code: "outOfRange" } });
    expect(resolveSketchConstraintBinding("s", angle, "tilt * 7", table))
      .toMatchObject({ ok: false, error: { code: "outOfRange" } });
    expect(resolveSketchConstraintBinding("s", { id: "h", kind: "horizontal", segmentId: "ab" }, "w", table))
      .toMatchObject({ ok: false, error: { code: "constraintNotBindable", constraintId: "h" } });
  });

  it("reports stale constraint bindings without changing their stored values", () => {
    const shapes = [sketch("s1", [distance("missing * 2")]), { ...sketch("group", []), groupedShapes: [sketch("s2", [distance("tilt")])] }];
    const issues = sketchConstraintBindingIssues(shapes, table);
    expect(issues.map((issue) => [issue.shapeId, issue.constraintId, issue.code])).toEqual([
      ["s1", "d1", "invalidExpression"],
      ["s2", "d1", "invalidExpression"],
    ]);
    expect(shapes[0]!.sketchProfile!.constraints![0]).toMatchObject({ valueMm: 2, expression: "missing * 2" });

    const plain = sketch("plain", [distance("w")], { sketchOperation: undefined });
    const nested = { ...sketch("group", []), groupedShapes: [sketch("orphan", [distance("w")], { sketchSourceId: undefined })] };
    expect(sketchConstraintBindingIssues([plain, nested], table).map((issue) => [issue.shapeId, issue.code])).toEqual([
      ["plain", "sketchNotRebuildable"],
      ["orphan", "sketchNotRebuildable"],
    ]);
  });

  it("counts constraint references as dependents, refuses to delete them, and renames them everywhere", () => {
    const nested = sketch("nested", [distance("w")]);
    const before = sketch("treated", [distance("w * 1")]);
    const project = {
      parameters: table,
      shapes: [
        { ...sketch("group", []), groupedShapes: [nested] },
        { ...sketch("treated", [distance("w * 1")]), edgeTreatmentHistory: [{ before, feature: { kind: "fillet", amount: 1, edgeCount: 1 } }] },
      ] as WorkplaneShape[],
    };

    expect(projectParameterDependents(project, "w").sketchConstraints).toEqual([
      { shapeId: "nested", constraintIds: ["d1"] },
      { shapeId: "treated", constraintIds: ["d1"] },
    ]);
    const refused = deleteParameter(project, "w");
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "parameterInUse", sketchConstraintDependents: [{ shapeId: "nested" }, { shapeId: "treated" }] },
    });

    const renamed = ok(renameParameter(project, "w", "width"));
    const constraintOf = (shape: WorkplaneShape) => shape.sketchProfile!.constraints![0]!;
    expect(constraintOf(renamed.shapes[0]!.groupedShapes![0]!)).toMatchObject({ expression: "width" });
    expect(constraintOf(renamed.shapes[1]!)).toMatchObject({ expression: "width * 1" });
    expect(constraintOf(renamed.shapes[1]!.edgeTreatmentHistory![0]!.before)).toMatchObject({ expression: "width * 1" });
  });

  it("counts and reports bindings kept only in a treatment snapshot, once per shape, and a shelled sketch as stale", () => {
    const before = sketch("treated", [distance("w * 3")]);
    const treated = { ...sketch("treated", [distance("gone")]), edgeTreatmentHistory: [{ before, feature: { kind: "fillet", amount: 1, edgeCount: 1 } }] } as WorkplaneShape;
    const echoed = { ...sketch("echo", [distance("w")]), edgeTreatmentHistory: [{ before: sketch("echo", [distance("w")]), feature: { kind: "fillet", amount: 1, edgeCount: 1 } }] } as WorkplaneShape;

    const both = { parameters: table, shapes: [treated, echoed] };
    const treatedOnly = { parameters: table, shapes: [treated] };
    expect(projectParameterDependents(both, "w").sketchConstraints).toEqual([
      { shapeId: "treated", constraintIds: ["d1"] },
      { shapeId: "echo", constraintIds: ["d1"] },
    ]);
    expect(deleteParameter(treatedOnly, "w")).toMatchObject({ ok: false, error: { code: "parameterInUse" } });
    expect(sketchConstraintBindingIssues([treated, echoed], table).map((issue) => [issue.shapeId, issue.code])).toEqual([
      ["treated", "invalidExpression"],
    ]);
    const shelled = sketch("shelled", [distance("w")], { shell: { thickness: 0.2 } });
    expect(sketchConstraintBindingIssues([shelled], table)).toEqual([expect.objectContaining({ shapeId: "shelled", code: "sketchNotRebuildable" })]);
  });

  it("keeps a binding only when an incoming profile repeats it with the same value", () => {
    const existing = profile([distance("w", 3), { id: "a1", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 30, expression: "tilt" }]);

    const echoed = literalSketchProfile(existing, existing);
    expect(echoed.constraints).toEqual(existing.constraints);

    const edited = literalSketchProfile(existing, profile([distance("w", 5), { id: "a1", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 30, expression: "tilt" }]));
    expect(edited.constraints![0]).toEqual(distance(undefined, 5));
    expect(edited.constraints![1]).toMatchObject({ expression: "tilt" });

    const smuggled = literalSketchProfile(existing, profile([distance("w * 9", 3)]));
    expect(smuggled.constraints![0]).toEqual(distance(undefined, 3));

    const turned = literalSketchProfile(existing, profile([distance("w", 3), { id: "a1", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 60, expression: "tilt" }]));
    expect(turned.constraints![1]).toEqual({ id: "a1", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 60 });
  });

  it("writes an angle's value to valueDeg and a length's to valueMm", () => {
    const set = withSketchConstraintValues(
      profile([distance("w", 2), { id: "a1", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 30, expression: "tilt" }]),
      { d1: 7, a1: 60 },
    );
    expect(set.constraints).toEqual([
      distance("w", 7),
      { id: "a1", kind: "angle", segmentIds: ["ab", "bc"], valueDeg: 60, expression: "tilt" },
    ]);
  });
});

describe("size bindings that rescale a bound sketch", () => {
  it("names the profile size fields per operation and reports a stored conflict once per constraint", () => {
    expect(profileSizeFields(sketch("e", []))).toEqual(["width", "depth"]);
    expect(profileSizeFields(sketch("r", [], { sketchOperation: "revolve" }))).toEqual(["width", "depth", "height"]);
    expect(profileSizeFields(sketch("s", [], { sketchOperation: "sweep" }))).toEqual(["width", "depth", "height"]);
    expect(profileSizeFields({ ...sketch("box", []), sketchProfile: undefined })).toEqual([]);

    const tall = sketch("tall", [distance("w")], { expressions: { height: "w", x: "w" } });
    expect(sketchConstraintBindingIssues([tall], table)).toEqual([]);
    const wide = sketch("wide", [distance("w")], { expressions: { width: "w" } });
    expect(sketchConstraintBindingIssues([wide], table)).toEqual([
      expect.objectContaining({ shapeId: "wide", constraintId: "d1", code: "conflictingBinding", fields: ["width"] }),
    ]);
    // The stored values stay as they are; the field still drives the size.
    expect(wide.sketchProfile!.constraints![0]).toMatchObject({ valueMm: 2, expression: "w" });
  });
});
