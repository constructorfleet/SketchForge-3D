/**
 * Plans parameter table edits for the editor's parameter panel (#616).
 *
 * The table operations are the engine's own pure functions, so the panel
 * refuses exactly what REST and MCP refuse. Moving bound geometry needs the
 * engine's CAD paths, which run on the server: a plan says when it needs one.
 */

import {
  activateConfiguration,
  addConfiguration,
  addParameter,
  clearConfigurationOverride,
  deleteConfiguration,
  deleteParameter,
  renameConfiguration,
  setConfigurationOverride,
  projectParameterDependents,
  renameParameter,
  updateParameter,
  type ProjectParameterError,
  type ProjectParameterResult,
} from "@constructorfleet/sketchforge-engine/projectParameters";
import { bindableField, boundFieldValue, parameterShapeDependents, resolveShapeBindings, withoutBindings } from "@constructorfleet/sketchforge-engine/expressionBindings";
import { REQUESTABLE_SHAPE_KINDS, shapeWithRequestedChanges } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { planParameterBindings } from "@constructorfleet/sketchforge-engine/parameterBindingPlan";
import { boundSketchConstraints, parameterSketchConstraintDependents, withSketchConstraintValues } from "@constructorfleet/sketchforge-engine/sketchConstraintBindings";
import { expressionDependencies, type ExpressionErrorCode } from "@constructorfleet/sketchforge-engine/parameterExpressions";
import type { MessageKey } from "@/i18n/locales";
import type { ProjectConfiguration, ProjectParameter, ProjectParameterDimension, WorkplaneShape } from "@/types/sketchforge";

/** Values are resolved under `activeConfiguration`; edits change base expressions (#618). */
export type ParameterProject = {
  parameters: ProjectParameter[];
  shapes: WorkplaneShape[];
  configurations?: readonly ProjectConfiguration[];
  activeConfiguration?: string | null;
};

export type ParameterEdit =
  | { kind: "add"; name: string; expression: string; dimension: ProjectParameterDimension }
  | { kind: "update"; name: string; expression?: string; dimension?: ProjectParameterDimension }
  | { kind: "rename"; name: string; newName: string }
  /** `releaseShapes` unbinds dependent shape fields first; each keeps its current number. */
  | { kind: "delete"; name: string; releaseShapes?: boolean }
  // Configurations (#618): named rows of expression overrides; one is active at a time.
  | { kind: "addConfiguration"; configuration: string; overrides?: Record<string, string> }
  | { kind: "renameConfiguration"; configuration: string; newName: string }
  | { kind: "deleteConfiguration"; configuration: string }
  /** `null` activates the base table. */
  | { kind: "activateConfiguration"; configuration: string | null }
  | { kind: "setOverride"; configuration: string; name: string; expression: string }
  | { kind: "clearOverride"; configuration: string; name: string };

export type PlannedParameterEdit =
  | { ok: true; project: ParameterProject; recompute: boolean }
  | { ok: false; error: ProjectParameterError };

/** `configuration` names the configuration a table error happened in; shown as a prefix. */
export type ParameterMessage = { key: MessageKey; values: Record<string, string>; configuration?: string };

/** Mirrors the engine's change test: `Object.is`, so an unresolved entry's NaN is not a change. */
function changedNames(previous: readonly ProjectParameter[], next: readonly ProjectParameter[]) {
  const before = new Map(previous.map((parameter) => [parameter.name, parameter]));
  const after = new Map(next.map((parameter) => [parameter.name, parameter]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((name) => {
    const left = before.get(name);
    const right = after.get(name);
    return !left || !right || !Object.is(left.value, right.value) || left.dimension !== right.dimension;
  });
}

function releaseShapeBindings(shapes: readonly WorkplaneShape[], name: string): WorkplaneShape[] {
  const release = (shape: WorkplaneShape): WorkplaneShape => {
    const fields = Object.entries(shape.expressions ?? {})
      .filter(([, expression]) => expressionDependencies(expression).includes(name))
      .map(([field]) => field);
    let next = withoutBindings(shape, fields);
    const constraints = boundSketchConstraints(shape).filter(({ expression }) => expressionDependencies(expression).includes(name));
    if (constraints.length && next.sketchProfile) {
      // The constraint keeps its solved value; only the expression goes.
      next = { ...next, sketchProfile: withSketchConstraintValues(next.sketchProfile, {}, Object.fromEntries(constraints.map(({ constraint }) => [constraint.id, null]))) };
    }
    if (shape.groupedShapes) {
      const children = shape.groupedShapes.map(release);
      if (children.some((child, index) => child !== shape.groupedShapes![index])) next = { ...next, groupedShapes: children };
    }
    if (shape.edgeTreatmentHistory) {
      // Reverting a treatment restores `before`, which must not bring the binding back.
      const history = shape.edgeTreatmentHistory.map((entry) => {
        const before = release(entry.before);
        return before === entry.before ? entry : { ...entry, before };
      });
      if (history.some((entry, index) => entry !== shape.edgeTreatmentHistory![index])) next = { ...next, edgeTreatmentHistory: history };
    }
    return next;
  };
  return shapes.map(release);
}

function runEdit(project: ParameterProject, edit: ParameterEdit): ProjectParameterResult<ParameterProject> {
  switch (edit.kind) {
    case "add":
      return addParameter(project, { name: edit.name, expression: edit.expression, dimension: edit.dimension });
    case "update":
      return updateParameter(project, edit.name, {
        ...(edit.expression === undefined ? {} : { expression: edit.expression }),
        ...(edit.dimension === undefined ? {} : { dimension: edit.dimension }),
      });
    case "rename":
      return renameParameter(project, edit.name, edit.newName);
    case "delete": {
      const dependents = projectParameterDependents(project, edit.name);
      // Parameters and configurations that use it are edited first; only shape bindings are released.
      if (!edit.releaseShapes || dependents.parameters.length || dependents.configurations.length
        || (!dependents.shapes.length && !dependents.sketchConstraints.length)) {
        return deleteParameter(project, edit.name);
      }
      return deleteParameter({ ...project, shapes: releaseShapeBindings(project.shapes, edit.name) }, edit.name);
    }
    case "addConfiguration":
      return addConfiguration(project, { name: edit.configuration, overrides: edit.overrides ?? {} });
    case "renameConfiguration":
      return renameConfiguration(project, edit.configuration, edit.newName);
    case "deleteConfiguration":
      return deleteConfiguration(project, edit.configuration);
    case "activateConfiguration":
      return activateConfiguration(project, edit.configuration);
    case "setOverride":
      return setConfigurationOverride(project, edit.configuration, edit.name, edit.expression);
    case "clearOverride":
      return clearConfigurationOverride(project, edit.configuration, edit.name);
  }
}

/** Names a committed edit for the status line. */
export function parameterEditNotice(edit: ParameterEdit): ParameterMessage {
  switch (edit.kind) {
    case "add": return { key: "editor.parameters.notice.added", values: { name: edit.name } };
    case "update": return { key: "editor.parameters.notice.updated", values: { name: edit.name } };
    case "rename": return { key: "editor.parameters.notice.renamed", values: { name: edit.newName } };
    case "delete": return { key: "editor.parameters.notice.deleted", values: { name: edit.name } };
    case "addConfiguration": return { key: "editor.parameters.configurations.notice.added", values: { name: edit.configuration } };
    case "renameConfiguration": return { key: "editor.parameters.configurations.notice.renamed", values: { name: edit.newName } };
    case "deleteConfiguration": return { key: "editor.parameters.configurations.notice.deleted", values: { name: edit.configuration } };
    case "activateConfiguration":
      return edit.configuration === null
        ? { key: "editor.parameters.configurations.notice.activatedBase", values: {} }
        : { key: "editor.parameters.configurations.notice.activated", values: { name: edit.configuration } };
    case "setOverride": return { key: "editor.parameters.configurations.notice.overrideSet", values: { name: edit.configuration, parameter: edit.name } };
    case "clearOverride": return { key: "editor.parameters.configurations.notice.overrideCleared", values: { name: edit.configuration, parameter: edit.name } };
  }
}

/** Validates an edit against the engine's table rules. Changes nothing. */
export function planParameterEdit(project: ParameterProject, edit: ParameterEdit): PlannedParameterEdit {
  const result = runEdit(project, edit);
  if (!result.ok) return result;
  // Carries configuration rows too: a rename or delete reaches into them.
  const next: ParameterProject = result.project;
  // A renamed binding keeps its value; only a stale one naming the new name can move.
  const bound = (shapes: readonly WorkplaneShape[], name: string) =>
    parameterShapeDependents(shapes, name).length > 0 || parameterSketchConstraintDependents(shapes, name).length > 0;
  const recompute = edit.kind === "rename"
    ? edit.newName !== edit.name && bound(project.shapes, edit.newName)
    : changedNames(project.parameters, next.parameters).some((name) => bound(next.shapes, name));
  return { ok: true, project: next, recompute };
}

function shapeNameIndex(shapes: readonly WorkplaneShape[]) {
  const names = new Map<string, string>();
  const visit = (shape: WorkplaneShape) => {
    if (!names.has(shape.id)) names.set(shape.id, shape.name || shape.id);
    shape.groupedShapes?.forEach(visit);
  };
  shapes.forEach(visit);
  return names;
}

export type ParameterDeleteWarning = {
  parameters: string[];
  /** Configurations whose overrides use it. Like `parameters`, they block the delete. */
  configurations: string[];
  /** `fields` are bound shape fields; `constraints` are bound sketch constraint IDs. */
  shapes: Array<{ shapeId: string; name: string; fields: readonly string[]; constraints: readonly string[] }>;
};

/** Lists what still references `name`, or null when it can be deleted outright. */
export function parameterDeleteWarning(project: ParameterProject, name: string): ParameterDeleteWarning | null {
  const dependents = projectParameterDependents(project, name);
  if (!dependents.parameters.length && !dependents.configurations.length && !dependents.shapes.length && !dependents.sketchConstraints.length) return null;
  const names = shapeNameIndex(project.shapes);
  const byShape = new Map<string, { shapeId: string; name: string; fields: readonly string[]; constraints: readonly string[] }>();
  const entry = (shapeId: string) => {
    const found = byShape.get(shapeId) ?? { shapeId, name: names.get(shapeId) ?? shapeId, fields: [], constraints: [] };
    byShape.set(shapeId, found);
    return found;
  };
  dependents.shapes.forEach(({ shapeId, fields }) => { entry(shapeId).fields = fields; });
  dependents.sketchConstraints.forEach(({ shapeId, constraintIds }) => { entry(shapeId).constraints = constraintIds; });
  return { parameters: dependents.parameters, configurations: dependents.configurations, shapes: [...byShape.values()] };
}

const UNIT_LABELS: Record<ProjectParameterDimension, string> = { length: "mm", angle: "°", unitless: "" };

export function parameterUnitLabel(dimension: ProjectParameterDimension) {
  return UNIT_LABELS[dimension] ?? "";
}

export function formatParameterValue(value: number) {
  return Number.isFinite(value) ? String(Number(value.toFixed(4))) : "—";
}

export type ParameterRow = {
  name: string;
  expression: string;
  dimension: ProjectParameterDimension;
  /** Resolved value in mm, degrees, or plain units, formatted. */
  value: string;
  unit: string;
  /** The active configuration's override expression, when it has one. */
  override?: string;
  error?: ParameterMessage;
};

export function parameterRows(
  parameters: readonly ProjectParameter[],
  configuration?: { configurations?: readonly ProjectConfiguration[]; activeConfiguration?: string | null },
): ParameterRow[] {
  const overrides = configuration?.activeConfiguration
    ? configuration.configurations?.find((entry) => entry.name === configuration.activeConfiguration)?.overrides ?? {}
    : {};
  return parameters.map((parameter) => ({
    name: parameter.name,
    ...(Object.hasOwn(overrides, parameter.name) ? { override: overrides[parameter.name] } : {}),
    expression: parameter.expression,
    dimension: parameter.dimension,
    value: formatParameterValue(parameter.value),
    unit: parameterUnitLabel(parameter.dimension),
    ...(parameter.error ? { error: parameterErrorMessage(parameter.error) } : {}),
  }));
}

export type ParameterNameOption = { name: string; dimension: ProjectParameterDimension; expression: string; value: number };

/**
 * Lists parameter names for autocomplete: prefix matches, then other matches,
 * each alphabetical. Shared with expression entry in dimension fields (#617).
 */
export function parameterNameOptions(
  parameters: readonly ProjectParameter[],
  query = "",
  dimension?: ProjectParameterDimension,
): ParameterNameOption[] {
  const needle = query.trim().toLowerCase();
  const rank = (name: string) => (name.toLowerCase().startsWith(needle) ? 0 : 1);
  return parameters
    .filter((parameter) => (!dimension || parameter.dimension === dimension) && parameter.name.toLowerCase().includes(needle))
    .sort((left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name))
    .map(({ name, dimension: entryDimension, expression, value }) => ({ name, dimension: entryDimension, expression, value }));
}

/** Keys the table and its configurations by content, so the host re-passing an equal state is not a change. */
export function parameterStateKey(
  parameters: readonly ProjectParameter[],
  configuration: { configurations: readonly ProjectConfiguration[]; activeConfiguration: string | null },
) {
  return JSON.stringify([parameterTableKey(parameters), configuration.configurations, configuration.activeConfiguration]);
}

/** Keys a table by content, so the host re-passing an equal table is not a change. */
export function parameterTableKey(parameters: readonly ProjectParameter[]) {
  return JSON.stringify(parameters.map(({ name, expression, dimension, value }) => [name, expression, dimension, Number.isFinite(value) ? value : null]));
}

const TABLE_ERROR_KEYS: Record<Exclude<ProjectParameterError["code"], "invalidExpression">, MessageKey> = {
  invalidParameter: "editor.parameters.error.invalidParameter",
  invalidName: "editor.parameters.error.invalidName",
  duplicateName: "editor.parameters.error.duplicateName",
  invalidDimension: "editor.parameters.error.invalidDimension",
  unknownParameter: "editor.parameters.error.unknownParameter",
  parameterInUse: "editor.parameters.error.parameterInUse",
  tooManyParameters: "editor.parameters.error.tooManyParameters",
  duplicateConfigurationName: "editor.parameters.error.duplicateConfigurationName",
  invalidConfiguration: "editor.parameters.error.invalidConfiguration",
  invalidConfigurationName: "editor.parameters.error.invalidConfigurationName",
  tooManyConfigurations: "editor.parameters.error.tooManyConfigurations",
  unknownConfiguration: "editor.parameters.error.unknownConfiguration",
};

const EXPRESSION_ERROR_KEYS: Record<ExpressionErrorCode, MessageKey> = {
  parseError: "editor.parameters.error.parseError",
  unknownName: "editor.parameters.error.unknownName",
  unknownFunction: "editor.parameters.error.unknownFunction",
  argumentCount: "editor.parameters.error.argumentCount",
  dimensionMismatch: "editor.parameters.error.dimensionMismatch",
  divisionByZero: "editor.parameters.error.divisionByZero",
  nonFinite: "editor.parameters.error.nonFinite",
  invalidArgument: "editor.parameters.error.invalidArgument",
  invalidDimension: "editor.parameters.error.invalidDimension",
  limitExceeded: "editor.parameters.error.limitExceeded",
  cycle: "editor.parameters.error.cycle",
  dependencyFailed: "editor.parameters.error.dependencyFailed",
  invalidName: "editor.parameters.error.invalidName",
  duplicateName: "editor.parameters.error.duplicateName",
};

export function parameterErrorMessage(error: ProjectParameterError): ParameterMessage {
  const message = baseErrorMessage(error);
  // A table error inside a configuration says which one; a naming error already does.
  const named = error.code === "duplicateConfigurationName" || error.code === "unknownConfiguration" || error.code === "invalidConfigurationName";
  return error.configuration && !named ? { ...message, configuration: error.configuration } : message;
}

function baseErrorMessage(error: ProjectParameterError): ParameterMessage {
  const values = { name: error.code === "duplicateConfigurationName" || error.code === "unknownConfiguration" ? error.configuration ?? error.parameter : error.parameter };
  if (error.code !== "invalidExpression") return { key: TABLE_ERROR_KEYS[error.code] ?? "editor.parameters.error.invalidParameter", values };
  const expressionError = error.expressionError;
  if (!expressionError) return { key: "editor.parameters.error.parseError", values };
  if (expressionError.code === "cycle") return { key: "editor.parameters.error.cycle", values: { cycle: (expressionError.cycle ?? [error.parameter]).join(" → ") } };
  return { key: EXPRESSION_ERROR_KEYS[expressionError.code] ?? "editor.parameters.error.parseError", values };
}

/** The engine failures a server recompute reports. Loose: it arrives as JSON. */
export type ParameterEditFailure = {
  reason: string;
  error?: { code: string; shapeId?: string; field?: string; value?: number; message?: string; parameter?: string; [key: string]: unknown };
  shapeId?: string;
  fields?: readonly string[];
  failure?: { reason: string; [key: string]: unknown };
};

/** Maps a server refusal to a catalog message. `null` means the server did not answer. */
export function parameterEditFailureMessage(failure: ParameterEditFailure | null, shapes: readonly WorkplaneShape[]): ParameterMessage {
  if (!failure) return { key: "editor.parameters.error.serverUnavailable", values: {} };
  const names = shapeNameIndex(shapes);
  const shapeName = (id: string | undefined) => (id ? names.get(id) ?? id : "");
  if (failure.reason === "parameter_invalid" && failure.error) return parameterErrorMessage(failure.error as ProjectParameterError);
  if (failure.reason === "binding_invalid" && failure.error) {
    const { code, shapeId, field = "", value } = failure.error;
    const shape = shapeName(shapeId);
    if (code === "outOfRange") return { key: "editor.parameters.error.outOfRange", values: { shape, field, value: formatParameterValue(value ?? Number.NaN) } };
    if (code === "notAnInteger") return { key: "editor.parameters.error.notAnInteger", values: { shape, field } };
    return shape ? { key: "editor.parameters.error.recomputeFailed", values: { shape, field } } : { key: "editor.parameters.error.recomputeFailedGeneric", values: {} };
  }
  if (failure.reason === "constraint_binding_invalid" && failure.error) {
    const shape = shapeName(failure.error.shapeId);
    const field = String(failure.error.constraintId ?? "");
    return shape ? { key: "editor.parameters.error.recomputeFailed", values: { shape, field } } : { key: "editor.parameters.error.recomputeFailedGeneric", values: {} };
  }
  if (failure.reason === "sketch_unsolvable") return { key: "editor.parameters.error.sketchUnsolvable", values: { shape: shapeName(failure.shapeId) } };
  if (failure.reason === "binding_failed") {
    const shape = shapeName(failure.shapeId);
    if (failure.failure?.reason === "shape_locked") return { key: "editor.parameters.error.shapeLocked", values: { shape } };
    return { key: "editor.parameters.error.recomputeFailed", values: { shape, field: (failure.fields ?? []).join(", ") } };
  }
  return { key: "editor.parameters.error.recomputeFailedGeneric", values: {} };
}

function dependsOn(shape: WorkplaneShape, names: ReadonlySet<string>) {
  const reads = (expression: string) => expressionDependencies(expression).some((name) => names.has(name));
  return Object.values(shape.expressions ?? {}).some(reads) || boundSketchConstraints(shape).some(({ expression }) => reads(expression));
}

function treeDependsOn(shape: WorkplaneShape, names: ReadonlySet<string>): boolean {
  return dependsOn(shape, names)
    || Boolean(shape.groupedShapes?.some((child) => treeDependsOn(child, names)))
    || Boolean(shape.edgeTreatmentHistory?.some((entry) => treeDependsOn(entry.before, names)));
}

function sketchSources(shape: WorkplaneShape, into = new Set<string>()) {
  if (shape.sketchSourceId) into.add(shape.sketchSourceId);
  shape.groupedShapes?.forEach((child) => sketchSources(child, into));
  return into;
}

/**
 * Picks the top-level trees a recompute must send: those with a binding that reads a changed
 * value, and trees sharing their sketch sources, which the engine rebuilds with them.
 */
export function recomputeScope(
  shapes: readonly WorkplaneShape[],
  previous: readonly ProjectParameter[],
  next: readonly ProjectParameter[],
): WorkplaneShape[] {
  const changed = new Set(changedNames(previous, next));
  const bound = shapes.filter((shape) => treeDependsOn(shape, changed));
  const sources = new Set(bound.flatMap((shape) => [...sketchSources(shape)]));
  return shapes.filter((shape) => bound.includes(shape) || [...sketchSources(shape)].some((source) => sources.has(source)));
}

/** Replaces the posted trees with the recomputed ones by id. Null when the response does not match. */
export function mergeRecomputedShapes(
  shapes: readonly WorkplaneShape[],
  posted: readonly WorkplaneShape[],
  returned: readonly WorkplaneShape[],
): WorkplaneShape[] | null {
  const byId = new Map(returned.map((shape) => [shape.id, shape]));
  if (returned.length !== posted.length || !posted.every((shape) => byId.has(shape.id))) return null;
  return shapes.map((shape) => byId.get(shape.id) ?? shape);
}

/** Maps a recompute response that is not a success to a message. */
export function parameterRecomputeResponseMessage(status: number, body: unknown, shapes: readonly WorkplaneShape[]): ParameterMessage {
  const failure = body && typeof body === "object" ? (body as { failure?: ParameterEditFailure }).failure : undefined;
  if (failure) return parameterEditFailureMessage(failure, shapes);
  if (status === 413) return { key: "editor.parameters.error.requestTooLarge", values: {} };
  if (status === 400) return { key: "editor.parameters.error.requestRejected", values: {} };
  if (status === 422 && body && typeof body === "object") return { key: "editor.parameters.error.recomputeFailedGeneric", values: {} };
  return { key: "editor.parameters.error.serverError", values: {} };
}

// Any of these means the shape's geometry comes from more than its own fields.
const KERNEL_FIELDS = [
  "importedMesh", "imagePlate", "sketchProfile", "sketchSourceId", "sketchRevolve", "draftPrismAngle", "faceDraft",
  "edgeTreatments", "edgeTreatmentHistory", "shell", "cadBrep", "cadDisplayEdges", "groupedShapes", "stepAssembly", "stepComponent",
  // A size change on these re-matches faces through the kernel.
  "faceIds", "faceColors",
] as const;

/** Reports whether a shape's geometry follows from its own fields alone, with no kernel work. */
export function plainPrimitive(shape: WorkplaneShape) {
  return (REQUESTABLE_SHAPE_KINDS as readonly string[]).includes(shape.kind)
    && KERNEL_FIELDS.every((field) => shape[field] === undefined);
}

export type LocalBindingResult =
  | { ok: true; shapes: WorkplaneShape[] }
  | { ok: false; failure: ParameterEditFailure };

/**
 * Applies a table change without the kernel when every shape it moves is a plain top-level
 * primitive. Plans with the engine's own planner, so refusals match. Null when kernel work is needed.
 */
export function applyBindingsLocally(
  shapes: readonly WorkplaneShape[],
  previous: readonly ProjectParameter[],
  next: readonly ProjectParameter[],
): LocalBindingResult | null {
  const plan = planParameterBindings(shapes, previous, next);
  if (!plan.ok) return { ok: false, failure: plan.failure };
  let result = [...shapes];
  for (const entry of plan.pending) {
    const shape = result.find((candidate) => candidate.id === entry.id);
    if (!entry.topLevel || !shape || entry.sketchProfile || !plainPrimitive(shape)) return null;
    const fields = Object.keys(entry.values);
    if (fields.some((field) => bindableField(shape, field)?.target !== "shape")) return null;
    // The engine's own-field step for a plain primitive, refused the same way.
    const changed = shapeWithRequestedChanges(shape, entry.values);
    if (!changed.ok) {
      return {
        ok: false,
        failure: {
          reason: "binding_failed",
          shapeId: entry.id,
          fields,
          failure: { reason: "unapplicable_fields", kind: shape.kind, fields: changed.unapplicable, because: "not_this_kind" },
        },
      };
    }
    result = result.map((candidate) => (candidate.id === entry.id ? changed.shape : candidate));
  }
  return { ok: true, shapes: result };
}

export type HostProjectSync = { adoptTable: boolean; action: "echo" | "unchanged" | "hydrate" };

/**
 * Decides how the editor takes a host prop update. A table it neither received nor sent is
 * a remote change: adopted with history rehydrated, so a later local undo cannot revert it.
 */
export function hostProjectSync({
  projectChanged,
  hostTableKey,
  knownTableKey,
  incomingShapesKey,
  echoShapesKey,
  currentShapesKey,
}: {
  projectChanged: boolean;
  hostTableKey: string;
  knownTableKey: string;
  incomingShapesKey: string;
  echoShapesKey: string | null;
  currentShapesKey: string;
}): HostProjectSync {
  const adoptTable = projectChanged || hostTableKey !== knownTableKey;
  if (adoptTable) return { adoptTable, action: "hydrate" };
  if (echoShapesKey !== null && incomingShapesKey === echoShapesKey) return { adoptTable, action: "echo" };
  return { adoptTable, action: incomingShapesKey === currentShapesKey ? "unchanged" : "hydrate" };
}
