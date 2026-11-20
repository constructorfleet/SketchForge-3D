import { describe, expect, it } from "vitest";
import {
  DIMENSIONS,
  EXPRESSION_FUNCTIONS,
  EXPRESSION_UNITS,
  evaluateExpression,
  expressionDependencies,
  isValidParameterName,
  renameExpressionReference,
  resolveParameterTable,
  type Dimension,
  type ExpressionResult,
  type ExpressionScope,
} from "@constructorfleet/sketchforge-engine";

const scope: ExpressionScope = {
  wall: { value: 2, dimension: "length" },
  wall2: { value: 7, dimension: "length" },
  tilt: { value: 30, dimension: "angle" },
  count: { value: 4, dimension: "unitless" },
  zero: { value: 0, dimension: "length" },
};

function value(result: ExpressionResult): number {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errorOf(result: ExpressionResult) {
  if (result.ok) throw new Error(`expected an error, got ${result.value}`);
  return result.error;
}

describe("evaluateExpression arithmetic", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 - 4 - 3", 3],
    ["24 / 4 / 2", 3],
    ["-2 * 3", -6],
    ["2 * -3", -6],
    ["--4", 4],
    ["+5 - -1", 6],
    ["1.5e1 + .5", 15.5],
    ["  7  ", 7],
  ])("evaluates %s as %d", (source, expected) => {
    expect(value(evaluateExpression(source, {}, "unitless"))).toBeCloseTo(expected, 12);
  });
});

describe("evaluateExpression units", () => {
  it.each([
    ["10mm", 10],
    ["10 mm", 10],
    ["2cm", 20],
    ["1.5m", 1500],
    ["1in", 25.4],
    ["1ft", 304.8],
    ["10mm + 1in", 35.4],
    ["1ft - 12in", 0],
  ])("normalizes %s to %d mm", (source, mm) => {
    const result = evaluateExpression(source, {}, "length");
    expect(value(result)).toBeCloseTo(mm, 9);
    expect(result.ok && result.dimension).toEqual(DIMENSIONS.length);
  });

  it("normalizes angles to degrees", () => {
    expect(value(evaluateExpression("45deg", {}, "angle"))).toBeCloseTo(45, 12);
    expect(value(evaluateExpression("1rad", {}, "angle"))).toBeCloseTo(180 / Math.PI, 12);
    expect(value(evaluateExpression("90deg - 0.5rad", {}, "angle"))).toBeCloseTo(90 - 90 / Math.PI, 12);
  });

  it("lists the shipped units and functions", () => {
    expect([...EXPRESSION_UNITS]).toEqual(["mm", "cm", "m", "in", "ft", "deg", "rad"]);
    expect([...EXPRESSION_FUNCTIONS]).toEqual(["min", "max", "abs", "sqrt", "round", "floor", "ceil", "sin", "cos", "tan"]);
  });
});

describe("evaluateExpression dimensions", () => {
  it("keeps a scaled length a length", () => {
    const result = evaluateExpression("wall * 2", scope, "length");
    expect(value(result)).toBe(4);
    expect(result.ok && result.dimension).toEqual(DIMENSIONS.length);
  });

  it("makes length times length an area and rejects it in a length field", () => {
    const area = evaluateExpression("wall * wall", scope, "area");
    expect(value(area)).toBe(4);
    expect(area.ok && area.dimension).toEqual({ length: 2, angle: 0 });

    const error = errorOf(evaluateExpression("wall * wall", scope, "length"));
    expect(error.code).toBe("dimensionMismatch");
    expect(error.span).toEqual({ start: 0, end: 11 });
    expect(error.message).toBe("Expected length, got area.");
  });

  it("divides a length by a length to a unitless ratio", () => {
    const result = evaluateExpression("wall2 / wall", scope, "unitless");
    expect(value(result)).toBe(3.5);
  });

  it("derives inverse dimensions", () => {
    const result = evaluateExpression("1 / wall", scope, { length: -1, angle: 0 });
    expect(value(result)).toBe(0.5);
  });

  it("rejects adding a length and an angle at the operator", () => {
    const error = errorOf(evaluateExpression("wall + tilt", scope, "length"));
    expect(error.code).toBe("dimensionMismatch");
    expect(error.span).toEqual({ start: 0, end: 11 });
  });

  it("rejects mixed units inside a sub-expression", () => {
    const error = errorOf(evaluateExpression("1 + (2mm - 3deg)", {}, "length"));
    expect(error.code).toBe("dimensionMismatch");
    expect(error.span).toEqual({ start: 5, end: 15 });
  });

  it("rejects a length in an angle field", () => {
    expect(errorOf(evaluateExpression("5mm", {}, "angle")).code).toBe("dimensionMismatch");
  });

  it("accepts an exponent record as the expected dimension", () => {
    const volume: Dimension = { length: 3, angle: 0 };
    expect(value(evaluateExpression("wall * wall * wall", scope, volume))).toBe(8);
    expect(value(evaluateExpression("wall * wall * wall", scope, "volume"))).toBe(8);
  });
});

// Bare numbers carry no dimension until context fixes one.
describe("evaluateExpression bare numbers", () => {
  it("takes the field dimension when standalone", () => {
    const result = evaluateExpression("3", {}, "length");
    expect(value(result)).toBe(3);
    expect(result.ok && result.dimension).toEqual(DIMENSIONS.length);
    const angle = evaluateExpression("3", {}, "angle");
    expect(angle.ok && angle.dimension).toEqual(DIMENSIONS.angle);
  });

  it("takes the field dimension when only bare numbers combine", () => {
    const result = evaluateExpression("2 * 3", {}, "length");
    expect(value(result)).toBe(6);
    expect(result.ok && result.dimension).toEqual(DIMENSIONS.length);
    expect(value(evaluateExpression("(2 + 3) / 2", {}, "area"))).toBe(2.5);
  });

  it("takes the other operand's dimension under + and -", () => {
    expect(value(evaluateExpression("wall + 3", scope, "length"))).toBe(5);
    expect(value(evaluateExpression("3 - wall", scope, "length"))).toBe(1);
    expect(value(evaluateExpression("wall + 2 * 3", scope, "length"))).toBe(8);
    expect(value(evaluateExpression("1in + 1", {}, "length"))).toBeCloseTo(26.4, 12);
    expect(value(evaluateExpression("wall * wall + 1", scope, "area"))).toBe(5);
  });

  it("stays unitless under * and /", () => {
    expect(value(evaluateExpression("wall * 2", scope, "length"))).toBe(4);
    expect(value(evaluateExpression("2 * 3mm", {}, "length"))).toBe(6);
    expect(value(evaluateExpression("wall * (2 + 3)", scope, "length"))).toBe(10);
    expect(errorOf(evaluateExpression("wall * 3", scope, "area")).code).toBe("dimensionMismatch");
  });

  it("does not adopt a dimension from a fixed unitless value", () => {
    expect(errorOf(evaluateExpression("count", scope, "length")).code).toBe("dimensionMismatch");
    expect(errorOf(evaluateExpression("wall + count", scope, "length")).code).toBe("dimensionMismatch");
  });

  it("is unitless when no field dimension is given", () => {
    const result = evaluateExpression("2 * 3");
    expect(value(result)).toBe(6);
    expect(result.ok && result.dimension).toEqual(DIMENSIONS.unitless);
    const length = evaluateExpression("wall + 3", scope);
    expect(length.ok && length.dimension).toEqual(DIMENSIONS.length);
  });
});

describe("evaluateExpression functions", () => {
  it.each([
    ["min(wall, wall2)", "length", 2],
    ["max(wall, 5)", "length", 5],
    ["max(1, 4, 2)", "unitless", 4],
    ["abs(-wall)", "length", 2],
    ["sqrt(wall * 8mm)", "length", 4],
    ["sqrt(16)", "length", 4],
    ["round(2.5)", "unitless", 3],
    ["floor(1in)", "length", 25],
    ["ceil(wall / 3)", "length", 1],
    ["sin(tilt)", "unitless", 0.5],
    ["cos(60deg)", "unitless", 0.5],
    ["tan(45)", "unitless", 1],
    ["sin(0.5rad)", "unitless", Math.sin(0.5)],
    ["wall * cos(0)", "length", 2],
  ] as const)("evaluates %s", (source, dimension, expected) => {
    expect(value(evaluateExpression(source, scope, dimension))).toBeCloseTo(expected, 12);
  });

  it("passes a bare argument through abs, rounding, min, max and sqrt", () => {
    expect(value(evaluateExpression("wall + abs(-3)", scope, "length"))).toBe(5);
    expect(value(evaluateExpression("wall + round(2.6)", scope, "length"))).toBe(5);
    expect(value(evaluateExpression("wall + max(1, 3)", scope, "length"))).toBe(5);
    expect(value(evaluateExpression("wall * abs(-2)", scope, "length"))).toBe(4);
    expect(value(evaluateExpression("wall + sqrt(9)", scope, "length"))).toBe(5);
    const root = evaluateExpression("sqrt(16)", {}, "length");
    expect(value(root)).toBe(4);
    expect(root.ok && root.dimension).toEqual(DIMENSIONS.length);
  });

  it("gives trig results a fixed unitless dimension", () => {
    expect(errorOf(evaluateExpression("wall + cos(0)", scope, "length")).code).toBe("dimensionMismatch");
  });

  it("rejects trig of a length", () => {
    const error = errorOf(evaluateExpression("sin(wall)", scope, "unitless"));
    expect(error.code).toBe("dimensionMismatch");
    expect(error.span).toEqual({ start: 4, end: 8 });
  });

  it("rejects sqrt of an odd power", () => {
    expect(errorOf(evaluateExpression("sqrt(wall)", scope, "length")).code).toBe("dimensionMismatch");
  });

  it("rejects mixed dimensions in min and max", () => {
    expect(errorOf(evaluateExpression("min(wall, tilt)", scope, "length")).code).toBe("dimensionMismatch");
  });

  it("rejects the wrong argument count", () => {
    const error = errorOf(evaluateExpression("abs(1, 2)", {}, "unitless"));
    expect(error.code).toBe("argumentCount");
    expect(error.span).toEqual({ start: 0, end: 9 });
    expect(errorOf(evaluateExpression("min()", {}, "unitless")).code).toBe("argumentCount");
  });

  it("rejects an unknown function", () => {
    const error = errorOf(evaluateExpression("pow(2, 3)", {}, "unitless"));
    expect(error.code).toBe("unknownFunction");
    expect(error.span).toEqual({ start: 0, end: 3 });
  });
});

describe("evaluateExpression errors", () => {
  it("reports an unknown name with its span", () => {
    const error = errorOf(evaluateExpression("wall + depth", scope, "length"));
    expect(error.code).toBe("unknownName");
    expect(error.span).toEqual({ start: 7, end: 12 });
    expect(error.message).toContain("depth");
  });

  it("ignores inherited object keys in a record scope", () => {
    expect(errorOf(evaluateExpression("constructor", {}, "unitless")).code).toBe("unknownName");
  });

  it("reads a Map scope", () => {
    const mapScope = new Map([["wall", { value: 3, dimension: DIMENSIONS.length }]]);
    expect(value(evaluateExpression("wall + 1", mapScope, "length"))).toBe(4);
  });

  it("reports division by zero at the divisor", () => {
    const error = errorOf(evaluateExpression("wall / (1 - 1)", scope, "length"));
    expect(error.code).toBe("divisionByZero");
    expect(error.span).toEqual({ start: 7, end: 14 });
    expect(errorOf(evaluateExpression("wall / zero", scope, "unitless")).code).toBe("divisionByZero");
  });

  it("reports non-finite results", () => {
    expect(errorOf(evaluateExpression("1e999", {}, "unitless")).code).toBe("nonFinite");
    expect(errorOf(evaluateExpression("sqrt(-4)", {}, "unitless")).code).toBe("nonFinite");
    expect(errorOf(evaluateExpression("1e200 * 1e200", {}, "unitless")).code).toBe("nonFinite");
  });

  it("rejects a non-finite scope value", () => {
    const bad: ExpressionScope = { big: { value: Number.POSITIVE_INFINITY, dimension: "length" } };
    expect(errorOf(evaluateExpression("big", bad, "length")).code).toBe("nonFinite");
  });

  it.each([
    ["", 0, 0],
    ["   ", 3, 3],
    ["1 +", 3, 3],
    ["(1 + 2", 6, 6],
    ["1 + 2)", 5, 6],
    ["2 3", 2, 3],
    ["2 wall", 2, 6],
    ["1 # 2", 2, 3],
    ["* 2", 0, 1],
    ["mm", 0, 2],
    ["min", 0, 3],
    ["(wall)mm", 6, 8],
    ["3mm mm", 4, 6],
    ["min(1,)", 6, 7],
    ["1..2", 2, 4],
    ["wall+", 5, 5],
  ])("reports malformed %j as a parse error at %i..%i", (source, start, end) => {
    const error = errorOf(evaluateExpression(source, scope, "length"));
    expect(error.code).toBe("parseError");
    expect(error.span).toEqual({ start, end });
  });

  it("never throws on hostile input", () => {
    const inputs = ["(".repeat(5000) + "1" + ")".repeat(5000), "-".repeat(5000) + "1", "\u0000", "1e", "1e+", "\u{1F600}"];
    for (const input of inputs) {
      expect(() => evaluateExpression(input, scope, "unitless")).not.toThrow();
    }
  });

  it("limits nesting depth", () => {
    const deep = errorOf(evaluateExpression("(".repeat(200) + "1" + ")".repeat(200)));
    expect(deep).toMatchObject({ code: "limitExceeded", span: { start: 128, end: 129 } });
    expect(deep.message).toMatch(/nests too deeply/);
    expect(value(evaluateExpression("(".repeat(100) + "1" + ")".repeat(100)))).toBe(1);
    expect(errorOf(evaluateExpression("abs(".repeat(200) + "1" + ")".repeat(200))).code).toBe("limitExceeded");
  });

  it("limits expression length to 10,000 characters", () => {
    const sum = Array.from({ length: 200_000 }, () => "1").join("+");
    expect(errorOf(evaluateExpression(sum))).toMatchObject({ code: "limitExceeded", span: { start: 10_000, end: sum.length } });
    const signs = "-".repeat(1_000_000) + "1";
    expect(errorOf(evaluateExpression(signs)).code).toBe("limitExceeded");
  });

  it("evaluates long flat input at the length limit without deep recursion", () => {
    expect(value(evaluateExpression("1+".repeat(4999) + "1"))).toBe(5000);
    expect(value(evaluateExpression("1*".repeat(4999) + "1"))).toBe(1);
    expect(value(evaluateExpression("-".repeat(9999) + "1"))).toBe(-1);
    expect(value(evaluateExpression("-".repeat(9998) + "1"))).toBe(1);
  });

  it("rejects non-string expressions and non-object scopes", () => {
    expect(errorOf(evaluateExpression(42 as unknown as string))).toMatchObject({ code: "invalidArgument", span: { start: 0, end: 0 } });
    expect(errorOf(evaluateExpression(null as unknown as string)).code).toBe("invalidArgument");
    expect(errorOf(evaluateExpression("1", null as unknown as ExpressionScope)).code).toBe("invalidArgument");
    expect(errorOf(evaluateExpression("1", "wall" as unknown as ExpressionScope)).code).toBe("invalidArgument");
  });

  it("rejects unknown or malformed field dimensions", () => {
    for (const bad of ["Length", "lenght", "", { length: 1 }, { length: "1", angle: 0 }, { length: 0.5, angle: 0 }, { length: Number.NaN, angle: 0 }, null, 3]) {
      const error = errorOf(evaluateExpression("wall * wall", scope, bad as unknown as Dimension));
      expect(error).toMatchObject({ code: "invalidDimension", span: { start: 0, end: 0 } });
    }
  });

  it("rejects malformed scope entries at the reference", () => {
    const bad = {
      typo: { value: 1, dimension: "lenght" },
      record: { value: 1, dimension: { length: 1 } },
      text: { value: "1", dimension: "length" },
      missing: null,
    } as unknown as ExpressionScope;
    expect(errorOf(evaluateExpression("1 + typo", bad, "length"))).toMatchObject({ code: "invalidDimension", span: { start: 4, end: 8 } });
    expect(errorOf(evaluateExpression("record", bad, "length")).code).toBe("invalidDimension");
    expect(errorOf(evaluateExpression("text", bad, "length")).code).toBe("invalidArgument");
    expect(errorOf(evaluateExpression("missing", bad, "length")).code).toBe("invalidArgument");
  });

  it("returns positive zero", () => {
    expect(Object.is(value(evaluateExpression("-0")), 0)).toBe(true);
    expect(Object.is(value(evaluateExpression("0 * -1mm", {}, "length")), 0)).toBe(true);
  });
});

describe("expressionDependencies", () => {
  it("lists referenced names once, in first-use order", () => {
    expect(expressionDependencies("wall + depth * wall - min(depth, 3mm) + sin(tilt)")).toEqual(["wall", "depth", "tilt"]);
  });

  it("splits a word at a non-ASCII letter", () => {
    expect(expressionDependencies("wäll + 1")).toEqual(["w", "ll"]);
  });

  it("excludes units and functions", () => {
    expect(expressionDependencies("10 mm + 2in + max(1, 2) + 3 deg")).toEqual([]);
  });

  it("still reads names from a malformed expression", () => {
    expect(expressionDependencies("wall + (depth")).toEqual(["wall", "depth"]);
    expect(expressionDependencies("wall # depth")).toEqual(["wall", "depth"]);
    expect(expressionDependencies("pow(x, 2) + 2 wall")).toEqual(["x", "wall"]);
  });
});

describe("renameExpressionReference", () => {
  it("renames whole identifier tokens only", () => {
    expect(renameExpressionReference("wall + wall2*2 + min(wall,1mm)", "wall", "shell")).toBe(
      "shell + wall2*2 + min(shell,1mm)",
    );
  });

  it("preserves spacing, units and other names", () => {
    expect(renameExpressionReference("  wall*3 mm/ m + wall", "wall", "w")).toBe("  w*3 mm/ m + w");
    expect(renameExpressionReference("m + 2 m", "m", "metres")).toBe("m + 2 m");
  });

  it("rewrites a malformed expression around the bad text", () => {
    expect(renameExpressionReference("wall # wall", "wall", "w")).toBe("w # w");
    expect(renameExpressionReference("wall(1) + wall", "wall", "w")).toBe("wall(1) + w");
  });

  it("does not check whether the new name is already used", () => {
    expect(renameExpressionReference("a + b", "a", "b")).toBe("b + b");
  });

  it("refuses an invalid new name", () => {
    expect(() => renameExpressionReference("wall", "wall", "mm")).toThrow(RangeError);
    expect(() => renameExpressionReference("wall", "wall", "2x")).toThrow(RangeError);
  });

  it("keeps the evaluated value", () => {
    const renamed = renameExpressionReference("wall * 2 + wall2", "wall", "thick");
    const renamedScope: ExpressionScope = { thick: { value: 2, dimension: "length" }, wall2: { value: 7, dimension: "length" } };
    expect(value(evaluateExpression(renamed, renamedScope, "length"))).toBe(11);
  });
});

describe("isValidParameterName", () => {
  it.each(["wall", "_x", "Wall2", "outer_radius", "MM", "e"])("accepts %s", (name) => {
    expect(isValidParameterName(name)).toBe(true);
  });

  it.each(["", "2x", "a-b", "a b", "wall.x", "mm", "in", "deg", "rad", "min", "sin", "sqrt", "x".repeat(65)])(
    "rejects %j",
    (name) => {
      expect(isValidParameterName(name)).toBe(false);
    },
  );
});

describe("resolveParameterTable", () => {
  it("resolves in dependency order regardless of entry order", () => {
    const table = resolveParameterTable([
      { name: "outer", expression: "inner + 2 * wall", dimension: "length" },
      { name: "inner", expression: "20" , dimension: "length" },
      { name: "wall", expression: "0.1in" },
      { name: "ratio", expression: "outer / inner" },
    ]);
    expect(table.order).toEqual(["inner", "wall", "outer", "ratio"]);
    expect(table.results.map((result) => result.ok)).toEqual([true, true, true, true]);
    expect(table.scope.get("outer")?.value).toBeCloseTo(25.08, 12);
    expect(table.scope.get("wall")?.dimension).toEqual(DIMENSIONS.length);
    expect(table.scope.get("ratio")?.value).toBeCloseTo(1.254, 12);
    expect(table.scope.get("ratio")?.dimension).toEqual(DIMENSIONS.unitless);
  });

  it("reads a bare number as unitless when no dimension is declared", () => {
    const table = resolveParameterTable([{ name: "n", expression: "3" }]);
    expect(table.scope.get("n")?.dimension).toEqual(DIMENSIONS.unitless);
  });

  it("checks a declared dimension", () => {
    const table = resolveParameterTable([
      { name: "wall", expression: "2mm" },
      { name: "a", expression: "wall * wall", dimension: "length" },
    ]);
    expect(errorOf(table.results[1]!).code).toBe("dimensionMismatch");
    expect(table.scope.has("a")).toBe(false);
  });

  it("reports every member of a cycle with the same path from the first member", () => {
    const table = resolveParameterTable([
      { name: "a", expression: "b + 1mm" },
      { name: "b", expression: "2 * c" },
      { name: "c", expression: "x + a" },
      { name: "x", expression: "1mm" },
    ]);
    const [a, b, c, x] = table.results;
    expect(errorOf(a!)).toMatchObject({ code: "cycle", cycle: ["a", "b", "c", "a"], span: { start: 0, end: 1 } });
    expect(errorOf(b!)).toMatchObject({ code: "cycle", cycle: ["a", "b", "c", "a"], span: { start: 4, end: 5 } });
    expect(errorOf(c!)).toMatchObject({ code: "cycle", cycle: ["a", "b", "c", "a"], span: { start: 4, end: 5 } });
    expect(errorOf(a!).message).toContain("a → b → c → a");
    expect(value(x!)).toBe(1);
    expect(table.order).toEqual(["x"]);
  });

  it("reports a self reference as a cycle", () => {
    const table = resolveParameterTable([{ name: "a", expression: "a + 1" }]);
    expect(errorOf(table.results[0]!)).toMatchObject({ code: "cycle", cycle: ["a", "a"] });
  });

  it("fails dependents of a failed entry without calling them cycles", () => {
    const table = resolveParameterTable([
      { name: "a", expression: "b" },
      { name: "b", expression: "b * 2" },
      { name: "c", expression: "a + 1" },
      { name: "d", expression: "1 +" },
      { name: "e", expression: "d" },
    ]);
    expect(errorOf(table.results[0]!)).toMatchObject({ code: "dependencyFailed", span: { start: 0, end: 1 } });
    expect(errorOf(table.results[1]!).code).toBe("cycle");
    expect(errorOf(table.results[2]!).code).toBe("dependencyFailed");
    expect(errorOf(table.results[3]!).code).toBe("parseError");
    expect(errorOf(table.results[4]!).code).toBe("dependencyFailed");
  });

  it("reports names missing from the table as unknown", () => {
    const table = resolveParameterTable([{ name: "a", expression: "missing + 1" }]);
    expect(errorOf(table.results[0]!)).toMatchObject({ code: "unknownName", span: { start: 0, end: 7 } });
  });

  it("rejects invalid and duplicate names and fails their dependents", () => {
    const table = resolveParameterTable([
      { name: "mm", expression: "1" },
      { name: "w", expression: "1" },
      { name: "w", expression: "2" },
      { name: "z", expression: "w + 1" },
    ]);
    expect(errorOf(table.results[0]!).code).toBe("invalidName");
    expect(errorOf(table.results[1]!).code).toBe("duplicateName");
    expect(errorOf(table.results[2]!).code).toBe("duplicateName");
    expect(errorOf(table.results[3]!).code).toBe("dependencyFailed");
    expect(table.scope.size).toBe(0);
  });

  it("resolves a 10,000-entry chain without recursion", () => {
    const count = 10_000;
    const entries = Array.from({ length: count }, (_, index) => ({
      name: `p${index}`,
      expression: index === count - 1 ? "1mm" : `p${index + 1} + 1`,
    }));
    const table = resolveParameterTable(entries);
    expect(table.results.every((result) => result.ok)).toBe(true);
    expect(table.scope.get("p0")?.value).toBe(count);
    expect(table.order[0]).toBe(`p${count - 1}`);
  });

  it("reports a 10,000-entry cycle without recursion and shares one path", () => {
    const count = 10_000;
    const entries = Array.from({ length: count }, (_, index) => ({ name: `p${index}`, expression: `p${(index + 1) % count} + 1` }));
    const table = resolveParameterTable(entries);
    const first = errorOf(table.results[0]!);
    expect(first.code).toBe("cycle");
    expect(first.cycle).toHaveLength(count + 1);
    expect(first.cycle?.[1]).toBe("p1");
    expect(first.message.length).toBeLessThan(200);
    const last = errorOf(table.results[count - 1]!);
    expect(last).toMatchObject({ code: "cycle", span: { start: 0, end: 2 } });
    expect(last.cycle).toBe(first.cycle);
  });

  it("refuses a table over 10,000 entries", () => {
    const entries = Array.from({ length: 10_001 }, (_, index) => ({ name: `p${index}`, expression: "1" }));
    const table = resolveParameterTable(entries);
    expect(table.results).toHaveLength(10_001);
    expect(errorOf(table.results[0]!).code).toBe("limitExceeded");
    expect(table.scope.size).toBe(0);
  });

  it("rejects malformed entries and dimensions", () => {
    const table = resolveParameterTable([
      { name: "a", expression: "1", dimension: "Length" },
      { name: "b", expression: 5 },
      null,
      { name: "c", expression: "a + 1" },
    ] as unknown as Parameters<typeof resolveParameterTable>[0]);
    expect(errorOf(table.results[0]!).code).toBe("invalidDimension");
    expect(errorOf(table.results[1]!).code).toBe("invalidArgument");
    expect(errorOf(table.results[2]!).code).toBe("invalidArgument");
    expect(errorOf(table.results[3]!).code).toBe("dependencyFailed");
  });

  it("feeds its scope back into evaluateExpression", () => {
    const table = resolveParameterTable([{ name: "wall", expression: "3mm" }]);
    expect(value(evaluateExpression("wall + 1", table.scope, "length"))).toBe(4);
  });
});
