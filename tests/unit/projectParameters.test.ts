import { describe, expect, it } from "vitest";
import {
  addParameter,
  deleteParameter,
  parameterDependents,
  PROJECT_PARAMETER_LIMIT,
  renameParameter,
  resolveProjectParameters,
  updateParameter,
  type ProjectParameter,
  type ProjectParameterError,
  type ProjectParameterResult,
} from "@constructorfleet/sketchforge-engine";
import { SKF_LIMITS } from "@constructorfleet/sketchforge-engine/skfProject";

type Project = { parameters: ProjectParameter[]; shapes: string[] };

function project(parameters: ProjectParameter[] = []): Project {
  return { parameters, shapes: ["kept"] };
}

function ok<T>(result: ProjectParameterResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.project;
}

function failed<T>(result: ProjectParameterResult<T>): ProjectParameterError {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

function table(...entries: Array<[string, string, ProjectParameter["dimension"]]>): Project {
  let current = project();
  for (const [name, expression, dimension] of entries) current = ok(addParameter(current, { name, expression, dimension }));
  return current;
}

function values(current: Project) {
  return Object.fromEntries(current.parameters.map((parameter) => [parameter.name, parameter.value]));
}

describe("project parameter table", () => {
  it("adds parameters and caches values in mm, degrees, or plain numbers", () => {
    const current = table(
      ["wall", "3", "length"],
      ["lip", "1in", "length"],
      ["tilt", "0.5 rad", "angle"],
      ["count", "4", "unitless"],
      ["depth", "wall * count + lip", "length"],
    );

    expect(current.parameters.map((parameter) => parameter.name)).toEqual(["wall", "lip", "tilt", "count", "depth"]);
    expect(values(current)).toEqual({ wall: 3, lip: 25.4, tilt: (0.5 * 180) / Math.PI, count: 4, depth: 3 * 4 + 25.4 });
    expect(current.parameters[0]).toEqual({ name: "wall", expression: "3", dimension: "length", value: 3 });
    expect(current.shapes).toEqual(["kept"]);
  });

  it("does not change the input project", () => {
    const before = table(["wall", "3", "length"]);
    const snapshot = structuredClone(before);

    ok(addParameter(before, { name: "depth", expression: "wall * 2", dimension: "length" }));
    ok(updateParameter(before, "wall", { expression: "5" }));
    ok(renameParameter(before, "wall", "shell"));
    ok(deleteParameter(before, "wall"));

    expect(before).toEqual(snapshot);
  });

  it("rejects invalid, reserved, and duplicate names", () => {
    const current = table(["wall", "3", "length"]);

    expect(failed(addParameter(current, { name: "2wall", expression: "1", dimension: "length" }))).toMatchObject({ code: "invalidName", parameter: "2wall" });
    expect(failed(addParameter(current, { name: "mm", expression: "1", dimension: "length" })).code).toBe("invalidName");
    expect(failed(addParameter(current, { name: "sin", expression: "1", dimension: "length" })).code).toBe("invalidName");
    expect(failed(addParameter(current, { name: "wall", expression: "1", dimension: "length" }))).toMatchObject({ code: "duplicateName", parameter: "wall" });
  });

  it("rejects an unknown dimension and a non-string expression", () => {
    const current = table(["wall", "3", "length"]);

    expect(failed(addParameter(current, { name: "area", expression: "1", dimension: "area" as never })).code).toBe("invalidDimension");
    expect(failed(updateParameter(current, "wall", { dimension: "volume" as never })).code).toBe("invalidDimension");
    expect(failed(addParameter(current, { name: "lip", expression: 3 as never, dimension: "length" })).code).toBe("invalidExpression");
  });

  it("rejects an invalid expression with the evaluator error", () => {
    const current = table(["wall", "3", "length"]);

    const unknown = failed(addParameter(current, { name: "depth", expression: "wal * 2", dimension: "length" }));
    expect(unknown).toMatchObject({ code: "invalidExpression", parameter: "depth", expressionError: { code: "unknownName" } });

    const mismatch = failed(addParameter(current, { name: "tilt", expression: "wall", dimension: "angle" }));
    expect(mismatch).toMatchObject({ code: "invalidExpression", parameter: "tilt", expressionError: { code: "dimensionMismatch" } });
  });

  it("recomputes every dependent when an expression changes", () => {
    const current = table(["wall", "3", "length"], ["depth", "wall * 2", "length"], ["outer", "depth + wall", "length"]);

    const updated = ok(updateParameter(current, "wall", { expression: "5 mm" }));

    expect(values(updated)).toEqual({ wall: 5, depth: 10, outer: 15 });
    expect(updated.parameters[0]!.expression).toBe("5 mm");
  });

  it("re-reads a bare number when the dimension changes", () => {
    const current = table(["spin", "30", "unitless"]);

    const updated = ok(updateParameter(current, "spin", { dimension: "angle" }));

    expect(updated.parameters[0]).toEqual({ name: "spin", expression: "30", dimension: "angle", value: 30 });
  });

  it("rejects a cycle and leaves the table unchanged", () => {
    const current = table(["a", "1", "length"], ["b", "a * 2", "length"], ["c", "b + 1", "length"]);

    const error = failed(updateParameter(current, "a", { expression: "c - 1" }));

    expect(error.code).toBe("invalidExpression");
    expect(error.parameter).toBe("a");
    expect(error.expressionError?.code).toBe("cycle");
    expect(error.expressionError?.cycle).toEqual(["a", "c", "b", "a"]);
    expect(values(current)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("rejects a self reference", () => {
    const current = table(["a", "1", "length"]);

    expect(failed(updateParameter(current, "a", { expression: "a + 1" })).expressionError?.code).toBe("cycle");
  });

  it("names the dependent that a change breaks", () => {
    const current = table(["wall", "3", "length"], ["depth", "wall * 2", "length"]);

    const error = failed(updateParameter(current, "wall", { dimension: "angle" }));

    expect(error).toMatchObject({ code: "invalidExpression", parameter: "depth", expressionError: { code: "dimensionMismatch" } });
  });

  it("reports the root failure rather than an earlier dependent of it", () => {
    const resolved = resolveProjectParameters([
      { name: "depth", expression: "wall * 2", dimension: "length" },
      { name: "wall", expression: "wal", dimension: "length" },
    ]);

    expect(resolved).toMatchObject({ ok: false, error: { code: "invalidExpression", parameter: "wall", expressionError: { code: "unknownName" } } });
  });

  it("reports an unknown parameter", () => {
    const current = table(["wall", "3", "length"]);

    expect(failed(updateParameter(current, "missing", { expression: "1" }))).toMatchObject({ code: "unknownParameter", parameter: "missing" });
    expect(failed(renameParameter(current, "missing", "other")).code).toBe("unknownParameter");
    expect(failed(deleteParameter(current, "missing")).code).toBe("unknownParameter");
  });

  it("renames a parameter in every expression that references it", () => {
    const current = table(
      ["wall", "3", "length"],
      ["wall2", "7", "length"],
      ["depth", "wall * 2 + wall2", "length"],
      ["outer", "max(wall, depth) + 1 mm", "length"],
    );

    const renamed = ok(renameParameter(current, "wall", "shell"));

    expect(renamed.parameters.map((parameter) => [parameter.name, parameter.expression])).toEqual([
      ["shell", "3"],
      ["wall2", "7"],
      ["depth", "shell * 2 + wall2"],
      ["outer", "max(shell, depth) + 1 mm"],
    ]);
    expect(values(renamed)).toEqual({ shell: 3, wall2: 7, depth: 13, outer: 14 });
    expect(renamed.shapes).toEqual(["kept"]);
  });

  it("rejects renaming onto another parameter or an invalid name", () => {
    const current = table(["wall", "3", "length"], ["depth", "wall * 2", "length"]);

    expect(failed(renameParameter(current, "wall", "depth"))).toMatchObject({ code: "duplicateName", parameter: "depth" });
    expect(failed(renameParameter(current, "wall", "deg")).code).toBe("invalidName");
    expect(ok(renameParameter(current, "wall", "wall"))).toEqual(current);
  });

  it("refuses to delete a referenced parameter and lists its direct dependents", () => {
    const current = table(["wall", "3", "length"], ["depth", "wall * 2", "length"], ["outer", "depth + 1", "length"], ["lip", "wall", "length"]);

    expect(failed(deleteParameter(current, "wall"))).toMatchObject({ code: "parameterInUse", parameter: "wall", dependents: ["depth", "lip"] });
    expect(parameterDependents(current.parameters, "wall")).toEqual(["depth", "lip"]);
    expect(parameterDependents(current.parameters, "outer")).toEqual([]);

    const deleted = ok(deleteParameter(current, "outer"));
    expect(deleted.parameters.map((parameter) => parameter.name)).toEqual(["wall", "depth", "lip"]);
  });

  it("recomputes cached values instead of trusting them", () => {
    const resolved = resolveProjectParameters([
      { name: "wall", expression: "2", dimension: "length", value: 999 },
      { name: "depth", expression: "wall * 3", dimension: "length", value: -1 },
    ] as ProjectParameter[]);

    expect(resolved).toEqual({
      ok: true,
      parameters: [
        { name: "wall", expression: "2", dimension: "length", value: 2 },
        { name: "depth", expression: "wall * 3", dimension: "length", value: 6 },
      ],
    });
  });

  it("caps the table size, and resolves a full-length dependency chain", () => {
    expect(SKF_LIMITS.parameters).toBe(PROJECT_PARAMETER_LIMIT);
    const chain = Array.from({ length: PROJECT_PARAMETER_LIMIT }, (_, index) => ({
      name: `p${index}`,
      expression: index === 0 ? "1" : `p${index - 1} + 1`,
      dimension: "length" as const,
    }));

    const resolved = resolveProjectParameters(chain);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.parameters.at(-1)!.value).toBe(PROJECT_PARAMETER_LIMIT);

    const full = { parameters: resolved.parameters };
    expect(failed(addParameter(full, { name: "extra", expression: "1", dimension: "length" })).code).toBe("tooManyParameters");
  });
});
