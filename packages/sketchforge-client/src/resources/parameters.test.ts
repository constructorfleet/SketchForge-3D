import { describe, expect, expectTypeOf, it } from "vitest";
import { SketchForgeClient } from "../client.js";
import { SketchForgeApiError } from "../errors.js";
import { fakeServer, type FakeServer } from "../testing.js";
import {
  PARAMETER_DIMENSIONS,
  type ParameterDimension,
  type ParameterWriteResult,
  type ProjectParameter,
  type ShapePatch,
  type ShapeRequest,
  type ShapeSummary,
} from "../types.js";

function client(server: FakeServer) {
  return new SketchForgeClient({ baseUrl: "http://localhost:3100", token: "t", fetch: server.fetch });
}

const wall = { name: "wall", expression: "2 mm", dimension: "length", value: 2 };
const boundBox = {
  id: "s1", name: "Box", kind: "box", color: "#fff", hole: false, locked: false, hidden: false,
  x: 0, z: 0, elevation: 0, width: 10, depth: 10, height: 10, rotation: 0, rotationX: 0, rotationZ: 0,
  expressions: { width: "wall * 5" },
};
const written = { parameter: wall, parameters: [wall], shapes: [boundBox], revision: 4 };

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SketchForgeApiError) return error;
    throw error;
  }
  throw new Error("Expected the request to be refused.");
}

describe("parameters", () => {
  it("lists the table with its binding issues and revision", async () => {
    const stale = { ...wall, name: "gap", expression: "missing + 1", value: null, error: { code: "invalidExpression", message: "Unknown name missing.", expressionError: { code: "unknownName", message: "Unknown name missing.", span: { start: 0, end: 7 } } } };
    const issue = { shapeId: "s1", field: "width", code: "invalidExpression", message: "Unknown name gap." };
    const server = fakeServer({ body: { parameters: [wall, stale], bindingIssues: [issue], revision: 3 } });

    const listed = await client(server).parameters.list("p1");

    expect(server.calls[0]).toMatchObject({ method: "GET", url: "http://localhost:3100/api/v1/parameters?projectId=p1", body: undefined });
    expect(listed.parameters.map(({ name, value }) => [name, value])).toEqual([["wall", 2], ["gap", null]]);
    expect(listed.parameters[1]?.error?.expressionError?.span).toEqual({ start: 0, end: 7 });
    expect(listed.bindingIssues).toEqual([issue]);
    expect(listed.revision).toBe(3);
  });

  it("creates a parameter with its name, expression and dimension in the body", async () => {
    const server = fakeServer({ status: 201, body: written });

    const result = await client(server).parameters.create("p1", { name: "wall", expression: "2 mm", dimension: "length" });

    expect(server.calls[0]).toMatchObject({ method: "POST", url: "http://localhost:3100/api/v1/parameters?projectId=p1", body: { name: "wall", expression: "2 mm", dimension: "length" } });
    expect(result.parameter).toEqual(wall);
    expect(result.shapes[0]?.expressions).toEqual({ width: "wall * 5" });
    expect(result.revision).toBe(4);
  });

  it("changes a parameter by name in the query, sending only what changes", async () => {
    const server = fakeServer({ body: written });

    await client(server).parameters.update("p1", "wall", { expression: "3 mm" });

    expect(server.calls[0]).toMatchObject({ method: "PATCH", url: "http://localhost:3100/api/v1/parameters?projectId=p1&name=wall", body: { expression: "3 mm" } });
  });

  it("refuses an empty change before it reaches the server", async () => {
    const server = fakeServer({ body: written });
    await expect(client(server).parameters.update("p1", "wall", {})).rejects.toThrow(/expression or a dimension/);
    expect(server.calls).toHaveLength(0);
  });

  it("renames with the new name alone in the body", async () => {
    const server = fakeServer({ body: { ...written, parameter: { ...wall, name: "shell" } } });

    const result = await client(server).parameters.rename("p1", "wall", "shell");

    expect(server.calls[0]).toMatchObject({ method: "PATCH", url: "http://localhost:3100/api/v1/parameters?projectId=p1&name=wall", body: { name: "shell" } });
    expect(result.parameter?.name).toBe("shell");
  });

  it("deletes a parameter by name and returns the rewritten table", async () => {
    const server = fakeServer({ body: { deleted: true, name: "wall", parameters: [], shapes: [], revision: 5 } });

    const result = await client(server).parameters.delete("p1", "wall");

    expect(server.calls[0]).toMatchObject({ method: "DELETE", url: "http://localhost:3100/api/v1/parameters?projectId=p1&name=wall", body: undefined });
    expect(result).toEqual({ deleted: true, name: "wall", parameters: [], shapes: [], revision: 5 });
  });

  it("escapes a parameter name rather than splicing it into the query", async () => {
    const server = fakeServer({ body: written });
    await client(server).parameters.update("p1", "a&b=c", { dimension: "angle" });
    expect(new URL(server.calls[0]!.url).searchParams.get("name")).toBe("a&b=c");
  });

  it("binds the project id through a handle", async () => {
    const server = fakeServer(
      { body: { parameters: [wall], bindingIssues: [], revision: 3 } },
      { status: 201, body: written },
      { body: written },
      { body: written },
      { body: { deleted: true, name: "shell", parameters: [], shapes: [], revision: 7 } },
      { body: { shape: boundBox, revision: 8 } },
    );
    const project = client(server).project("p1");

    await project.parameters();
    await project.addParameter({ name: "wall", expression: "2 mm", dimension: "length" });
    await project.updateParameter("wall", { expression: "3 mm" });
    await project.renameParameter("wall", "shell");
    await project.deleteParameter("shell");
    await project.bindExpressions("s1", { width: "wall * 5", height: null });

    expect(server.calls.map(({ method, url }) => [method, new URL(url).search])).toEqual([
      ["GET", "?projectId=p1"],
      ["POST", "?projectId=p1"],
      ["PATCH", "?projectId=p1&name=wall"],
      ["PATCH", "?projectId=p1&name=wall"],
      ["DELETE", "?projectId=p1&name=shell"],
      ["PATCH", "?projectId=p1&shapeId=s1"],
    ]);
    expect(server.calls[5]?.body).toEqual({ expressions: { width: "wall * 5", height: null } });
  });

  it("names the dimensions the API contract does", () => {
    expect(PARAMETER_DIMENSIONS).toEqual(["length", "angle", "unitless"]);
  });
});

describe("shape expression types", () => {
  it("takes expressions on every request kind, and null only on a change", () => {
    const box: ShapeRequest = { kind: "box", depth: 10, expressions: { width: "wall * 5" } };
    const revolve: ShapeRequest = { kind: "revolve", profile: [[1, 0], [2, 0], [2, 1]], expressions: { "revolve.sweepAngle": "sweep" } };
    const thread: ShapeRequest = { kind: "thread", size: "M8", expressions: { length: "wall * 4" } };
    // @ts-expect-error A create has no binding to clear.
    const cleared: ShapeRequest = { kind: "box", expressions: { width: null } };
    const change: ShapePatch = { width: 3, expressions: { width: null, height: "wall" } };
    expect([box, revolve, thread, cleared, change]).toHaveLength(5);
  });

  it("reads a summary's expressions as text", () => {
    expectTypeOf<ShapeSummary["expressions"]>().toEqualTypeOf<Record<string, string> | undefined>();
  });

  it("names a dimension by the API's three values, and a write's parameter as optional", () => {
    expectTypeOf<ProjectParameter["dimension"]>().toEqualTypeOf<ParameterDimension>();
    expectTypeOf<ParameterWriteResult["parameter"]>().toEqualTypeOf<ProjectParameter | undefined>();
  });
});

describe("parameter validation", () => {
  it("refuses a dimension the server does not know, before sending anything", async () => {
    const server = fakeServer({ body: written });
    const api = client(server);
    const volume = "volume" as ParameterDimension;
    await expect(api.parameters.create("p1", { name: "wall", expression: "2", dimension: volume })).rejects.toThrow(/length, angle, unitless/);
    await expect(api.parameters.update("p1", "wall", { dimension: volume })).rejects.toThrow(/length, angle, unitless/);
    expect(server.calls).toHaveLength(0);
  });

  it("leaves the parameter out of a write result that has none", async () => {
    const server = fakeServer({ body: { parameters: [], shapes: [], revision: 2 } });
    const result = await client(server).parameters.update("p1", "wall", { expression: "3" });
    expect(result.parameter).toBeUndefined();
  });
});

describe("parameter errors", () => {
  it("reads an expression failure's evaluator detail", async () => {
    const expressionError = { code: "cycle", message: "Reference cycle: a → b → a.", span: { start: 0, end: 1 }, cycle: ["a", "b", "a"] };
    const server = fakeServer({ status: 422, body: { error: "Parameter \"a\": Reference cycle.", code: "invalid_expression", parameter: "a", reason: "invalidExpression", expressionError } });

    const error = await refusal(client(server).parameters.update("p1", "a", { expression: "b" }));

    expect(error.isInvalidExpression).toBe(true);
    expect(error.parameter).toBe("a");
    expect(error.reason).toBe("invalidExpression");
    expect(error.expressionError).toEqual(expressionError);
  });

  it("tells a missing parameter from a taken name", async () => {
    const missing = await refusal(client(fakeServer({ status: 404, body: { error: "No parameter.", code: "parameter_not_found", parameter: "x" } })).parameters.delete("p1", "x"));
    expect(missing.isParameterMissing).toBe(true);
    expect(missing.isParameterDuplicate).toBe(false);

    const taken = await refusal(client(fakeServer({ status: 409, body: { error: "Taken.", code: "parameter_exists", parameter: "wall" } })).parameters.create("p1", { name: "wall", expression: "1", dimension: "length" }));
    expect(taken.isParameterDuplicate).toBe(true);
    expect(taken.isParameterMissing).toBe(false);
    expect(taken.isProjectBusy).toBe(false);
  });

  it("lists what still uses a parameter a delete was refused for", async () => {
    const server = fakeServer({ status: 409, body: { error: "In use.", code: "parameter_in_use", parameter: "wall", dependents: ["gap"], shapeDependents: [{ shapeId: "s1", fields: ["width", "x"] }] } });

    const error = await refusal(client(server).parameters.delete("p1", "wall"));

    expect(error.isParameterInUse).toBe(true);
    expect(error.isProjectBusy).toBe(false);
    expect(error.dependents).toEqual(["gap"]);
    expect(error.shapeDependents).toEqual([{ shapeId: "s1", fields: ["width", "x"] }]);
    expect(error.sketchConstraintDependents).toEqual([]);
    expect(error.configurationDependents).toEqual([]);
  });

  it("names the sketch constraints and configurations a delete was refused for", async () => {
    const server = fakeServer({ status: 409, body: {
      error: "In use.", code: "parameter_in_use", parameter: "wall", dependents: [], shapeDependents: [],
      sketchConstraintDependents: [{ shapeId: "s2", constraintIds: ["c1", "c2"] }], configurationDependents: ["Large"],
    } });

    const error = await refusal(client(server).parameters.delete("p1", "wall"));

    expect(error.sketchConstraintDependents).toEqual([{ shapeId: "s2", constraintIds: ["c1", "c2"] }]);
    expect(error.configurationDependents).toEqual(["Large"]);
  });

  it("names the configuration whose table failed", async () => {
    const server = fakeServer({ status: 422, body: { error: "Bad.", code: "invalid_expression", parameter: "wall", configuration: "Large" } });
    const error = await refusal(client(server).parameters.update("p1", "wall", { expression: "x" }));
    expect(error.configuration).toBe("Large");
  });

  it("names the shape, field and batch index a binding refusal is about", async () => {
    const contradiction = await refusal(client(fakeServer({ status: 400, body: { error: "Disagree.", code: "invalid_request", shapeId: "s1", field: "width" } })).shapes.update("p1", "s1", { width: 3, expressions: { width: "wall" } }));
    expect(contradiction.shapeId).toBe("s1");
    expect(contradiction.field).toBe("width");
    expect(contradiction.index).toBeUndefined();

    const batch = await refusal(client(fakeServer({ status: 422, body: { error: "Bad.", code: "invalid_expression", index: 1, field: "width", reason: "outOfRange" } })).shapes.createMany("p1", [{ kind: "box" }, { kind: "box" }]));
    expect(batch.index).toBe(1);
    expect(batch.shapeId).toBeUndefined();

    const locked = await refusal(client(fakeServer({ status: 409, body: { error: "Locked.", code: "shape_locked", shapeId: "s1", fields: ["width"] } })).parameters.update("p1", "wall", { expression: "4" }));
    expect(locked.isShapeLocked).toBe(true);
    expect(locked.fields).toEqual(["width"]);
  });

  it("names the sketch constraints a binding conflicts with", async () => {
    const conflict = await refusal(client(fakeServer({ status: 422, body: { error: "Bound twice.", code: "unapplicable_fields", shapeId: "s1", field: "width", reason: "conflictingBinding", fields: ["width"], constraintIds: ["c1"] } })).shapes.update("p1", "s1", { expressions: { width: "wall" } }));
    expect(conflict.constraintIds).toEqual(["c1"]);
    expect(conflict.constraintId).toBeUndefined();

    const constraint = await refusal(client(fakeServer({ status: 422, body: { error: "Not bindable.", code: "unapplicable_fields", shapeId: "s1", constraintId: "c2", reason: "constraintNotBindable" } })).shapes.update("p1", "s1", {}));
    expect(constraint.constraintId).toBe("c2");
    expect(constraint.constraintIds).toEqual([]);
  });

  it("answers empty details when the body carries none", async () => {
    const error = await refusal(client(fakeServer({ status: 404, body: { error: "Gone.", code: "shape_not_found" } })).shapes.delete("p1", "s1"));
    expect(error.parameter).toBeUndefined();
    expect(error.reason).toBeUndefined();
    expect(error.expressionError).toBeUndefined();
    expect(error.dependents).toEqual([]);
    expect(error.shapeDependents).toEqual([]);
    expect(error.sketchConstraintDependents).toEqual([]);
    expect(error.configurationDependents).toEqual([]);
    expect(error.configuration).toBeUndefined();
    expect(error.fields).toEqual([]);
  });
});
