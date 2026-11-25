/**
 * Request definitions: the one statement of each request rule.
 *
 * The engine's request checks run these definitions, the REST operation
 * contract publishes them, and the MCP tool catalog takes its limits from them.
 * Imports nothing: scripts/generate-openapi.mjs loads this file from source.
 */

/** The JSON Schema subset the REST contract publishes. Lengths are `minimumLength`/`maximumLength`. */
export type ApiSchema = {
  type?: "number" | "integer" | "boolean" | "string" | "object" | "array";
  nullable?: true;
  required?: readonly string[];
  enum?: readonly (string | null)[];
  default?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minimumLength?: number;
  maximumLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  oneOf?: readonly ApiSchema[];
  anyOf?: readonly ApiSchema[];
  not?: ApiSchema;
  additionalProperties?: boolean | ApiSchema;
  description?: string;
  format?: string;
  properties?: Readonly<Record<string, ApiSchema>>;
  patternProperties?: Readonly<Record<string, ApiSchema>>;
  items?: ApiSchema;
};

/** One query parameter. `trim` applies before the bounds and the pattern. */
export type ApiQueryRule = {
  type: "string";
  trim?: true;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  description?: string;
};

/**
 * The machine-readable half of an error, alongside the sentence.
 *
 * A status code is too coarse to act on here. `404` covers a missing project, a
 * missing shape and an API that is switched off entirely; `409` covers both "the
 * project is busy, retry" and "that shape is locked, do not retry". Without a
 * code a client has to match on the prose, which makes every wording change a
 * breaking one -- and both client libraries were doing exactly that.
 */
export const API_ERROR_CODES = frozen([
  "api_disabled",
  "unauthorized",
  "storage_unconfigured",
  "invalid_project_id",
  "invalid_shape_id",
  "invalid_body",
  "invalid_request",
  "project_not_found",
  "project_exists",
  "project_busy",
  "revision_mismatch",
  "shape_not_found",
  "shape_locked",
  "parameter_not_found",
  "parameter_exists",
  "parameter_in_use",
  "configuration_not_found",
  "configuration_exists",
  "invalid_expression",
  "unsupported_kind",
  "unsupported_format",
  "unapplicable_fields",
  "too_many_shapes",
  "limit_exceeded",
  "geometry_failed",
  "cad_failed",
  "internal_error",
] as const);

/** Same rule as the store: the id becomes a file name in the project directory. */
export const API_PROJECT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$";
export const API_PROJECT_ID_MAX_LENGTH = 120;
export const API_PARAMETER_NAME_MAX_LENGTH = 64;
export const API_PARAMETER_EXPRESSION_MAX_LENGTH = 10_000;
/** Matches the engine's configuration name limit. */
export const API_CONFIGURATION_NAME_MAX_LENGTH = 100;
export const API_CONSTRAINT_ID_MAX_LENGTH = 200;
export const API_PARAMETER_DIMENSIONS = frozen(["length", "angle", "unitless"] as const);

export const API_QUERY_RULES = frozen({
  projectId: { type: "string", trim: true, pattern: API_PROJECT_ID_PATTERN, maxLength: API_PROJECT_ID_MAX_LENGTH },
  shapeId: { type: "string", trim: true, minLength: 1 },
  parameterName: { type: "string", trim: true, minLength: 1, maxLength: API_PARAMETER_NAME_MAX_LENGTH, description: "The parameter to change or delete." },
  // Not trimmed: a configuration name keeps the characters it was created with.
  configurationName: { type: "string", minLength: 1, maxLength: API_CONFIGURATION_NAME_MAX_LENGTH, description: "The configuration to change or delete." },
  constraintId: { type: "string", trim: true, minLength: 1, maxLength: API_CONSTRAINT_ID_MAX_LENGTH },
} as const satisfies Readonly<Record<string, ApiQueryRule>>);

const parameterName = {
  type: "string",
  minimumLength: 1,
  maximumLength: API_PARAMETER_NAME_MAX_LENGTH,
  description: "An ASCII identifier that is not a unit or function name, such as wall_thickness.",
} as const;
const parameterExpression = { type: "string", pattern: "\\S", maximumLength: API_PARAMETER_EXPRESSION_MAX_LENGTH } as const;
const parameterDimension = { type: "string", enum: API_PARAMETER_DIMENSIONS } as const;
const configurationName = {
  type: "string",
  minimumLength: 1,
  maximumLength: API_CONFIGURATION_NAME_MAX_LENGTH,
  description: `1 to ${API_CONFIGURATION_NAME_MAX_LENGTH} characters, with no control characters or surrounding whitespace.`,
} as const;

export const API_REQUEST_FIELDS = frozen({ parameterName, parameterExpression, parameterDimension, configurationName } as const);

/** Request bodies, keyed by REST operationId. */
export const API_REQUEST_BODIES = frozen({
  createParameter: {
    type: "object",
    required: ["name", "expression", "dimension"],
    properties: { name: parameterName, expression: parameterExpression, dimension: parameterDimension },
    additionalProperties: false,
  },
  updateParameter: {
    type: "object",
    oneOf: [
      { type: "object", required: ["name"], properties: { name: parameterName }, additionalProperties: false },
      {
        type: "object",
        anyOf: [{ type: "object", required: ["expression"] }, { type: "object", required: ["dimension"] }],
        properties: { expression: parameterExpression, dimension: parameterDimension },
        additionalProperties: false,
      },
    ],
  },
  bindSketchConstraint: {
    type: "object",
    required: ["expression"],
    properties: { expression: { ...parameterExpression, nullable: true, description: "A parameter expression, or null to remove the binding and keep the value." } },
    additionalProperties: false,
  },
  createParameterConfiguration: {
    type: "object",
    required: ["name"],
    properties: { name: configurationName, overrides: { type: "object", additionalProperties: parameterExpression } },
    additionalProperties: false,
  },
  updateParameterConfiguration: {
    type: "object",
    oneOf: [
      { type: "object", required: ["name"], properties: { name: configurationName }, additionalProperties: false },
      {
        type: "object",
        required: ["parameter", "expression"],
        properties: { parameter: parameterName, expression: { ...parameterExpression, nullable: true, description: "The override expression, or null to clear the override." } },
        additionalProperties: false,
      },
    ],
  },
  activateParameterConfiguration: {
    type: "object",
    required: ["name"],
    properties: { name: { ...configurationName, nullable: true, description: "The configuration to activate, or null for the base table." } },
    additionalProperties: false,
  },
} as const satisfies Readonly<Record<string, ApiSchema>>);

/** Freezes a definition and everything it holds. Importers share these objects. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Checks a value against a schema. `oneOf` needs exactly one match; `nullable` accepts null before any other rule. */
export function matchesApiSchema(value: unknown, schema: ApiSchema): boolean {
  if (schema.oneOf && schema.oneOf.filter((candidate) => matchesApiSchema(value, candidate)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((candidate) => matchesApiSchema(value, candidate))) return false;
  if (schema.not && matchesApiSchema(value, schema.not)) return false;
  if (schema.nullable && value === null) return true;
  if (schema.enum && !schema.enum.includes(value as string | null)) return false;
  if (schema.type === "array") return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && (!schema.uniqueItems || new Set(value).size === value.length) && (!schema.items || value.every((item) => matchesApiSchema(item, schema.items!)));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.required?.some((name) => !(name in object))) return false;
    if (Object.entries(schema.properties ?? {}).some(([name, child]) => name in object && !matchesApiSchema(object[name], child))) return false;
    if (Object.entries(object).some(([name, child]) => {
      // `in` would treat Object.prototype names such as "constructor" as declared.
      if (Object.hasOwn(schema.properties ?? {}, name)) return false;
      const matchingPatterns = Object.entries(schema.patternProperties ?? {}).filter(([pattern]) => new RegExp(pattern).test(name));
      if (matchingPatterns.length) return matchingPatterns.some(([, childSchema]) => !matchesApiSchema(child, childSchema));
      if (schema.additionalProperties === false) return true;
      return typeof schema.additionalProperties === "object" && !matchesApiSchema(child, schema.additionalProperties);
    })) return false;
    return true;
  }
  if (schema.type === "string") return typeof value === "string" && (!schema.pattern || new RegExp(schema.pattern).test(value)) && (schema.minimumLength === undefined || value.length >= schema.minimumLength) && (schema.maximumLength === undefined || value.length <= schema.maximumLength);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum) && (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) && (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum);
  return schema.type === undefined;
}

/** Returns a query value as the rule reads it, or undefined when the rule refuses it. */
export function readApiQueryValue(value: unknown, rule: ApiQueryRule): string | undefined {
  if (typeof value !== "string") return undefined;
  const read = rule.trim ? value.trim() : value;
  if (rule.minLength !== undefined && read.length < rule.minLength) return undefined;
  if (rule.maxLength !== undefined && read.length > rule.maxLength) return undefined;
  if (rule.pattern && !new RegExp(rule.pattern).test(read)) return undefined;
  return read;
}

/** Writes a definition as standard JSON Schema: `nullable` joins `type`, lengths become `minLength`/`maxLength`. */
export function apiJsonSchema(schema: ApiSchema): Record<string, unknown> {
  if (schema.oneOf) return { oneOf: schema.oneOf.map(apiJsonSchema) };
  const result: Record<string, unknown> = { type: schema.nullable ? [schema.type, "null"] : schema.type };
  if (schema.not) result.not = apiJsonSchema(schema.not);
  if (schema.required) result.required = [...schema.required];
  if (schema.enum) result.enum = [...schema.enum, ...(schema.nullable ? [null] : [])];
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (schema.maximum !== undefined) result.maximum = schema.maximum;
  if (schema.exclusiveMinimum !== undefined) result.exclusiveMinimum = schema.exclusiveMinimum;
  if (schema.exclusiveMaximum !== undefined) result.exclusiveMaximum = schema.exclusiveMaximum;
  if (schema.minimumLength !== undefined) result.minLength = schema.minimumLength;
  if (schema.maximumLength !== undefined) result.maxLength = schema.maximumLength;
  if (schema.pattern !== undefined) result.pattern = schema.pattern;
  if (schema.minItems !== undefined) result.minItems = schema.minItems;
  if (schema.maxItems !== undefined) result.maxItems = schema.maxItems;
  if (schema.uniqueItems !== undefined) result.uniqueItems = schema.uniqueItems;
  if (schema.description !== undefined) result.description = schema.description;
  if (schema.format !== undefined) result.format = schema.format;
  if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, apiJsonSchema(child)]));
  if (schema.patternProperties) result.patternProperties = Object.fromEntries(Object.entries(schema.patternProperties).map(([pattern, child]) => [pattern, apiJsonSchema(child)]));
  if (schema.anyOf) result.anyOf = schema.anyOf.map(apiJsonSchema);
  if (schema.items) result.items = apiJsonSchema(schema.items);
  if (schema.additionalProperties !== undefined) result.additionalProperties = typeof schema.additionalProperties === "boolean" ? schema.additionalProperties : apiJsonSchema(schema.additionalProperties);
  return result;
}

/** Writes a query rule as JSON Schema. JSON Schema cannot trim, so a trimmed rule's lengths bound the trimmed value. */
export function apiQueryJsonSchema(rule: ApiQueryRule): Record<string, unknown> {
  return {
    type: rule.type,
    ...(rule.pattern ? { pattern: rule.pattern } : {}),
    ...(rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
    ...(rule.maxLength !== undefined ? { maxLength: rule.maxLength } : {}),
  };
}
