import { describe, expect, it } from "vitest";
import { apiEngineError } from "@/lib/apiEngine";

describe("API geometry failure mapping", () => {
  it("reports an unexpected boolean-kernel failure as a geometry error", async () => {
    const response = apiEngineError({ reason: "geometry_failed", message: "The CAD kernel could not complete that cut.", status: 500 });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "geometry_failed", error: "The CAD kernel could not complete that cut." });
  });

  it("preserves a request validation status carried by a geometry failure", async () => {
    const response = apiEngineError({ reason: "geometry_failed", message: "At least two shapes are needed to group.", status: 400 });

    expect(response.status).toBe(400);
  });
});

describe("API sketch constraint binding failure mapping", () => {
  it("maps constraint binding refusals to the field-binding codes, naming a batch shape by index", async () => {
    const unbindable = apiEngineError({
      reason: "constraint_binding_invalid",
      error: { code: "constraintNotBindable", shapeId: "s1", constraintId: "h", message: "A horizontal constraint has no value to bind." },
    });
    expect(unbindable.status).toBe(422);
    expect(await unbindable.json()).toMatchObject({ code: "unapplicable_fields", shapeId: "s1", constraintId: "h", reason: "constraintNotBindable" });

    const batch = apiEngineError({
      reason: "constraint_binding_invalid",
      index: 2,
      error: {
        code: "invalidExpression", shapeId: "never-stored", constraintId: "width", message: "width: unknown name",
        expressionError: { code: "unknownName", message: "unknown name", span: { start: 0, end: 4 } },
      },
    });
    const body = await batch.json();
    expect(body).toMatchObject({ code: "invalid_expression", index: 2, constraintId: "width", reason: "invalidExpression", error: "Shape 2: width: unknown name" });
    expect(body).not.toHaveProperty("shapeId");
    expect(body.expressionError).toMatchObject({ code: "unknownName" });
  });

  it("maps a size binding that conflicts with constraint bindings, from either side, naming both", async () => {
    const field = apiEngineError({
      reason: "binding_invalid",
      error: { code: "conflictingBinding", shapeId: "s1", field: "width", constraintIds: ["w1", "w2"], message: "width cannot bind." },
    });
    expect(field.status).toBe(422);
    expect(await field.json()).toMatchObject({
      code: "unapplicable_fields", shapeId: "s1", field: "width", fields: ["width"], constraintIds: ["w1", "w2"], reason: "conflictingBinding",
    });

    const constraint = apiEngineError({
      reason: "constraint_binding_invalid",
      error: { code: "conflictingBinding", shapeId: "s1", constraintId: "w1", fields: ["width", "depth"], message: "w1 cannot bind." },
    });
    expect(constraint.status).toBe(422);
    expect(await constraint.json()).toMatchObject({
      code: "unapplicable_fields", shapeId: "s1", constraintId: "w1", fields: ["width", "depth"], reason: "conflictingBinding",
    });
  });

  it("maps an unsolvable sketch and a wrapped rebuild failure with their constraint IDs", async () => {
    const unsolvable = apiEngineError({ reason: "sketch_unsolvable", shapeId: "s1", constraintIds: ["diagonal"], message: "The sketch on s1 cannot satisfy diagonal." });
    expect(unsolvable.status).toBe(422);
    expect(await unsolvable.json()).toMatchObject({ code: "geometry_failed", shapeId: "s1", constraintIds: ["diagonal"] });

    const locked = apiEngineError({
      reason: "binding_failed", shapeId: "s1", fields: [], constraintIds: ["width"], failure: { reason: "shape_locked", ids: ["group"] },
    });
    expect(await locked.json()).toMatchObject({ code: "shape_locked", shapeId: "s1", fields: [], constraintIds: ["width"] });
  });

  it("lists sketch constraint dependents when a parameter is still in use", async () => {
    const response = apiEngineError({
      reason: "parameter_invalid",
      error: {
        code: "parameterInUse", parameter: "w", message: "Parameter \"w\" is used by sketch s1 constraint width.",
        dependents: [], shapeDependents: [], sketchConstraintDependents: [{ shapeId: "s1", constraintIds: ["width"] }],
      },
    });
    expect(await response.json()).toMatchObject({ reason: "parameterInUse", sketchConstraintDependents: [{ shapeId: "s1", constraintIds: ["width"] }] });
  });
});
