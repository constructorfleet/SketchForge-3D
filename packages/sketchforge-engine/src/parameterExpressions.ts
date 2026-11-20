/**
 * Evaluates unit-aware parameter expressions. Pure: no shapes, no project model, never throws
 * on user input.
 *
 * Values are in base units: mm for length, degrees for angle, products of these for derived
 * dimensions (mm² for area).
 *
 * Bare numbers have no dimension until context gives one:
 * - `+`, `-`, `min`, `max`: takes the other operand's dimension (`wall + 3` is wall + 3 mm).
 * - `*`, `/`: stays unitless (`wall * 2` is a length).
 * - trig argument: an angle in degrees (`sin(30)`).
 * - whole result: the field dimension (`3` and `2 * 3` in a length field are 3 mm and 6 mm),
 *   or unitless when no field dimension is given.
 * A value from a unit literal, a reference or a function result always has a fixed dimension.
 */

export type DimensionName = "unitless" | "length" | "area" | "volume" | "angle";

/** Exponents of the base dimensions. Area is `{ length: 2, angle: 0 }`. */
export type Dimension = { readonly length: number; readonly angle: number };

export const DIMENSIONS: Readonly<Record<DimensionName, Dimension>> = Object.freeze({
  unitless: Object.freeze({ length: 0, angle: 0 }),
  length: Object.freeze({ length: 1, angle: 0 }),
  area: Object.freeze({ length: 2, angle: 0 }),
  volume: Object.freeze({ length: 3, angle: 0 }),
  angle: Object.freeze({ length: 0, angle: 1 }),
});

/** A value in base units with its dimension. */
export type ExpressionQuantity = { readonly value: number; readonly dimension: Dimension | DimensionName };

export type ExpressionScope = ReadonlyMap<string, ExpressionQuantity> | Readonly<Record<string, ExpressionQuantity>>;

/** Half-open character range `[start, end)` in the expression source. */
export type ExpressionSpan = { readonly start: number; readonly end: number };

export type ExpressionErrorCode =
  | "parseError"
  | "unknownName"
  | "unknownFunction"
  | "argumentCount"
  | "dimensionMismatch"
  | "divisionByZero"
  | "nonFinite"
  | "cycle"
  | "dependencyFailed"
  | "invalidName"
  | "duplicateName";

export type ExpressionError = {
  readonly code: ExpressionErrorCode;
  readonly message: string;
  readonly span: ExpressionSpan;
  /** Set for `cycle`: the path from this parameter back to itself. */
  readonly cycle?: readonly string[];
};

export type ExpressionResult =
  | { readonly ok: true; readonly value: number; readonly dimension: Dimension }
  | { readonly ok: false; readonly error: ExpressionError };

const UNIT_SCALES = {
  mm: { scale: 1, dimension: DIMENSIONS.length },
  cm: { scale: 10, dimension: DIMENSIONS.length },
  m: { scale: 1000, dimension: DIMENSIONS.length },
  in: { scale: 25.4, dimension: DIMENSIONS.length },
  ft: { scale: 304.8, dimension: DIMENSIONS.length },
  deg: { scale: 1, dimension: DIMENSIONS.angle },
  rad: { scale: 180 / Math.PI, dimension: DIMENSIONS.angle },
} as const satisfies Record<string, { scale: number; dimension: Dimension }>;

type UnitName = keyof typeof UNIT_SCALES;

export const EXPRESSION_UNITS: readonly UnitName[] = Object.freeze(["mm", "cm", "m", "in", "ft", "deg", "rad"]);

/** Rounding functions work on base-unit values: `floor(1in)` is 25 mm. */
export const EXPRESSION_FUNCTIONS = Object.freeze([
  "min",
  "max",
  "abs",
  "sqrt",
  "round",
  "floor",
  "ceil",
  "sin",
  "cos",
  "tan",
] as const);

type FunctionName = (typeof EXPRESSION_FUNCTIONS)[number];

const MAX_NAME_LENGTH = 64;
// Bounds recursion so deep nesting is a parse error, not a stack overflow.
const MAX_NESTING = 128;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set<string>([...EXPRESSION_UNITS, ...EXPRESSION_FUNCTIONS]);

/** Accepts identifiers of up to 64 characters that are not unit or function names. */
export function isValidParameterName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name) && !RESERVED.has(name);
}

function isUnit(name: string): name is UnitName {
  return Object.hasOwn(UNIT_SCALES, name);
}

function isFunction(name: string): name is FunctionName {
  return (EXPRESSION_FUNCTIONS as readonly string[]).includes(name);
}

// --- tokens -----------------------------------------------------------------

type Token =
  | { kind: "number"; text: string; start: number; end: number }
  | { kind: "name"; text: string; start: number; end: number }
  | { kind: "symbol"; text: "+" | "-" | "*" | "/" | "(" | ")" | ","; start: number; end: number }
  | { kind: "invalid"; text: string; start: number; end: number }
  | { kind: "end"; text: ""; start: number; end: number };

const NUMBER_AT = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_AT = /[A-Za-z_][A-Za-z0-9_]*/y;

// Unknown characters become `invalid` tokens so names after them stay visible to rename.
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    NUMBER_AT.lastIndex = index;
    NAME_AT.lastIndex = index;
    const number = NUMBER_AT.exec(source);
    const name = number ? null : NAME_AT.exec(source);
    if (number) {
      tokens.push({ kind: "number", text: number[0], start: index, end: index + number[0].length });
    } else if (name) {
      tokens.push({ kind: "name", text: name[0], start: index, end: index + name[0].length });
    } else if ("+-*/(),".includes(char)) {
      tokens.push({ kind: "symbol", text: char as "+", start: index, end: index + 1 });
    } else {
      const width = String.fromCodePoint(source.codePointAt(index)!).length;
      tokens.push({ kind: "invalid", text: source.slice(index, index + width), start: index, end: index + width });
    }
    index = tokens[tokens.length - 1]!.end;
  }
  tokens.push({ kind: "end", text: "", start: source.length, end: source.length });
  return tokens;
}

function isReferenceToken(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index]!;
  if (token.kind !== "name" || RESERVED.has(token.text)) return false;
  const next = tokens[index + 1];
  return !(next?.kind === "symbol" && next.text === "(");
}

function referenceTokens(source: string): Token[] {
  const tokens = tokenize(source);
  return tokens.filter((_, index) => isReferenceToken(tokens, index));
}

/** Lists referenced parameter names once each, in first-use order. Reads malformed input too. */
export function expressionDependencies(expression: string): string[] {
  return [...new Set(referenceTokens(expression).map((token) => token.text))];
}

/**
 * Renames references to `oldName`, leaving all other text intact.
 * Throws `RangeError` when `newName` is not a valid parameter name.
 */
export function renameExpressionReference(expression: string, oldName: string, newName: string): string {
  if (!isValidParameterName(newName)) throw new RangeError(`Invalid parameter name: ${JSON.stringify(newName)}`);
  let output = "";
  let cursor = 0;
  for (const token of referenceTokens(expression)) {
    if (token.text !== oldName) continue;
    output += expression.slice(cursor, token.start) + newName;
    cursor = token.end;
  }
  return output + expression.slice(cursor);
}

// --- parser -----------------------------------------------------------------

type Node =
  | { kind: "number"; value: number; unit: UnitName | null; span: ExpressionSpan }
  | { kind: "reference"; name: string; span: ExpressionSpan }
  | { kind: "negate"; operand: Node; span: ExpressionSpan }
  | { kind: "group"; inner: Node; span: ExpressionSpan }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/"; left: Node; right: Node; span: ExpressionSpan }
  | { kind: "call"; name: string; nameSpan: ExpressionSpan; args: Node[]; span: ExpressionSpan };

class ExpressionFailure {
  constructor(readonly error: ExpressionError) {}
}

function fail(code: ExpressionErrorCode, message: string, span: ExpressionSpan): never {
  throw new ExpressionFailure({ code, message, span });
}

function spanOf(token: Token): ExpressionSpan {
  return { start: token.start, end: token.end };
}

function join(left: ExpressionSpan, right: ExpressionSpan): ExpressionSpan {
  return { start: left.start, end: right.end };
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Node {
    const node = this.expression();
    const token = this.peek();
    if (token.kind !== "end") this.unexpected(token);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private isSymbol(text: string): boolean {
    const token = this.peek();
    return token.kind === "symbol" && token.text === text;
  }

  private unexpected(token: Token): never {
    if (token.kind === "end") fail("parseError", "Expression ends too early.", spanOf(token));
    fail("parseError", `Unexpected "${token.text}".`, spanOf(token));
  }

  private nest<T>(token: Token, parse: () => T): T {
    if (++this.depth > MAX_NESTING) fail("parseError", "Expression nests too deeply.", spanOf(token));
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private expression(): Node {
    let node = this.term();
    while (this.isSymbol("+") || this.isSymbol("-")) {
      const operator = this.next().text as "+" | "-";
      const right = this.term();
      node = { kind: "binary", operator, left: node, right, span: join(node.span, right.span) };
    }
    return node;
  }

  private term(): Node {
    let node = this.unary();
    while (this.isSymbol("*") || this.isSymbol("/")) {
      const operator = this.next().text as "*" | "/";
      const right = this.unary();
      node = { kind: "binary", operator, left: node, right, span: join(node.span, right.span) };
    }
    return node;
  }

  // Iterative so a long run of signs cannot overflow the stack.
  private unary(): Node {
    const signs: Token[] = [];
    while (this.isSymbol("-") || this.isSymbol("+")) signs.push(this.next());
    let node = this.primary();
    for (const sign of signs.reverse()) {
      if (sign.text === "-") node = { kind: "negate", operand: node, span: join(spanOf(sign), node.span) };
      else node = { ...node, span: join(spanOf(sign), node.span) } as Node;
    }
    return node;
  }

  private primary(): Node {
    const token = this.next();
    if (token.kind === "number") return this.literal(token);
    if (token.kind === "name") {
      if (this.isSymbol("(")) return this.call(token);
      if (isUnit(token.text)) fail("parseError", `Unit "${token.text}" must follow a number.`, spanOf(token));
      if (isFunction(token.text)) fail("parseError", `Function "${token.text}" needs arguments in parentheses.`, spanOf(token));
      return { kind: "reference", name: token.text, span: spanOf(token) };
    }
    if (token.kind === "symbol" && token.text === "(") {
      return this.nest(token, () => {
        const inner = this.expression();
        const close = this.next();
        if (!(close.kind === "symbol" && close.text === ")")) {
          if (close.kind === "end") fail("parseError", 'Missing ")".', spanOf(close));
          this.unexpected(close);
        }
        return { kind: "group", inner, span: join(spanOf(token), spanOf(close)) };
      });
    }
    return this.unexpected(token);
  }

  private literal(token: Token): Node {
    const value = Number(token.text);
    const unit = this.peek();
    if (unit.kind === "name" && isUnit(unit.text)) {
      this.next();
      return { kind: "number", value, unit: unit.text, span: join(spanOf(token), spanOf(unit)) };
    }
    return { kind: "number", value, unit: null, span: spanOf(token) };
  }

  private call(name: Token): Node {
    return this.nest(name, () => {
      this.next();
      const args: Node[] = [];
      if (!this.isSymbol(")")) {
        args.push(this.expression());
        while (this.isSymbol(",")) {
          this.next();
          args.push(this.expression());
        }
      }
      const close = this.next();
      if (!(close.kind === "symbol" && close.text === ")")) {
        if (close.kind === "end") fail("parseError", 'Missing ")".', spanOf(close));
        this.unexpected(close);
      }
      return { kind: "call", name: name.text, nameSpan: spanOf(name), args, span: join(spanOf(name), spanOf(close)) };
    });
  }
}

// --- evaluation ---------------------------------------------------------------

/** `dimension: null` marks a bare-number value whose dimension context decides. */
type Value = { value: number; dimension: Dimension | null };

function toDimension(dimension: Dimension | DimensionName): Dimension {
  return typeof dimension === "string" ? DIMENSIONS[dimension] : dimension;
}

function sameDimension(a: Dimension, b: Dimension): boolean {
  return a.length === b.length && a.angle === b.angle;
}

/** Names a dimension for messages: "area", or "length^-1" for unnamed ones. */
export function formatDimension(dimension: Dimension | DimensionName): string {
  const resolved = toDimension(dimension);
  const named = (Object.keys(DIMENSIONS) as DimensionName[]).find((name) => sameDimension(DIMENSIONS[name], resolved));
  if (named) return named;
  const part = (base: string, power: number) => (power === 0 ? [] : [power === 1 ? base : `${base}^${power}`]);
  return [...part("length", resolved.length), ...part("angle", resolved.angle)].join("·");
}

function article(name: string): string {
  return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`;
}

function lookup(scope: ExpressionScope, name: string): ExpressionQuantity | undefined {
  if (scope instanceof Map) return scope.get(name);
  const record = scope as Readonly<Record<string, ExpressionQuantity>>;
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function finite(result: Value, span: ExpressionSpan): Value {
  if (!Number.isFinite(result.value)) fail("nonFinite", "Result is not a finite number.", span);
  return result;
}

// Fixes a bare number's dimension from its additive partner.
function unify(values: readonly Value[], spanAt: (index: number) => ExpressionSpan): Dimension | null {
  let dimension: Dimension | null = null;
  values.forEach((item, index) => {
    if (!item.dimension) return;
    if (dimension && !sameDimension(dimension, item.dimension)) {
      fail(
        "dimensionMismatch",
        `Cannot combine ${article(formatDimension(dimension))} with ${article(formatDimension(item.dimension))}.`,
        spanAt(index),
      );
    }
    dimension = item.dimension;
  });
  return dimension;
}

function combine(a: Dimension | null, b: Dimension | null, sign: 1 | -1): Dimension | null {
  if (!a && !b) return null;
  const left = a ?? DIMENSIONS.unitless;
  const right = b ?? DIMENSIONS.unitless;
  return { length: left.length + sign * right.length, angle: left.angle + sign * right.angle };
}

const ARITY: Record<FunctionName, [min: number, max: number]> = {
  min: [1, Infinity],
  max: [1, Infinity],
  abs: [1, 1],
  sqrt: [1, 1],
  round: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
};

const DEGREES = Math.PI / 180;

function evaluateCall(node: Extract<Node, { kind: "call" }>, scope: ExpressionScope): Value {
  if (!isFunction(node.name)) fail("unknownFunction", `Unknown function "${node.name}".`, node.nameSpan);
  const [min, max] = ARITY[node.name];
  if (node.args.length < min || node.args.length > max) {
    const expected = max === Infinity ? `at least ${min}` : `${min}`;
    fail("argumentCount", `${node.name} takes ${expected} argument${min === 1 && max === 1 ? "" : "s"}.`, node.span);
  }
  const args = node.args.map((arg) => evaluateNode(arg, scope));
  const [first] = args as [Value];
  switch (node.name) {
    case "min":
    case "max": {
      const dimension = unify(args, (index) => node.args[index]!.span);
      const pick = node.name === "min" ? Math.min : Math.max;
      return { value: pick(...args.map((arg) => arg.value)), dimension };
    }
    case "abs":
      return { value: Math.abs(first.value), dimension: first.dimension };
    case "round":
      return { value: Math.round(first.value), dimension: first.dimension };
    case "floor":
      return { value: Math.floor(first.value), dimension: first.dimension };
    case "ceil":
      return { value: Math.ceil(first.value), dimension: first.dimension };
    case "sqrt": {
      const dimension = first.dimension;
      if (dimension && (dimension.length % 2 !== 0 || dimension.angle % 2 !== 0)) {
        fail("dimensionMismatch", `Cannot take the square root of ${article(formatDimension(dimension))}.`, node.args[0]!.span);
      }
      return finite(
        { value: Math.sqrt(first.value), dimension: dimension && { length: dimension.length / 2, angle: dimension.angle / 2 } },
        node.span,
      );
    }
    case "sin":
    case "cos":
    case "tan": {
      if (first.dimension && !sameDimension(first.dimension, DIMENSIONS.angle)) {
        fail("dimensionMismatch", `${node.name} takes an angle, not ${article(formatDimension(first.dimension))}.`, node.args[0]!.span);
      }
      return { value: Math[node.name](first.value * DEGREES), dimension: DIMENSIONS.unitless };
    }
  }
}

function evaluateNode(node: Node, scope: ExpressionScope): Value {
  switch (node.kind) {
    case "number": {
      if (!node.unit) return finite({ value: node.value, dimension: null }, node.span);
      const unit = UNIT_SCALES[node.unit];
      return finite({ value: node.value * unit.scale, dimension: unit.dimension }, node.span);
    }
    case "reference": {
      const quantity = lookup(scope, node.name);
      if (!quantity) fail("unknownName", `Unknown parameter "${node.name}".`, node.span);
      return finite({ value: quantity.value, dimension: toDimension(quantity.dimension) }, node.span);
    }
    case "group":
      return evaluateNode(node.inner, scope);
    case "negate": {
      const operand = evaluateNode(node.operand, scope);
      return { value: -operand.value, dimension: operand.dimension };
    }
    case "call":
      return finite(evaluateCall(node, scope), node.span);
    case "binary": {
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      switch (node.operator) {
        case "+":
        case "-": {
          const dimension = unify([left, right], () => node.span);
          const value = node.operator === "+" ? left.value + right.value : left.value - right.value;
          return finite({ value, dimension }, node.span);
        }
        case "*":
          return finite({ value: left.value * right.value, dimension: combine(left.dimension, right.dimension, 1) }, node.span);
        case "/":
          if (right.value === 0) fail("divisionByZero", "Division by zero.", node.right.span);
          return finite({ value: left.value / right.value, dimension: combine(left.dimension, right.dimension, -1) }, node.span);
      }
    }
  }
}

function parse(expression: string): Node {
  return new Parser(tokenize(expression)).parse();
}

function attempt(run: () => ExpressionResult): ExpressionResult {
  try {
    return run();
  } catch (caught) {
    if (caught instanceof ExpressionFailure) return { ok: false, error: caught.error };
    // Last resort for engine limits such as stack exhaustion.
    return { ok: false, error: { code: "parseError", message: "Expression could not be evaluated.", span: { start: 0, end: 0 } } };
  }
}

/**
 * Evaluates `expression` against `scope`. The result is in base units and must have
 * `expectedDimension` when given. Never throws.
 */
export function evaluateExpression(
  expression: string,
  scope: ExpressionScope = {},
  expectedDimension?: Dimension | DimensionName,
): ExpressionResult {
  return attempt(() => {
    const root = parse(expression);
    const result = evaluateNode(root, scope);
    const expected = expectedDimension === undefined ? null : toDimension(expectedDimension);
    const dimension = result.dimension ?? expected ?? DIMENSIONS.unitless;
    if (expected && !sameDimension(dimension, expected)) {
      fail("dimensionMismatch", `Expected ${article(formatDimension(expected))}, got ${article(formatDimension(dimension))}.`, root.span);
    }
    return { ok: true, value: result.value, dimension };
  });
}

// --- parameter table ------------------------------------------------------------

export type ParameterTableEntry = {
  readonly name: string;
  readonly expression: string;
  /** Required dimension; when omitted, the expression decides and bare numbers are unitless. */
  readonly dimension?: Dimension | DimensionName;
};

export type ParameterTableResult = {
  /** One result per entry, in entry order. */
  readonly results: readonly ExpressionResult[];
  /** Names that resolved, in the order they were evaluated. */
  readonly order: readonly string[];
  /** Resolved values, usable as an `evaluateExpression` scope. */
  readonly scope: ReadonlyMap<string, ExpressionQuantity & { readonly dimension: Dimension }>;
};

const EMPTY_SPAN: ExpressionSpan = { start: 0, end: 0 };

function failure(error: ExpressionError): ExpressionResult {
  return { ok: false, error };
}

/**
 * Resolves every entry in dependency order. Reports cycles with their path, and fails entries that
 * reference a failed entry with `dependencyFailed`. Name errors use an empty span.
 */
export function resolveParameterTable(entries: readonly ParameterTableEntry[]): ParameterTableResult {
  const results: ExpressionResult[] = new Array(entries.length);
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);

  // Index of the single valid entry for each name; failed names map to -1.
  const indexByName = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (!isValidParameterName(entry.name)) {
      results[index] = failure({ code: "invalidName", message: `"${entry.name}" is not a valid parameter name.`, span: EMPTY_SPAN });
      indexByName.set(entry.name, -1);
    } else if (counts.get(entry.name)! > 1) {
      results[index] = failure({ code: "duplicateName", message: `Parameter "${entry.name}" is defined more than once.`, span: EMPTY_SPAN });
      indexByName.set(entry.name, -1);
    } else {
      indexByName.set(entry.name, index);
    }
  });

  const references = entries.map((entry) => referenceTokens(entry.expression));
  const edges = references.map((tokens) =>
    [...new Set(tokens.map((token) => indexByName.get(token.text)).filter((target): target is number => target !== undefined && target >= 0))],
  );

  markCycles(entries, references, edges, indexByName, results);

  const scope = new Map<string, ExpressionQuantity & { dimension: Dimension }>();
  const order: string[] = [];
  const visited = new Set<number>();
  const visit = (index: number) => {
    if (visited.has(index)) return;
    visited.add(index);
    for (const target of edges[index]!) visit(target);
    if (results[index]) return;
    const entry = entries[index]!;
    const broken = references[index]!.find((token) => {
      const target = indexByName.get(token.text);
      return target !== undefined && (target < 0 || !results[target]!.ok);
    });
    results[index] = broken
      ? failure({ code: "dependencyFailed", message: `Parameter "${broken.text}" has an error.`, span: spanOf(broken) })
      : evaluateExpression(entry.expression, scope, entry.dimension);
    const result = results[index]!;
    if (result.ok) {
      scope.set(entry.name, { value: result.value, dimension: result.dimension });
      order.push(entry.name);
    }
  };
  // Cycle members already have results, so this recursion only walks acyclic paths.
  entries.forEach((_, index) => visit(index));
  return { results, order, scope };
}

// Tarjan's strongly connected components; members of a cyclic component get a `cycle` error.
function markCycles(
  entries: readonly ParameterTableEntry[],
  references: readonly Token[][],
  edges: readonly number[][],
  indexByName: ReadonlyMap<string, number>,
  results: ExpressionResult[],
): void {
  const indexOf = new Map<number, number>();
  const lowLink = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  let counter = 0;

  const connect = (node: number) => {
    indexOf.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of edges[node]!) {
      if (!indexOf.has(target)) {
        connect(target);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, indexOf.get(target)!));
      }
    }
    if (lowLink.get(node) !== indexOf.get(node)) return;
    const component = new Set<number>();
    let member: number;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.add(member);
    } while (member !== node);
    if (component.size === 1 && !edges[node]!.includes(node)) return;
    for (const start of component) {
      const path = cyclePath(start, component, edges);
      const names = path.map((index) => entries[index]!.name);
      const next = entries[path[1]!]!.name;
      const token = references[start]!.find((candidate) => candidate.text === next && indexByName.get(candidate.text) === path[1]);
      results[start] = failure({
        code: "cycle",
        message: `Reference cycle: ${names.join(" → ")}.`,
        span: token ? spanOf(token) : EMPTY_SPAN,
        cycle: names,
      });
    }
  };

  entries.forEach((_, index) => {
    if (indexByName.get(entries[index]!.name) === index && !indexOf.has(index)) connect(index);
  });
}

// Shortest path from `start` back to itself inside one component, following entry order.
function cyclePath(start: number, component: ReadonlySet<number>, edges: readonly number[][]): number[] {
  const previous = new Map<number, number>();
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    for (const target of edges[node]!) {
      if (!component.has(target)) continue;
      if (target === start) {
        const between: number[] = [];
        for (let step = node; step !== start; step = previous.get(step)!) between.unshift(step);
        return [start, ...between, start];
      }
      if (!previous.has(target)) {
        previous.set(target, node);
        queue.push(target);
      }
    }
  }
  return [start, start];
}
