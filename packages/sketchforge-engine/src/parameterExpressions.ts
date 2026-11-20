/**
 * Evaluates unit-aware parameter expressions. Pure: no shapes, no project model. Validates its
 * inputs at runtime, since they can arrive as JSON.
 *
 * Values are in base units: mm for length, degrees for angle, products of these for derived
 * dimensions (mm² for area).
 *
 * Bare numbers have no dimension until context gives one:
 * - `+`, `-`, `min`, `max`: takes the other operand's dimension (`wall + 3` is wall + 3 mm).
 * - `*`, `/`: stays unitless (`wall * 2` is a length).
 * - `abs`, `round`, `floor`, `ceil`, `sqrt`, and `min`/`max` of bare arguments: stays bare
 *   (`wall + abs(-3)` is wall + 3 mm; `sqrt(16)` in a length field is 4 mm).
 * - trig argument: an angle in degrees (`sin(30)`).
 * - whole result: the field dimension (`3` and `2 * 3` in a length field are 3 mm and 6 mm),
 *   or unitless when no field dimension is given.
 * Unit literals, references and trig results always have a fixed dimension.
 *
 * Names are ASCII identifiers. A non-ASCII letter is an invalid character, so `wäll` reads as
 * the names `w` and `ll` around it.
 */

export type DimensionName = "unitless" | "length" | "area" | "volume" | "angle";

/** Integer exponents of the base dimensions. Area is `{ length: 2, angle: 0 }`. */
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
  | "invalidArgument"
  | "invalidDimension"
  | "limitExceeded"
  | "cycle"
  | "dependencyFailed"
  | "invalidName"
  | "duplicateName";

export type ExpressionError = {
  readonly code: ExpressionErrorCode;
  readonly message: string;
  readonly span: ExpressionSpan;
  /** Set for `cycle`: one cycle through this parameter's group, from its first entry back to it. */
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
const MAX_EXPRESSION_LENGTH = 10_000;
// Bounds parser and evaluator recursion; flat chains and sign runs do not recurse.
const MAX_NESTING = 128;
const MAX_PARAMETERS = 10_000;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set<string>([...EXPRESSION_UNITS, ...EXPRESSION_FUNCTIONS]);

/** Accepts ASCII identifiers of up to 64 characters that are not unit or function names. */
export function isValidParameterName(name: string): boolean {
  return typeof name === "string" && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name) && !RESERVED.has(name);
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
  if (typeof expression !== "string") return [];
  return [...new Set(referenceTokens(expression).map((token) => token.text))];
}

/**
 * Renames references to `oldName`, leaving all other text intact. Does not check that `newName`
 * is unused; callers must. Throws `RangeError` when `newName` is not a valid parameter name.
 */
export function renameExpressionReference(expression: string, oldName: string, newName: string): string {
  if (typeof expression !== "string") throw new TypeError("Expression must be a string.");
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

type ChainOperator = "+" | "-" | "*" | "/";

type Node =
  | { kind: "number"; value: number; unit: UnitName | null; span: ExpressionSpan }
  | { kind: "reference"; name: string; span: ExpressionSpan }
  | { kind: "negate"; operand: Node; span: ExpressionSpan }
  | { kind: "group"; inner: Node; span: ExpressionSpan }
  // Flat left-to-right operator chain, so `1+1+…` does not nest.
  | { kind: "chain"; first: Node; rest: { operator: ChainOperator; operand: Node }[]; span: ExpressionSpan }
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
    if (++this.depth > MAX_NESTING) fail("limitExceeded", "Expression nests too deeply.", spanOf(token));
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private chain(operators: readonly ChainOperator[], operand: () => Node): Node {
    const first = operand();
    const rest: { operator: ChainOperator; operand: Node }[] = [];
    while (operators.some((operator) => this.isSymbol(operator))) {
      const operator = this.next().text as ChainOperator;
      rest.push({ operator, operand: operand() });
    }
    if (rest.length === 0) return first;
    return { kind: "chain", first, rest, span: join(first.span, rest[rest.length - 1]!.operand.span) };
  }

  private expression(): Node {
    return this.chain(["+", "-"], () => this.chain(["*", "/"], () => this.unary()));
  }

  // Folds a run of signs into at most one negation.
  private unary(): Node {
    let first: Token | null = null;
    let negative = false;
    while (this.isSymbol("-") || this.isSymbol("+")) {
      const sign = this.next();
      first ??= sign;
      if (sign.text === "-") negative = !negative;
    }
    const node = this.primary();
    if (!first) return node;
    const span = join(spanOf(first), node.span);
    return negative ? { kind: "negate", operand: node, span } : ({ ...node, span } as Node);
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
        const close = this.closing();
        return { kind: "group", inner, span: join(spanOf(token), spanOf(close)) };
      });
    }
    return this.unexpected(token);
  }

  private closing(): Token {
    const close = this.next();
    if (close.kind === "symbol" && close.text === ")") return close;
    if (close.kind === "end") fail("parseError", 'Missing ")".', spanOf(close));
    return this.unexpected(close);
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
      const close = this.closing();
      return { kind: "call", name: name.text, nameSpan: spanOf(name), args, span: join(spanOf(name), spanOf(close)) };
    });
  }
}

// --- evaluation ---------------------------------------------------------------

/** `dimension: null` marks a bare-number value whose dimension context decides. */
type Value = { value: number; dimension: Dimension | null };

// Returns null for anything but a known name or an integer exponent record.
function parseDimension(input: unknown): Dimension | null {
  if (typeof input === "string") return Object.hasOwn(DIMENSIONS, input) ? DIMENSIONS[input as DimensionName] : null;
  if (typeof input !== "object" || input === null) return null;
  const { length, angle } = input as { length?: unknown; angle?: unknown };
  if (!Number.isInteger(length) || !Number.isInteger(angle)) return null;
  return { length: length as number, angle: angle as number };
}

function sameDimension(a: Dimension, b: Dimension): boolean {
  return a.length === b.length && a.angle === b.angle;
}

/** Names a dimension for messages: "area", or "length^-1" for unnamed ones. */
export function formatDimension(dimension: Dimension | DimensionName): string {
  const resolved = parseDimension(dimension);
  if (!resolved) return "invalid dimension";
  const named = (Object.keys(DIMENSIONS) as DimensionName[]).find((name) => sameDimension(DIMENSIONS[name], resolved));
  if (named) return named;
  const part = (base: string, power: number) => (power === 0 ? [] : [power === 1 ? base : `${base}^${power}`]);
  return [...part("length", resolved.length), ...part("angle", resolved.angle)].join("·");
}

function lookup(scope: ExpressionScope, name: string): unknown {
  if (scope instanceof Map) return scope.get(name);
  const record = scope as Readonly<Record<string, unknown>>;
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function resolveReference(scope: ExpressionScope, node: Extract<Node, { kind: "reference" }>): Value {
  const quantity = lookup(scope, node.name);
  if (quantity === undefined) fail("unknownName", `Unknown parameter "${node.name}".`, node.span);
  if (typeof quantity !== "object" || quantity === null || typeof (quantity as ExpressionQuantity).value !== "number") {
    fail("invalidArgument", `Parameter "${node.name}" has no numeric value.`, node.span);
  }
  const dimension = parseDimension((quantity as ExpressionQuantity).dimension);
  if (!dimension) fail("invalidDimension", `Parameter "${node.name}" has an invalid dimension.`, node.span);
  return finite({ value: (quantity as ExpressionQuantity).value, dimension }, node.span);
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
      fail("dimensionMismatch", `Cannot combine ${formatDimension(dimension)} with ${formatDimension(item.dimension)}.`, spanAt(index));
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
        fail("dimensionMismatch", `Cannot take the square root of ${formatDimension(dimension)}.`, node.args[0]!.span);
      }
      return { value: Math.sqrt(first.value), dimension: dimension && { length: dimension.length / 2, angle: dimension.angle / 2 } };
    }
    case "sin":
    case "cos":
    case "tan": {
      if (first.dimension && !sameDimension(first.dimension, DIMENSIONS.angle)) {
        fail("dimensionMismatch", `${node.name} needs angle, got ${formatDimension(first.dimension)}.`, node.args[0]!.span);
      }
      return { value: Math[node.name](first.value * DEGREES), dimension: DIMENSIONS.unitless };
    }
  }
}

function applyOperator(
  operator: ChainOperator,
  left: Value,
  right: Value,
  rightSpan: ExpressionSpan,
  span: ExpressionSpan,
): Value {
  switch (operator) {
    case "+":
    case "-": {
      const dimension = unify([left, right], () => span);
      const value = operator === "+" ? left.value + right.value : left.value - right.value;
      return finite({ value, dimension }, span);
    }
    case "*":
      return finite({ value: left.value * right.value, dimension: combine(left.dimension, right.dimension, 1) }, span);
    case "/":
      if (right.value === 0) fail("divisionByZero", "Division by zero.", rightSpan);
      return finite({ value: left.value / right.value, dimension: combine(left.dimension, right.dimension, -1) }, span);
  }
}

function evaluateNode(node: Node, scope: ExpressionScope): Value {
  switch (node.kind) {
    case "number": {
      if (!node.unit) return finite({ value: node.value, dimension: null }, node.span);
      const unit = UNIT_SCALES[node.unit];
      return finite({ value: node.value * unit.scale, dimension: unit.dimension }, node.span);
    }
    case "reference":
      return resolveReference(scope, node);
    case "group":
      return evaluateNode(node.inner, scope);
    case "negate": {
      const operand = evaluateNode(node.operand, scope);
      return { value: -operand.value, dimension: operand.dimension };
    }
    case "call":
      return finite(evaluateCall(node, scope), node.span);
    case "chain": {
      let result = evaluateNode(node.first, scope);
      for (const { operator, operand } of node.rest) {
        result = applyOperator(operator, result, evaluateNode(operand, scope), operand.span, join(node.first.span, operand.span));
      }
      return result;
    }
  }
}

function attempt(expression: string, run: () => ExpressionResult): ExpressionResult {
  try {
    return run();
  } catch (caught) {
    if (caught instanceof ExpressionFailure) return { ok: false, error: caught.error };
    // Last resort; the nesting and length limits should prevent stack exhaustion.
    if (caught instanceof RangeError) {
      return { ok: false, error: { code: "limitExceeded", message: "Expression is too complex.", span: { start: 0, end: expression.length } } };
    }
    throw caught;
  }
}

const EMPTY_SPAN: ExpressionSpan = { start: 0, end: 0 };

function failure(code: ExpressionErrorCode, message: string, span: ExpressionSpan = EMPTY_SPAN): ExpressionResult {
  return { ok: false, error: { code, message, span } };
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
  if (typeof expression !== "string") return failure("invalidArgument", "Expression must be a string.");
  if (typeof scope !== "object" || scope === null) return failure("invalidArgument", "Scope must be a Map or an object.");
  const expected = expectedDimension === undefined ? null : parseDimension(expectedDimension);
  if (expectedDimension !== undefined && !expected) {
    return failure("invalidDimension", `Unknown dimension ${JSON.stringify(expectedDimension) ?? String(expectedDimension)}.`);
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return failure("limitExceeded", `Expression is longer than ${MAX_EXPRESSION_LENGTH} characters.`, {
      start: MAX_EXPRESSION_LENGTH,
      end: expression.length,
    });
  }
  return attempt(expression, () => {
    const root = new Parser(tokenize(expression)).parse();
    const result = evaluateNode(root, scope);
    const dimension = result.dimension ?? expected ?? DIMENSIONS.unitless;
    if (expected && !sameDimension(dimension, expected)) {
      fail("dimensionMismatch", `Expected ${formatDimension(expected)}, got ${formatDimension(dimension)}.`, root.span);
    }
    // Normalizes -0 so stored values compare and serialize as 0.
    return { ok: true, value: result.value === 0 ? 0 : result.value, dimension };
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

const CYCLE_MESSAGE_NAMES = 6;

function cycleMessage(names: readonly string[]): string {
  if (names.length <= CYCLE_MESSAGE_NAMES + 1) return `Reference cycle: ${names.join(" → ")}.`;
  const head = names.slice(0, CYCLE_MESSAGE_NAMES).join(" → ");
  return `Reference cycle: ${head} → … → ${names[0]} (${names.length - 1} parameters).`;
}

/**
 * Resolves every entry in dependency order, up to 10,000 entries. Reports cycles with a path and
 * dependents of failed entries as `dependencyFailed`. Name errors use an empty span.
 * Throws `TypeError` when `entries` is not an array.
 */
export function resolveParameterTable(entries: readonly ParameterTableEntry[]): ParameterTableResult {
  if (!Array.isArray(entries)) throw new TypeError("Parameter table entries must be an array.");
  const results: ExpressionResult[] = new Array(entries.length);
  const scope = new Map<string, ExpressionQuantity & { dimension: Dimension }>();
  const order: string[] = [];
  if (entries.length > MAX_PARAMETERS) {
    results.fill(failure("limitExceeded", `Parameter table has more than ${MAX_PARAMETERS} entries.`));
    return { results, order, scope };
  }

  const names = entries.map((entry) => (typeof entry === "object" && entry !== null && typeof entry.name === "string" ? entry.name : null));
  const counts = new Map<string, number>();
  for (const name of names) if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);

  // Index of the single usable entry for each name; failed names map to -1.
  const indexByName = new Map<string, number>();
  entries.forEach((entry, index) => {
    const name = names[index];
    const error = entryError(entry, name, counts);
    if (error) results[index] = error;
    if (name !== null) indexByName.set(name, error ? -1 : index);
  });

  const references = entries.map((entry, index) => (results[index] ? [] : referenceTokens(entry.expression)));
  const edges = references.map((tokens) => [
    ...new Set(tokens.map((token) => indexByName.get(token.text)).filter((target): target is number => target !== undefined && target >= 0)),
  ]);

  const settle = (component: readonly number[]) => {
    if (component.length > 1 || edges[component[0]!]!.includes(component[0]!)) {
      markCycle(component, entries, references, edges, indexByName, results);
      return;
    }
    const index = component[0]!;
    const entry = entries[index]!;
    const broken = references[index]!.find((token) => {
      const target = indexByName.get(token.text);
      return target !== undefined && (target < 0 || !results[target]!.ok);
    });
    const result = broken
      ? failure("dependencyFailed", `Parameter "${broken.text}" has an error.`, spanOf(broken))
      : evaluateExpression(entry.expression, scope, entry.dimension);
    results[index] = result;
    if (result.ok) {
      scope.set(entry.name, { value: result.value, dimension: result.dimension });
      order.push(entry.name);
    }
  };
  stronglyConnectedComponents(
    entries.map((_, index) => !results[index]),
    edges,
    settle,
  );
  return { results, order, scope };
}

function entryError(entry: unknown, name: string | null, counts: ReadonlyMap<string, number>): ExpressionResult | null {
  if (name === null) return failure("invalidArgument", "Entry must be an object with a string name.");
  const { expression, dimension } = entry as { expression?: unknown; dimension?: unknown };
  if (!isValidParameterName(name)) return failure("invalidName", `"${name}" is not a valid parameter name.`);
  if (counts.get(name)! > 1) return failure("duplicateName", `Parameter "${name}" is defined more than once.`);
  if (typeof expression !== "string") return failure("invalidArgument", `Parameter "${name}" needs a string expression.`);
  if (dimension !== undefined && !parseDimension(dimension)) {
    return failure("invalidDimension", `Parameter "${name}" has an unknown dimension ${JSON.stringify(dimension) ?? String(dimension)}.`);
  }
  return null;
}

/**
 * Runs iterative Tarjan over `active` nodes. Emits each component after every component it
 * references, which is dependency order.
 */
function stronglyConnectedComponents(
  active: readonly boolean[],
  edges: readonly number[][],
  emit: (component: number[]) => void,
): void {
  const count = edges.length;
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  let counter = 0;
  const open = (node: number) => {
    index[node] = low[node] = counter++;
    stack.push(node);
    onStack[node] = 1;
  };

  for (let root = 0; root < count; root += 1) {
    if (!active[root] || index[root] !== -1) continue;
    open(root);
    const work: [node: number, next: number][] = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [node, next] = frame;
      const targets = edges[node]!;
      if (next < targets.length) {
        frame[1] += 1;
        const target = targets[next]!;
        if (index[target] === -1) {
          open(target);
          work.push([target, 0]);
        } else if (onStack[target]) {
          low[node] = Math.min(low[node]!, index[target]!);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low[parent[0]] = Math.min(low[parent[0]]!, low[node]!);
      if (low[node] !== index[node]) continue;
      const component: number[] = [];
      let member: number;
      do {
        member = stack.pop()!;
        onStack[member] = 0;
        component.push(member);
      } while (member !== node);
      emit(component);
    }
  }
}

// All members share one path, so a long cycle costs linear memory.
function markCycle(
  component: readonly number[],
  entries: readonly ParameterTableEntry[],
  references: readonly Token[][],
  edges: readonly number[][],
  indexByName: ReadonlyMap<string, number>,
  results: ExpressionResult[],
): void {
  const members = new Set(component);
  const start = Math.min(...component);
  const path = cyclePath(start, members, edges);
  const names = Object.freeze(path.map((node) => entries[node]!.name));
  const successor = new Map<number, number>();
  for (let step = 0; step < path.length - 1; step += 1) successor.set(path[step]!, path[step + 1]!);
  const message = cycleMessage(names);
  for (const node of component) {
    const target = successor.get(node);
    const token = references[node]!.find((candidate) => {
      const referenced = indexByName.get(candidate.text);
      return target === undefined ? referenced !== undefined && members.has(referenced) : referenced === target;
    });
    results[node] = { ok: false, error: { code: "cycle", message, span: token ? spanOf(token) : EMPTY_SPAN, cycle: names } };
  }
}

// Shortest path from `start` back to itself inside one component.
function cyclePath(start: number, members: ReadonlySet<number>, edges: readonly number[][]): number[] {
  const previous = new Map<number, number>();
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    for (const target of edges[node]!) {
      if (!members.has(target)) continue;
      if (target === start) {
        const between: number[] = [];
        for (let step = node; step !== start; step = previous.get(step)!) between.push(step);
        return [start, ...between.reverse(), start];
      }
      if (!previous.has(target)) {
        previous.set(target, node);
        queue.push(target);
      }
    }
  }
  return [start, start];
}
