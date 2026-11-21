/**
 * The project parameter table. Every operation is pure: it returns a new
 * project or a structured error and never throws.
 *
 * A table may hold entries that do not resolve, for example a stored name that
 * a later release reserves. They keep their last value and carry `error`. An
 * operation is refused only when it breaks an entry that resolved before, or
 * when the entry it changes does not resolve.
 *
 * Configurations (#618) are named rows of expression overrides. Each entry's
 * `expression` is its base expression, and `value` resolves under the active
 * configuration. Every change is checked against the base table and every
 * configuration's table, not only the active one.
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
import {
  parameterSketchConstraintDependents,
  renameSketchConstraintReferences,
  type SketchConstraintDependent,
} from "./sketchConstraintBindings.js";
import type { ProjectConfiguration, ProjectParameter, ProjectParameterDimension, WorkplaneShape } from "./domain/sketchforge.js";

/** Bounds table size. `SKF_LIMITS.parameters` must match. */
export const PROJECT_PARAMETER_LIMIT = 2_000;

/** Bounds configuration count, since each edit resolves every configuration. `SKF_LIMITS.configurations` must match. */
export const PROJECT_CONFIGURATION_LIMIT = 200;
const MAX_CONFIGURATION_NAME_LENGTH = 100;

export const PROJECT_PARAMETER_DIMENSIONS: readonly ProjectParameterDimension[] = Object.freeze(["length", "angle", "unitless"]);

export type ProjectParameterInput = Pick<ProjectParameter, "name" | "expression" | "dimension"> & { value?: number };

export type ProjectParameterHolder = {
  readonly parameters?: readonly ProjectParameter[];
  readonly configurations?: readonly ProjectConfiguration[];
  /** Names the active configuration. Null or absent means the base table. */
  readonly activeConfiguration?: string | null;
};

export type ProjectConfigurationInput = { name: string; overrides?: Record<string, string> };

export type ProjectParameterErrorCode =
  | "invalidParameter"
  | "invalidName"
  | "duplicateName"
  | "invalidDimension"
  | "invalidExpression"
  | "unknownParameter"
  | "parameterInUse"
  | "tooManyParameters"
  | "invalidConfiguration"
  | "invalidConfigurationName"
  | "duplicateConfigurationName"
  | "unknownConfiguration"
  | "tooManyConfigurations";

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
  /** Set for `parameterInUse`: sketch outputs whose constraint bindings reference it directly. */
  readonly sketchConstraintDependents?: readonly SketchConstraintDependent[];
  /** Names the configuration whose table failed, or the one an operation named. Absent for the base table. */
  readonly configuration?: string;
  /** Set for `parameterInUse`: configurations whose override expressions reference it. */
  readonly configurationDependents?: readonly string[];
};

/** Names a configuration entry that fails although its base entry resolves, or an override of an unknown parameter. */
export type ProjectConfigurationIssue = {
  readonly configuration: string;
  readonly parameter: string;
  readonly error: ProjectParameterError;
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

function configurationsOf(project: ProjectParameterHolder | null | undefined): readonly ProjectConfiguration[] {
  return project?.configurations ?? [];
}

function activeOf(project: ProjectParameterHolder | null | undefined): string | null {
  return project?.activeConfiguration ?? null;
}

/** Accepts 1 to 100 characters without control characters or surrounding whitespace. */
export function isValidConfigurationName(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_CONFIGURATION_NAME_LENGTH
    && name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name);
}

function overridesError(overrides: unknown, configuration: string): ProjectParameterError | null {
  if (!isRecord(overrides) || Object.keys(overrides).length > PROJECT_PARAMETER_LIMIT
    || Object.values(overrides).some((expression) => typeof expression !== "string")) {
    return failure("invalidConfiguration", "", `Configuration "${configuration}" needs overrides that map parameter names to expressions.`, { configuration }).error;
  }
  return null;
}

/** Checks configuration structure and the active name. Override keys that name no parameter pass; see `configurationIssues`. */
export function projectConfigurationError(configurations: unknown, activeConfiguration: unknown): ProjectParameterError | null {
  const entries = configurations ?? [];
  if (!Array.isArray(entries)) return failure("invalidConfiguration", "", "The configurations must be a list.").error;
  if (entries.length > PROJECT_CONFIGURATION_LIMIT) {
    return failure("tooManyConfigurations", "", `A project can have at most ${PROJECT_CONFIGURATION_LIMIT} configurations.`).error;
  }
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) return failure("invalidConfiguration", "", `Configuration ${index} is not an object.`).error;
    const name = entry.name as string;
    if (!isValidConfigurationName(name)) {
      return failure("invalidConfigurationName", "", `${JSON.stringify(name)} is not a valid configuration name.`, { configuration: String(name) }).error;
    }
    if (names.has(name)) return failure("duplicateConfigurationName", "", `Configuration "${name}" already exists.`, { configuration: name }).error;
    names.add(name);
    const malformed = overridesError(entry.overrides, name);
    if (malformed) return malformed;
  }
  if (activeConfiguration !== undefined && activeConfiguration !== null && !names.has(activeConfiguration as string)) {
    return failure("unknownConfiguration", "", `There is no configuration "${activeConfiguration}".`, { configuration: String(activeConfiguration) }).error;
  }
  return null;
}

function withConfiguration(error: ProjectParameterError, configuration: string): ProjectParameterError {
  return { ...error, configuration, message: `Configuration "${configuration}": ${error.message}` };
}

/** Resolves the table with `configuration`'s overrides applied. Entries keep their base expressions. */
export function resolveConfiguredParameters(
  entries: readonly ProjectParameterInput[],
  configuration?: ProjectConfiguration,
): ResolvedProjectParameters {
  if (!configuration) return resolveProjectParameters(entries);
  const malformed = structuralError(entries);
  if (malformed) return { ok: false, error: malformed };
  const { overrides } = configuration;
  const resolved = resolveProjectParameters(entries.map((entry) => (
    Object.hasOwn(overrides, entry.name) ? { ...entry, expression: overrides[entry.name]! } : entry)));
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    parameters: resolved.parameters.map((parameter, index) => ({
      ...parameter,
      expression: entries[index]!.expression,
      ...(parameter.error ? { error: withConfiguration(parameter.error, configuration.name) } : {}),
    })),
  };
}

function unknownConfiguration(name: unknown) {
  return failure("unknownConfiguration", "", `There is no configuration "${name}".`, { configuration: String(name) });
}

/** Resolves the table under `name`, or the base table for null, without activating it. */
export function resolveConfiguration(project: ProjectParameterHolder, name: string | null): ResolvedProjectParameters {
  const malformed = projectConfigurationError(project?.configurations, project?.activeConfiguration);
  if (malformed) return { ok: false, error: malformed };
  if (name === null) return resolveProjectParameters(tableOf(project));
  const configuration = configurationsOf(project).find((entry) => entry.name === name);
  return configuration ? resolveConfiguredParameters(tableOf(project), configuration) : unknownConfiguration(name);
}

/** Lists configuration entries that fail although the base entry resolves, and overrides of unknown parameters. */
export function configurationIssues(project: ProjectParameterHolder): ProjectConfigurationIssue[] {
  if (projectConfigurationError(project?.configurations, project?.activeConfiguration)) return [];
  const base = resolveProjectParameters(tableOf(project));
  if (!base.ok) return [];
  const names = new Set(base.parameters.map((parameter) => parameter.name));
  const issues: ProjectConfigurationIssue[] = [];
  for (const configuration of configurationsOf(project)) {
    const table = resolveConfiguredParameters(tableOf(project), configuration);
    if (!table.ok) continue;
    table.parameters.forEach((parameter, index) => {
      if (parameter.error && !base.parameters[index]!.error) {
        issues.push({ configuration: configuration.name, parameter: parameter.name, error: parameter.error });
      }
    });
    for (const name of Object.keys(configuration.overrides).filter((key) => !names.has(key))) {
      issues.push({ configuration: configuration.name, parameter: name, error: withConfiguration(unknown(name).error, configuration.name) });
    }
  }
  return issues;
}

type NextTables = {
  parameters: readonly ProjectParameterInput[];
  configurations: readonly ProjectConfiguration[];
  activeConfiguration: string | null;
};

type ChangeRules = {
  /** Maps a `next` index to the old one, or -1. */
  previousIndex: (index: number) => number;
  /** Maps a next configuration name to its old one. A name with no old configuration compares with the old base table. */
  previousConfiguration?: (name: string) => string;
  /** Marks the entries the change sets, which must resolve. */
  touched: (configuration: ProjectConfiguration | undefined, index: number) => boolean;
  /** Only the active table changes: compare the new active table with the old one. */
  switchesTable?: true;
};

/**
 * In an inactive configuration's table, a touched entry failing only through a dependency is not refused:
 * a dependency this change breaks fails the resolved-before check itself, and one already stale stays stale.
 */
function brokenEntries(
  before: readonly ProjectParameter[],
  after: readonly ProjectParameter[],
  touched: (index: number) => boolean,
  previousIndex: (index: number) => number,
  inactiveConfiguration: boolean,
) {
  return after.filter((parameter, index) => {
    if (!parameter.error) return false;
    const previous = previousIndex(index);
    if (previous >= 0 && !before[previous]!.error) return true;
    return touched(index) && !(inactiveConfiguration && parameter.error.expressionError?.code === "dependencyFailed");
  });
}

/**
 * Resolves every table of `next` and refuses it if a touched entry fails or an
 * entry that resolved before now fails, in the base table or any configuration.
 */
function applyChange<T extends ProjectParameterHolder>(project: T, next: NextTables, rules: ChangeRules): ProjectParameterResult<T> {
  const malformed = projectConfigurationError(project?.configurations, project?.activeConfiguration)
    ?? projectConfigurationError(next.configurations, next.activeConfiguration);
  if (malformed) return { ok: false, error: malformed };
  const oldByName = new Map(configurationsOf(project).map((configuration) => [configuration.name, configuration]));
  const beforeTables = new Map<ProjectConfiguration | undefined, ResolvedProjectParameters>();
  const before = (configuration: ProjectConfiguration | undefined) => {
    if (!beforeTables.has(configuration)) beforeTables.set(configuration, resolveConfiguredParameters(tableOf(project), configuration));
    return beforeTables.get(configuration)!;
  };
  const oldActive = oldByName.get(activeOf(project) as string);
  let active: ProjectParameter[] | undefined;
  let broken: ProjectParameter[] = [];
  for (const configuration of [undefined, ...next.configurations]) {
    const isActive = (configuration?.name ?? null) === next.activeConfiguration;
    if (rules.switchesTable && !isActive) continue;
    const after = resolveConfiguredParameters(next.parameters, configuration);
    if (!after.ok) return after;
    if (isActive) active = after.parameters;
    const previous = rules.switchesTable
      ? before(oldActive)
      : before(configuration && oldByName.get(rules.previousConfiguration?.(configuration.name) ?? configuration.name));
    if (!previous.ok) return previous;
    broken = brokenEntries(previous.parameters, after.parameters, (index) => rules.touched(configuration, index), rules.previousIndex, configuration !== undefined && !isActive);
    if (broken.length) break;
  }
  const root = broken.find((parameter) => parameter.error!.expressionError?.code !== "dependencyFailed") ?? broken[0];
  if (root) return { ok: false, error: root.error! };
  const configured = next.configurations.length > 0 || project?.configurations !== undefined;
  return {
    ok: true,
    project: {
      ...project,
      parameters: active!,
      ...(configured ? { configurations: [...next.configurations], activeConfiguration: next.activeConfiguration } : {}),
    },
  };
}

/** Drops override keys named `name`. Called when `name` becomes a parameter, so any such key is stale. */
function withoutStaleOverrides(configurations: readonly ProjectConfiguration[], name: string): ProjectConfiguration[] {
  return configurations.map((configuration) => (Object.hasOwn(configuration.overrides, name)
    ? { ...configuration, overrides: Object.fromEntries(Object.entries(configuration.overrides).filter(([key]) => key !== name)) }
    : configuration));
}

/** Keeps configurations and the active name. The touched entry must resolve wherever no configuration overrides it. */
function tableChange(project: ProjectParameterHolder, parameters: readonly ProjectParameterInput[], touched: number, previousIndex: (index: number) => number) {
  const name = parameters[touched]?.name;
  return {
    next: { parameters, configurations: configurationsOf(project), activeConfiguration: activeOf(project) },
    rules: {
      previousIndex,
      touched: (configuration: ProjectConfiguration | undefined, index: number) => index === touched
        && !(configuration && name !== undefined && Object.hasOwn(configuration.overrides, name)),
    },
  };
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

/**
 * Lists configurations whose override expressions reference `name`. Overrides of `name` itself do not count,
 * nor do overrides of keys outside `parameterNames`, which apply to nothing.
 */
export function configurationDependents(
  configurations: readonly ProjectConfiguration[],
  name: string,
  parameterNames?: ReadonlySet<string>,
): string[] {
  return (Array.isArray(configurations) ? configurations : [])
    .filter((configuration) => isRecord(configuration) && isRecord(configuration.overrides) && Object.entries(configuration.overrides)
      .some(([key, expression]) => key !== name && (!parameterNames || parameterNames.has(key))
        && expressionDependencies(expression as string).includes(name)))
    .map((configuration) => configuration.name);
}

/** Lists parameters, shapes, sketch constraints and configurations that reference `name` directly. Shapes are read from `project.shapes`. */
export function projectParameterDependents(
  project: ProjectParameterHolder,
  name: string,
): { parameters: string[]; shapes: ShapeBindingDependent[]; sketchConstraints: SketchConstraintDependent[]; configurations: string[] } {
  const shapes = shapesOf(project) ?? [];
  return {
    parameters: parameterDependents(tableOf(project), name),
    shapes: parameterShapeDependents(shapes, name),
    sketchConstraints: parameterSketchConstraintDependents(shapes, name),
    configurations: configurationDependents(configurationsOf(project), name, new Set(tableOf(project).filter(isRecord).map((parameter) => parameter.name))),
  };
}

/** Appends a parameter. */
export function addParameter<T extends ProjectParameterHolder>(project: T, input: ProjectParameterInput): ProjectParameterResult<T> {
  const parameters = tableOf(project);
  if (!isRecord(input)) return failure("invalidParameter", "", "The new parameter is not an object.");
  if (parameters.length >= PROJECT_PARAMETER_LIMIT) {
    return failure("tooManyParameters", String(input.name), `A project can have at most ${PROJECT_PARAMETER_LIMIT} parameters.`);
  }
  const { name, expression, dimension } = input;
  const configurationMalformed = projectConfigurationError(project.configurations, project.activeConfiguration);
  if (configurationMalformed) return { ok: false, error: configurationMalformed };
  const { next, rules } = tableChange(project, [...parameters, { name, expression, dimension }], parameters.length, (index) => (index < parameters.length ? index : -1));
  const configurations = typeof name === "string" ? withoutStaleOverrides(next.configurations, name) : next.configurations;
  return applyChange(project, { ...next, configurations }, { ...rules, touched: (_, index) => index === parameters.length });
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
  const change = tableChange(project, next, index, (current) => current);
  return applyChange(project, change.next, change.rules);
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
  const configurationMalformed = projectConfigurationError(project.configurations, project.activeConfiguration);
  if (configurationMalformed) return { ok: false, error: configurationMalformed };
  const configurations = withoutStaleOverrides(configurationsOf(project), newName).map((configuration) => ({
    ...configuration,
    overrides: Object.fromEntries(Object.entries(configuration.overrides)
      .map(([key, expression]) => [key === oldName ? newName : key, renameExpressionReference(expression, oldName, newName)])),
  }));
  const change = tableChange(project, next, index, (current) => current);
  // A rename changes no value, so only an entry it breaks refuses it.
  const renamed = applyChange(project, { ...change.next, configurations }, { ...change.rules, touched: () => false });
  const shapes = shapesOf(project);
  if (!renamed.ok || !shapes) return renamed;
  const renamedShapes = renameSketchConstraintReferences(renameShapeBindingReferences(shapes, oldName, newName), oldName, newName);
  return { ok: true, project: { ...renamed.project, shapes: renamedShapes } };
}

/** Deletes an unreferenced parameter. Refuses with `parameterInUse` and its dependents otherwise. */
export function deleteParameter<T extends ProjectParameterHolder>(project: T, name: string): ProjectParameterResult<T> {
  const parameters = tableOf(project);
  const index = indexOfParameter(parameters, name);
  if (index < 0) return unknown(name);
  const malformed = structuralError(parameters);
  if (malformed) return { ok: false, error: malformed };
  const configurationMalformed = projectConfigurationError(project.configurations, project.activeConfiguration);
  if (configurationMalformed) return { ok: false, error: configurationMalformed };
  const { parameters: dependents, shapes: shapeDependents, sketchConstraints, configurations: configurationDependents } = projectParameterDependents(project, name);
  if (dependents.length || shapeDependents.length || sketchConstraints.length || configurationDependents.length) {
    const users = [
      ...dependents,
      ...shapeDependents.map((entry) => `shape ${entry.shapeId}`),
      ...sketchConstraints.map((entry) => `sketch ${entry.shapeId} constraint ${entry.constraintIds.join(", ")}`),
      ...configurationDependents.map((configuration) => `configuration "${configuration}"`),
    ];
    return failure("parameterInUse", name, `Parameter "${name}" is used by ${users.join(", ")}.`, {
      dependents,
      shapeDependents,
      sketchConstraintDependents: sketchConstraints,
      ...(configurationDependents.length ? { configurationDependents } : {}),
    });
  }
  // The deleted parameter's own overrides go with it.
  const configurations = configurationsOf(project).map((configuration) => (Object.hasOwn(configuration.overrides, name)
    ? { ...configuration, overrides: Object.fromEntries(Object.entries(configuration.overrides).filter(([key]) => key !== name)) }
    : configuration));
  return applyChange(
    project,
    { parameters: parameters.filter((_, current) => current !== index), configurations, activeConfiguration: activeOf(project) },
    { previousIndex: (current) => (current < index ? current : current + 1), touched: () => false },
  );
}

// --- configurations ---------------------------------------------------------

function findConfiguration(project: ProjectParameterHolder, name: string) {
  return configurationsOf(project).findIndex((configuration) => configuration.name === name);
}

function nameError(project: ProjectParameterHolder, name: string) {
  if (!isValidConfigurationName(name)) {
    return failure("invalidConfigurationName", "", `${JSON.stringify(name)} is not a valid configuration name.`, { configuration: String(name) });
  }
  if (findConfiguration(project, name) >= 0) {
    return failure("duplicateConfigurationName", "", `Configuration "${name}" already exists.`, { configuration: name });
  }
  return null;
}

/** Applies a change that keeps the parameter table, so every index maps to itself. */
function configurationChange<T extends ProjectParameterHolder>(
  project: T,
  configurations: readonly ProjectConfiguration[],
  activeConfiguration: string | null,
  rules: Omit<ChangeRules, "previousIndex">,
): ProjectParameterResult<T> {
  return applyChange(project, { parameters: tableOf(project), configurations, activeConfiguration }, { ...rules, previousIndex: (index) => index });
}

function guarded<T extends ProjectParameterHolder>(project: T, work: () => ProjectParameterResult<T>): ProjectParameterResult<T> {
  const malformed = structuralError(tableOf(project)) ?? projectConfigurationError(project?.configurations, project?.activeConfiguration);
  return malformed ? { ok: false, error: malformed } : work();
}

function unknownIn(parameter: string, configuration: string) {
  return { ok: false as const, error: { ...unknown(parameter).error, configuration } };
}

/** Appends a configuration. Every override must name a parameter and resolve. */
export function addConfiguration<T extends ProjectParameterHolder>(project: T, input: ProjectConfigurationInput): ProjectParameterResult<T> {
  return guarded(project, () => {
    if (!isRecord(input)) return failure("invalidConfiguration", "", "The new configuration is not an object.");
    const { name } = input;
    const invalid = nameError(project, name);
    if (invalid) return invalid;
    if (configurationsOf(project).length >= PROJECT_CONFIGURATION_LIMIT) {
      return failure("tooManyConfigurations", "", `A project can have at most ${PROJECT_CONFIGURATION_LIMIT} configurations.`, { configuration: name });
    }
    const overrides = input.overrides ?? {};
    const malformed = overridesError(overrides, name);
    if (malformed) return { ok: false, error: malformed };
    const parameters = tableOf(project);
    const missing = Object.keys(overrides).find((key) => indexOfParameter(parameters, key) < 0);
    if (missing !== undefined) return unknownIn(missing, name);
    const added = { name, overrides: Object.fromEntries(Object.entries(overrides)) };
    return configurationChange(project, [...configurationsOf(project), added], activeOf(project), {
      touched: (configuration, index) => configuration?.name === name && Object.hasOwn(overrides, parameters[index]!.name),
    });
  });
}

/** Renames a configuration. The active name follows. */
export function renameConfiguration<T extends ProjectParameterHolder>(project: T, oldName: string, newName: string): ProjectParameterResult<T> {
  return guarded(project, () => {
    const index = findConfiguration(project, oldName);
    if (index < 0) return unknownConfiguration(oldName);
    if (newName === oldName) return { ok: true, project };
    const invalid = nameError(project, newName);
    if (invalid) return invalid;
    const configurations = configurationsOf(project).map((configuration, current) => (current === index ? { ...configuration, name: newName } : configuration));
    const active = activeOf(project) === oldName ? newName : activeOf(project);
    return configurationChange(project, configurations, active, {
      previousConfiguration: (name) => (name === newName ? oldName : name),
      touched: () => false,
    });
  });
}

/** Deletes a configuration. Deleting the active one switches to the base table. */
export function deleteConfiguration<T extends ProjectParameterHolder>(project: T, name: string): ProjectParameterResult<T> {
  return guarded(project, () => {
    const index = findConfiguration(project, name);
    if (index < 0) return unknownConfiguration(name);
    const active = activeOf(project) === name ? null : activeOf(project);
    return configurationChange(project, configurationsOf(project).filter((_, current) => current !== index), active, {
      switchesTable: true,
      touched: () => false,
    });
  });
}

function overrideChange<T extends ProjectParameterHolder>(
  project: T,
  index: number,
  parameter: string,
  overrides: (current: Record<string, string>) => Record<string, string>,
): ProjectParameterResult<T> {
  const parameters = tableOf(project);
  const name = configurationsOf(project)[index]!.name;
  const configurations = configurationsOf(project).map((configuration, current) => (current === index
    ? { ...configuration, overrides: overrides(configuration.overrides) }
    : configuration));
  return configurationChange(project, configurations, activeOf(project), {
    touched: (configuration, entry) => configuration?.name === name && parameters[entry]!.name === parameter,
  });
}

/** Sets the expression `parameter` takes in a configuration. */
export function setConfigurationOverride<T extends ProjectParameterHolder>(
  project: T,
  configuration: string,
  parameter: string,
  expression: string,
): ProjectParameterResult<T> {
  return guarded(project, () => {
    const index = findConfiguration(project, configuration);
    if (index < 0) return unknownConfiguration(configuration);
    if (indexOfParameter(tableOf(project), parameter) < 0) return unknownIn(parameter, configuration);
    if (typeof expression !== "string") {
      return failure("invalidExpression", parameter, `Configuration "${configuration}": parameter "${parameter}" needs a text expression.`, { configuration });
    }
    return overrideChange(project, index, parameter, (overrides) => ({ ...overrides, [parameter]: expression }));
  });
}

/** Removes an override, so `parameter` takes its base expression there. Clearing an absent override changes nothing. */
export function clearConfigurationOverride<T extends ProjectParameterHolder>(
  project: T,
  configuration: string,
  parameter: string,
): ProjectParameterResult<T> {
  return guarded(project, () => {
    const index = findConfiguration(project, configuration);
    if (index < 0) return unknownConfiguration(configuration);
    if (!Object.hasOwn(configurationsOf(project)[index]!.overrides, parameter)) {
      return indexOfParameter(tableOf(project), parameter) < 0 ? unknownIn(parameter, configuration) : { ok: true, project };
    }
    return overrideChange(project, index, parameter, (overrides) => Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== parameter)));
  });
}

/** Makes `name` the active configuration, or the base table for null. Refused if it breaks an entry the current table resolves. */
export function activateConfiguration<T extends ProjectParameterHolder>(project: T, name: string | null): ProjectParameterResult<T> {
  return guarded(project, () => {
    if (name !== null && findConfiguration(project, name) < 0) return unknownConfiguration(name);
    if (name === activeOf(project)) return { ok: true, project };
    return configurationChange(project, configurationsOf(project), name, { switchesTable: true, touched: () => false });
  });
}
