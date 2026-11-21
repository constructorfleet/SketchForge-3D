/**
 * The project parameter table. Every operation is pure: it returns a new
 * project or a structured error and never throws.
 *
 * A table may hold entries that do not resolve, for example a stored name that
 * a later release reserves. They keep their last value and carry `error`. An
 * operation is refused only when it breaks an entry that resolved before, or
 * when the entry it changes does not resolve.
 */

import {
  expressionDependencies,
  isValidParameterName,
  renameExpressionReference,
  resolveParameterTable,
  type ExpressionError,
  type ExpressionResult,
} from "./parameterExpressions.js";
import { parameterShapeDependents, renameShapeBindingReferences, type ShapeBindingDependent } from "./expressionBindings.js";
import type { ProjectParameter, ProjectParameterDimension, WorkplaneShape } from "./domain/sketchforge.js";

/** Bounds table size. `SKF_LIMITS.parameters` must match. */
export const PROJECT_PARAMETER_LIMIT = 2_000;

export const PROJECT_PARAMETER_DIMENSIONS: readonly ProjectParameterDimension[] = Object.freeze(["length", "angle", "unitless"]);

export type ProjectParameterInput = Pick<ProjectParameter, "name" | "expression" | "dimension"> & { value?: number };

export type ProjectParameterHolder = { readonly parameters?: readonly ProjectParameter[] };

export type ProjectParameterErrorCode =
  | "invalidParameter"
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
  /** Set for `parameterInUse`: shapes whose bindings reference it directly. */
  readonly shapeDependents?: readonly ShapeBindingDependent[];
};

export type ProjectParameterResult<T> =
  | { readonly ok: true; readonly project: T }
  | { readonly ok: false; readonly error: ProjectParameterError };

/** Fails only on malformed structure. Entries that do not resolve carry `error`. */
export type ResolvedProjectParameters =
  | { readonly ok: true; readonly parameters: ProjectParameter[] }
  | { readonly ok: false; readonly error: ProjectParameterError };

function failure(code: ProjectParameterErrorCode, parameter: string, message: string, extra: Partial<ProjectParameterError> = {}) {
  return { ok: false as const, error: { code, parameter, message, ...extra } };
}

function isDimension(value: unknown): value is ProjectParameterDimension {
  return (PROJECT_PARAMETER_DIMENSIONS as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuralError(entries: unknown): ProjectParameterError | null {
  if (!Array.isArray(entries)) return failure("invalidParameter", "", "The parameter table must be a list.").error;
  if (entries.length > PROJECT_PARAMETER_LIMIT) {
    return failure("tooManyParameters", "", `A project can have at most ${PROJECT_PARAMETER_LIMIT} parameters.`).error;
  }
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) return failure("invalidParameter", "", `Parameter ${index} is not an object.`).error;
    const { name, expression, dimension } = entry;
    if (typeof name !== "string") return failure("invalidName", String(name), `Parameter ${index} has no name.`).error;
    if (!isDimension(dimension)) return failure("invalidDimension", name, `Parameter "${name}" needs a length, angle, or unitless dimension.`).error;
    if (typeof expression !== "string") return failure("invalidExpression", name, `Parameter "${name}" has no expression.`).error;
  }
  return null;
}

function entryError(name: string, result: Extract<ExpressionResult, { ok: false }>): ProjectParameterError {
  const { error } = result;
  if (error.code === "invalidName") return { code: "invalidName", parameter: name, message: `${JSON.stringify(name)} is not a valid parameter name.` };
  if (error.code === "duplicateName") return { code: "duplicateName", parameter: name, message: `Parameter "${name}" already exists.` };
  return { code: "invalidExpression", parameter: name, message: `Parameter "${name}": ${error.message}`, expressionError: error };
}

/** Evaluates every expression and ignores cached values. An entry that fails keeps its finite stored value, else NaN. */
export function resolveProjectParameters(entries: readonly ProjectParameterInput[]): ResolvedProjectParameters {
  const malformed = structuralError(entries);
  if (malformed) return { ok: false, error: malformed };
  const { results } = resolveParameterTable(entries.map(({ name, expression, dimension }) => ({ name, expression, dimension })));
  return {
    ok: true,
    parameters: entries.map(({ name, expression, dimension, value }, index) => {
      const result = results[index]!;
      if (result.ok) return { name, expression, dimension, value: result.value };
      const lastValue = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
      return { name, expression, dimension, value: lastValue, error: entryError(name, result) };
    }),
  };
}

function tableOf(project: ProjectParameterHolder | null | undefined): readonly ProjectParameter[] {
  return project?.parameters ?? [];
}

/**
 * Resolves `next` and refuses it if `touched` fails or an entry that resolved before now fails.
 * `previousIndex` maps a `next` index to the old one, or -1.
 */
function applyChange<T extends ProjectParameterHolder>(
  project: T,
  next: readonly ProjectParameterInput[],
  touched: number,
  previousIndex: (index: number) => number,
): ProjectParameterResult<T> {
  const before = resolveProjectParameters(tableOf(project));
  if (!before.ok) return before;
  const after = resolveProjectParameters(next);
  if (!after.ok) return after;
  const broken = after.parameters.filter((parameter, index) => {
    if (!parameter.error) return false;
    const previous = previousIndex(index);
    return index === touched || (previous >= 0 && !before.parameters[previous]!.error);
  });
  const root = broken.find((parameter) => parameter.error!.expressionError?.code !== "dependencyFailed") ?? broken[0];
  if (root) return { ok: false, error: root.error! };
  return { ok: true, project: { ...project, parameters: after.parameters } };
}

function indexOfParameter(parameters: readonly ProjectParameter[], name: string) {
  return parameters.findIndex((parameter) => isRecord(parameter) && parameter.name === name);
}

function unknown(name: string) {
  return failure("unknownParameter", String(name), `There is no parameter "${name}".`);
}

/** Lists parameters whose expressions reference `name` directly, in table order. */
export function parameterDependents(parameters: readonly ProjectParameter[], name: string): string[] {
  return (parameters ?? [])
    .filter((parameter) => isRecord(parameter) && parameter.name !== name && expressionDependencies(parameter.expression).includes(name))
    .map((parameter) => parameter.name);
}

function shapesOf(project: ProjectParameterHolder): WorkplaneShape[] | undefined {
  const shapes = (project as { shapes?: unknown }).shapes;
  return Array.isArray(shapes) ? shapes as WorkplaneShape[] : undefined;
}

/** Lists parameters and shapes that reference `name` directly. Shapes are read from `project.shapes` when present. */
export function projectParameterDependents(
  project: ProjectParameterHolder,
  name: string,
): { parameters: string[]; shapes: ShapeBindingDependent[] } {
  return { parameters: parameterDependents(tableOf(project), name), shapes: parameterShapeDependents(shapesOf(project) ?? [], name) };
}

/** Appends a parameter. */
export function addParameter<T extends ProjectParameterHolder>(project: T, input: ProjectParameterInput): ProjectParameterResult<T> {
  const parameters = tableOf(project);
  if (!isRecord(input)) return failure("invalidParameter", "", "The new parameter is not an object.");
  if (parameters.length >= PROJECT_PARAMETER_LIMIT) {
    return failure("tooManyParameters", String(input.name), `A project can have at most ${PROJECT_PARAMETER_LIMIT} parameters.`);
  }
  const { name, expression, dimension } = input;
  return applyChange(project, [...parameters, { name, expression, dimension }], parameters.length, (index) => (index < parameters.length ? index : -1));
}

/** Changes a parameter's expression, dimension, or both, and re-resolves its dependents. */
export function updateParameter<T extends ProjectParameterHolder>(
  project: T,
  name: string,
  changes: Partial<Pick<ProjectParameter, "expression" | "dimension">>,
): ProjectParameterResult<T> {
  const parameters = tableOf(project);
  const index = indexOfParameter(parameters, name);
  if (index < 0) return unknown(name);
  const { expression, dimension } = isRecord(changes) ? changes : {};
  const next = parameters.map((parameter, current) => (current === index
    ? { ...parameter, expression: expression ?? parameter.expression, dimension: dimension ?? parameter.dimension }
    : parameter));
  return applyChange(project, next, index, (current) => current);
}

/**
 * Renames a parameter and every reference to it. Single entry point for renames,
 * so references outside the table can be rewritten here too.
 */
export function renameParameter<T extends ProjectParameterHolder>(project: T, oldName: string, newName: string): ProjectParameterResult<T> {
  const parameters = tableOf(project);
  const index = indexOfParameter(parameters, oldName);
  if (index < 0) return unknown(oldName);
  if (newName === oldName) return { ok: true, project };
  // renameExpressionReference throws on an invalid name or expression. Resolving rejects a collision.
  if (!isValidParameterName(newName)) return failure("invalidName", String(newName), `${JSON.stringify(newName)} is not a valid parameter name.`);
  const malformed = structuralError(parameters);
  if (malformed) return { ok: false, error: malformed };
  const next = parameters.map((parameter) => ({
    ...parameter,
    name: parameter.name === oldName ? newName : parameter.name,
    expression: renameExpressionReference(parameter.expression, oldName, newName),
  }));
  const renamed = applyChange(project, next, index, (current) => current);
  const shapes = shapesOf(project);
  if (!renamed.ok || !shapes) return renamed;
  return { ok: true, project: { ...renamed.project, shapes: renameShapeBindingReferences(shapes, oldName, newName) } };
}

/** Deletes an unreferenced parameter. Refuses with `parameterInUse` and its parameter and shape dependents otherwise. */
export function deleteParameter<T extends ProjectParameterHolder>(project: T, name: string): ProjectParameterResult<T> {
  const parameters = tableOf(project);
  const index = indexOfParameter(parameters, name);
  if (index < 0) return unknown(name);
  const malformed = structuralError(parameters);
  if (malformed) return { ok: false, error: malformed };
  const { parameters: dependents, shapes: shapeDependents } = projectParameterDependents(project, name);
  if (dependents.length || shapeDependents.length) {
    const users = [...dependents, ...shapeDependents.map((entry) => `shape ${entry.shapeId}`)];
    return failure("parameterInUse", name, `Parameter "${name}" is used by ${users.join(", ")}.`, { dependents, shapeDependents });
  }
  return applyChange(project, parameters.filter((_, current) => current !== index), -1, (current) => (current < index ? current : current + 1));
}
