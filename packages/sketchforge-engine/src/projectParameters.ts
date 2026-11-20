/**
 * The project parameter table. Every operation is pure: it returns a new
 * project or a structured error and never throws. A table that fails to
 * resolve is never returned, so callers can keep the old one on error.
 */

import {
  expressionDependencies,
  isValidParameterName,
  renameExpressionReference,
  resolveParameterTable,
  type ExpressionError,
} from "./parameterExpressions.js";
import type { ProjectParameter, ProjectParameterDimension } from "./domain/sketchforge.js";

/** Bounds table size. `SKF_LIMITS.parameters` must match. */
export const PROJECT_PARAMETER_LIMIT = 2_000;

export const PROJECT_PARAMETER_DIMENSIONS: readonly ProjectParameterDimension[] = Object.freeze(["length", "angle", "unitless"]);

export type ProjectParameterInput = Pick<ProjectParameter, "name" | "expression" | "dimension">;

export type ProjectParameterHolder = { readonly parameters: readonly ProjectParameter[] };

export type ProjectParameterErrorCode =
  | "invalidName"
  | "duplicateName"
  | "invalidDimension"
  | "invalidExpression"
  | "unknownParameter"
  | "parameterInUse"
  | "tooManyParameters";

export type ProjectParameterError = {
  readonly code: ProjectParameterErrorCode;
  readonly message: string;
  /** Names the parameter that failed, which can be a dependent of the one changed. */
  readonly parameter: string;
  /** Set for `invalidExpression`. */
  readonly expressionError?: ExpressionError;
  /** Set for `parameterInUse`: parameters whose expressions reference it directly. */
  readonly dependents?: readonly string[];
};

export type ProjectParameterResult<T> =
  | { readonly ok: true; readonly project: T }
  | { readonly ok: false; readonly error: ProjectParameterError };

export type ResolvedProjectParameters =
  | { readonly ok: true; readonly parameters: ProjectParameter[] }
  | { readonly ok: false; readonly error: ProjectParameterError };

function failure(code: ProjectParameterErrorCode, parameter: string, message: string, extra: Partial<ProjectParameterError> = {}) {
  return { ok: false as const, error: { code, parameter, message, ...extra } };
}

function isDimension(value: unknown): value is ProjectParameterDimension {
  return (PROJECT_PARAMETER_DIMENSIONS as readonly unknown[]).includes(value);
}

/**
 * Validates names and dimensions, then evaluates every expression. Ignores cached values.
 * Reports the root failure, not the dependents that fail with it.
 */
export function resolveProjectParameters(entries: readonly ProjectParameterInput[]): ResolvedProjectParameters {
  if (entries.length > PROJECT_PARAMETER_LIMIT) {
    return failure("tooManyParameters", String(entries[PROJECT_PARAMETER_LIMIT]?.name), `A project can have at most ${PROJECT_PARAMETER_LIMIT} parameters.`);
  }
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.name;
    if (typeof name !== "string" || !isValidParameterName(name)) {
      return failure("invalidName", String(name), `${JSON.stringify(name)} is not a valid parameter name.`);
    }
    if (names.has(name)) return failure("duplicateName", name, `Parameter "${name}" already exists.`);
    names.add(name);
    if (!isDimension(entry.dimension)) {
      return failure("invalidDimension", name, `Parameter "${name}" needs a length, angle, or unitless dimension.`);
    }
    if (typeof entry.expression !== "string") return failure("invalidExpression", name, `Parameter "${name}" has no expression.`);
  }

  const { results } = resolveParameterTable(entries.map(({ name, expression, dimension }) => ({ name, expression, dimension })));
  let rootIndex = results.findIndex((result) => !result.ok && result.error.code !== "dependencyFailed");
  if (rootIndex < 0) rootIndex = results.findIndex((result) => !result.ok);
  const root = results[rootIndex];
  if (root && !root.ok) {
    const name = entries[rootIndex]!.name;
    return failure("invalidExpression", name, `Parameter "${name}": ${root.error.message}`, { expressionError: root.error });
  }
  return {
    ok: true,
    parameters: entries.map(({ name, expression, dimension }, index) => {
      const result = results[index]!;
      return { name, expression, dimension, value: result.ok ? result.value : Number.NaN };
    }),
  };
}

function withParameters<T extends ProjectParameterHolder>(project: T, entries: readonly ProjectParameterInput[]): ProjectParameterResult<T> {
  const resolved = resolveProjectParameters(entries);
  return resolved.ok ? { ok: true, project: { ...project, parameters: resolved.parameters } } : resolved;
}

function indexOfParameter(project: ProjectParameterHolder, name: string) {
  return project.parameters.findIndex((parameter) => parameter.name === name);
}

function unknown(name: string) {
  return failure("unknownParameter", name, `There is no parameter "${name}".`);
}

/** Lists parameters whose expressions reference `name` directly, in table order. */
export function parameterDependents(parameters: readonly ProjectParameter[], name: string): string[] {
  return parameters
    .filter((parameter) => parameter.name !== name && expressionDependencies(parameter.expression).includes(name))
    .map((parameter) => parameter.name);
}

/** Appends a parameter. */
export function addParameter<T extends ProjectParameterHolder>(project: T, input: ProjectParameterInput): ProjectParameterResult<T> {
  if (project.parameters.length >= PROJECT_PARAMETER_LIMIT) {
    return failure("tooManyParameters", String(input.name), `A project can have at most ${PROJECT_PARAMETER_LIMIT} parameters.`);
  }
  return withParameters(project, [...project.parameters, input]);
}

/** Changes a parameter's expression, dimension, or both, and re-resolves its dependents. */
export function updateParameter<T extends ProjectParameterHolder>(
  project: T,
  name: string,
  changes: Partial<Pick<ProjectParameter, "expression" | "dimension">>,
): ProjectParameterResult<T> {
  const index = indexOfParameter(project, name);
  if (index < 0) return unknown(name);
  return withParameters(project, project.parameters.map((parameter, current) => (current === index ? { ...parameter, ...changes } : parameter)));
}

/**
 * Renames a parameter and every reference to it. Single entry point for renames,
 * so references outside the table can be rewritten here too.
 */
export function renameParameter<T extends ProjectParameterHolder>(project: T, oldName: string, newName: string): ProjectParameterResult<T> {
  if (indexOfParameter(project, oldName) < 0) return unknown(oldName);
  if (newName === oldName) return { ok: true, project };
  // renameExpressionReference throws on an invalid name. Resolving rejects a collision.
  if (typeof newName !== "string" || !isValidParameterName(newName)) {
    return failure("invalidName", String(newName), `${JSON.stringify(newName)} is not a valid parameter name.`);
  }
  return withParameters(project, project.parameters.map((parameter) => ({
    ...parameter,
    name: parameter.name === oldName ? newName : parameter.name,
    expression: renameExpressionReference(parameter.expression, oldName, newName),
  })));
}

/** Deletes an unreferenced parameter. Refuses with `parameterInUse` and its dependents otherwise. */
export function deleteParameter<T extends ProjectParameterHolder>(project: T, name: string): ProjectParameterResult<T> {
  if (indexOfParameter(project, name) < 0) return unknown(name);
  const dependents = parameterDependents(project.parameters, name);
  if (dependents.length) {
    return failure("parameterInUse", name, `Parameter "${name}" is used by ${dependents.join(", ")}.`, { dependents });
  }
  return withParameters(project, project.parameters.filter((parameter) => parameter.name !== name));
}
