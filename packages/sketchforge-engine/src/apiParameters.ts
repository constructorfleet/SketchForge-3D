/**
 * Reads and replies for the REST v1 parameter routes.
 *
 * Shared with MCP local mode, so a request REST refuses is refused there with
 * the same sentence, and a reply has the same fields.
 */

import { apiShapeSummary } from "./apiShapeSummary.js";
import { wireExpressionError } from "./apiErrors.js";
import type { ProjectConfiguration, ProjectParameter, ProjectParameterDimension, WorkplaneShape } from "./domain/sketchforge.js";
import type { ParametersWritten } from "./engine.js";
import { shapeBindingIssues } from "./expressionBindings.js";
import { sketchConstraintBindingIssues } from "./sketchConstraintBindings.js";
import type { ExpressionError } from "./parameterExpressions.js";
import { configurationIssues } from "./projectParameters.js";

export const API_PARAMETER_NAME_MAX_LENGTH = 64;
export const API_PARAMETER_EXPRESSION_MAX_LENGTH = 10_000;
/** The limit as refusals word it. */
export const API_PARAMETER_EXPRESSION_LIMIT = `${API_PARAMETER_EXPRESSION_MAX_LENGTH.toLocaleString("en-US")} characters`;
/** Matches the engine's configuration name limit. */
export const API_CONFIGURATION_NAME_MAX_LENGTH = 100;
export const API_PARAMETER_DIMENSIONS: readonly ProjectParameterDimension[] = ["length", "angle", "unitless"];

export const API_PARAMETER_MESSAGES = {
  create: `A parameter needs a name, an expression of at most ${API_PARAMETER_EXPRESSION_LIMIT}, and a dimension of length, angle, or unitless.`,
  change: `Send name alone to rename, or expression (at most ${API_PARAMETER_EXPRESSION_LIMIT}) and dimension to change the value.`,
  nameRequired: "A parameter name is required.",
} as const;

export const API_CONFIGURATION_MESSAGES = {
  create: "A configuration needs a name, and overrides that map parameter names to expressions.",
  change: "Send name alone to rename, or parameter and expression (null to clear) to change an override.",
  activate: "Send the configuration name to activate, or null for the base table.",
  nameRequired: `A configuration name of 1 to ${API_CONFIGURATION_NAME_MAX_LENGTH} characters is required.`,
} as const;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (body: Record<string, unknown>, allowed: readonly string[]) => Object.keys(body).every((key) => allowed.includes(key));
const isName = (value: unknown) => typeof value === "string" && value.length >= 1 && value.length <= API_PARAMETER_NAME_MAX_LENGTH;
const isExpression = (value: unknown) => typeof value === "string" && /\S/.test(value) && value.length <= API_PARAMETER_EXPRESSION_MAX_LENGTH;
const isDimension = (value: unknown) => API_PARAMETER_DIMENSIONS.includes(value as ProjectParameterDimension);

/** Accepts `{ name, expression, dimension }` and nothing else. */
export function isApiParameterCreateRequest(body: unknown): body is { name: string; expression: string; dimension: ProjectParameterDimension } {
  return isObject(body) && onlyKeys(body, ["name", "expression", "dimension"])
    && isName(body.name) && isExpression(body.expression) && isDimension(body.dimension);
}

/** A rename carries `name` and nothing else. */
export type ApiParameterChange = { name?: string; expression?: string; dimension?: ProjectParameterDimension };

/** Accepts `{ name }` alone, or `expression`, `dimension` or both. */
export function isApiParameterChangeRequest(body: unknown): body is ApiParameterChange {
  if (!isObject(body)) return false;
  if ("name" in body) return onlyKeys(body, ["name"]) && isName(body.name);
  return onlyKeys(body, ["expression", "dimension"]) && ("expression" in body || "dimension" in body)
    && (!("expression" in body) || isExpression(body.expression))
    && (!("dimension" in body) || isDimension(body.dimension));
}

const isConfigurationName = (value: unknown) => typeof value === "string" && value.length >= 1 && value.length <= API_CONFIGURATION_NAME_MAX_LENGTH;

/** Accepts `{ name, overrides? }`, where overrides maps names to expressions. */
export function isApiConfigurationCreateRequest(body: unknown): body is { name: string; overrides?: Record<string, string> } {
  return isObject(body) && onlyKeys(body, ["name", "overrides"]) && isConfigurationName(body.name)
    && (!("overrides" in body) || (isObject(body.overrides) && Object.values(body.overrides).every(isExpression)));
}

/** A rename carries `name` alone; an override change carries `parameter` and `expression`, null to clear. */
export type ApiConfigurationChange = { name: string } | { parameter: string; expression: string | null };

export function isApiConfigurationChangeRequest(body: unknown): body is ApiConfigurationChange {
  if (!isObject(body)) return false;
  if ("name" in body) return onlyKeys(body, ["name"]) && isConfigurationName(body.name);
  return onlyKeys(body, ["parameter", "expression"]) && isName(body.parameter)
    && "expression" in body && (body.expression === null || isExpression(body.expression));
}

/** Accepts `{ name }`, where null names the base table. */
export function isApiConfigurationActivateRequest(body: unknown): body is { name: string | null } {
  return isObject(body) && onlyKeys(body, ["name"]) && "name" in body && (body.name === null || isConfigurationName(body.name));
}

/** Returns the trimmed `?name=` value, or undefined when it is missing or out of bounds. */
export function apiParameterName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= API_PARAMETER_NAME_MAX_LENGTH ? trimmed : undefined;
}

function apiIssue({ code, message, expressionError }: { code: string; message: string; expressionError?: ExpressionError }) {
  return { code, message, ...(expressionError ? { expressionError: wireExpressionError(expressionError) } : {}) };
}

/** Serializes one table entry. A stale entry's NaN becomes null, which JSON would write anyway. */
export function apiParameter(parameter: ProjectParameter) {
  return {
    name: parameter.name,
    expression: parameter.expression,
    dimension: parameter.dimension,
    value: Number.isFinite(parameter.value) ? parameter.value : null,
    ...(parameter.error ? { error: apiIssue(parameter.error) } : {}),
  };
}

/** The `GET /parameters` reply. */
export function apiParameterList(project: {
  parameters: readonly ProjectParameter[];
  activeConfiguration?: string | null;
  shapes: readonly WorkplaneShape[];
  revision: number;
}) {
  return {
    parameters: project.parameters.map(apiParameter),
    activeConfiguration: project.activeConfiguration ?? null,
    bindingIssues: shapeBindingIssues(project.shapes, project.parameters)
      .map((issue) => ({ shapeId: issue.shapeId, field: issue.field, ...apiIssue(issue) })),
    constraintBindingIssues: sketchConstraintBindingIssues(project.shapes, project.parameters).map((issue) => ({
      shapeId: issue.shapeId,
      constraintId: issue.constraintId,
      ...apiIssue(issue),
      ...(issue.fields ? { fields: [...issue.fields] } : {}),
    })),
    revision: project.revision,
  };
}

/** A parameter write's reply; `parameter` is the entry now called `name`. */
export function apiParametersWritten(value: ParametersWritten, name: string) {
  const parameter = value.parameters.find((entry) => entry.name === name);
  return {
    ...(parameter ? { parameter: apiParameter(parameter) } : {}),
    parameters: value.parameters.map(apiParameter),
    shapes: value.shapes.map(apiShapeSummary),
    revision: value.revision,
  };
}

export function apiConfiguration({ name, overrides }: ProjectConfiguration) {
  return { name, overrides: { ...overrides } };
}

type ConfiguredProject = {
  parameters: readonly ProjectParameter[];
  configurations: readonly ProjectConfiguration[];
  activeConfiguration: string | null;
};

/** The configurations, the active name, the resolved table, and overrides that no longer resolve. */
export function apiConfigurationState(project: ConfiguredProject) {
  return {
    configurations: project.configurations.map(apiConfiguration),
    activeConfiguration: project.activeConfiguration,
    parameters: project.parameters.map(apiParameter),
    issues: configurationIssues(project).map(({ configuration, parameter, error }) => ({ configuration, parameter, ...apiIssue(error) })),
  };
}

/** The `GET /parameter-configurations` reply. */
export function apiConfigurationList(project: ConfiguredProject & { revision: number }) {
  return { ...apiConfigurationState(project), revision: project.revision };
}

/** A configuration write's reply; `configuration` is the one now called `name`, when given and still present. */
export function apiConfigurationsWritten(value: ParametersWritten, name?: string) {
  const configuration = name === undefined ? undefined : value.configurations.find((entry) => entry.name === name);
  return {
    ...(configuration ? { configuration: apiConfiguration(configuration) } : {}),
    ...apiConfigurationState(value),
    shapes: value.shapes.map(apiShapeSummary),
    revision: value.revision,
  };
}
