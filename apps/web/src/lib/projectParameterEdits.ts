/**
 * Plans parameter table edits for the editor's parameter panel (#616).
 *
 * The table operations are the engine's own pure functions, so the panel
 * refuses exactly what REST and MCP refuse. Moving bound geometry needs the
 * engine's CAD paths, which run on the server: a plan says when it needs one.
 */

import {
  addParameter,
  deleteParameter,
  projectParameterDependents,
  renameParameter,
  updateParameter,
  type ProjectParameterError,
  type ProjectParameterResult,
} from "@constructorfleet/sketchforge-engine/projectParameters";
import { bindableField, boundFieldValue, parameterShapeDependents, resolveShapeBindings, withoutBindings } from "@constructorfleet/sketchforge-engine/expressionBindings";
import { REQUESTABLE_SHAPE_KINDS, shapeWithRequestedChanges } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { expressionDependencies, type ExpressionErrorCode } from "@constructorfleet/sketchforge-engine/parameterExpressions";
import type { MessageKey } from "@/i18n/locales";
import type { ProjectParameter, ProjectParameterDimension, WorkplaneShape } from "@/types/sketchforge";

export type ParameterProject = { parameters: ProjectParameter[]; shapes: WorkplaneShape[] };

export type ParameterEdit =
  | { kind: "add"; name: string; expression: string; dimension: ProjectParameterDimension }
  | { kind: "update"; name: string; expression?: string; dimension?: ProjectParameterDimension }
  | { kind: "rename"; name: string; newName: string }
  /** `releaseShapes` unbinds dependent shape fields first; each keeps its current number. */
  | { kind: "delete"; name: string; releaseShapes?: boolean };

export type PlannedParameterEdit =
  | { ok: true; project: ParameterProject; recompute: boolean }
  | { ok: false; error: ProjectParameterError };

export type ParameterMessage = { key: MessageKey; values: Record<string, string> };

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
      if (!edit.releaseShapes || dependents.parameters.length || !dependents.shapes.length) return deleteParameter(project, edit.name);
      return deleteParameter({ ...project, shapes: releaseShapeBindings(project.shapes, edit.name) }, edit.name);
    }
  }
}

/** Validates an edit against the engine's table rules. Changes nothing. */
export function planParameterEdit(project: ParameterProject, edit: ParameterEdit): PlannedParameterEdit {
  const result = runEdit(project, edit);
  if (!result.ok) return result;
  const next = { parameters: result.project.parameters, shapes: result.project.shapes };
  // A renamed binding keeps its value; only a stale one naming the new name can move.
  const recompute = edit.kind === "rename"
    ? edit.newName !== edit.name && parameterShapeDependents(project.shapes, edit.newName).length > 0
    : changedNames(project.parameters, next.parameters).some((name) => parameterShapeDependents(next.shapes, name).length > 0);
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
  shapes: Array<{ shapeId: string; name: string; fields: readonly string[] }>;
};

/** Lists what still references `name`, or null when it can be deleted outright. */
export function parameterDeleteWarning(project: ParameterProject, name: string): ParameterDeleteWarning | null {
  const dependents = projectParameterDependents(project, name);
  if (!dependents.parameters.length && !dependents.shapes.length) return null;
  const names = shapeNameIndex(project.shapes);
  return {
    parameters: dependents.parameters,
    shapes: dependents.shapes.map(({ shapeId, fields }) => ({ shapeId, name: names.get(shapeId) ?? shapeId, fields })),
  };
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
  error?: ParameterMessage;
};

export function parameterRows(parameters: readonly ProjectParameter[]): ParameterRow[] {
  return parameters.map((parameter) => ({
    name: parameter.name,
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
  const values = { name: error.parameter };
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
  if (failure.reason === "binding_failed") {
    const shape = shapeName(failure.shapeId);
    if (failure.failure?.reason === "shape_locked") return { key: "editor.parameters.error.shapeLocked", values: { shape } };
    return { key: "editor.parameters.error.recomputeFailed", values: { shape, field: (failure.fields ?? []).join(", ") } };
  }
  return { key: "editor.parameters.error.recomputeFailedGeneric", values: {} };
}

function dependsOn(shape: WorkplaneShape, names: ReadonlySet<string>) {
  return Object.values(shape.expressions ?? {}).some((expression) => expressionDependencies(expression).some((name) => names.has(name)));
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
] as const;

function plainPrimitive(shape: WorkplaneShape) {
  return (REQUESTABLE_SHAPE_KINDS as readonly string[]).includes(shape.kind)
    && KERNEL_FIELDS.every((field) => shape[field] === undefined);
}

export type LocalBindingResult =
  | { ok: true; shapes: WorkplaneShape[] }
  | { ok: false; failure: ParameterEditFailure };

/**
 * Applies a table change to bound plain primitives without the kernel, with the engine's
 * range, lock and stale rules. Null when any dependent needs the engine's CAD paths.
 */
export function applyBindingsLocally(
  shapes: readonly WorkplaneShape[],
  previous: readonly ProjectParameter[],
  next: readonly ProjectParameter[],
): LocalBindingResult | null {
  const changed = new Set(changedNames(previous, next));
  const result: WorkplaneShape[] = [];
  for (const shape of shapes) {
    if (!treeDependsOn(shape, changed)) {
      result.push(shape);
      continue;
    }
    if (!plainPrimitive(shape)) return null;
    const fields = Object.entries(shape.expressions ?? {})
      .filter(([, expression]) => expressionDependencies(expression).some((name) => changed.has(name)))
      .map(([field]) => field);
    if (fields.some((field) => bindableField(shape, field)?.target === "feature")) return null;
    const resolved = resolveShapeBindings(shape, next);
    const earlier = resolveShapeBindings(shape, previous);
    const values: Record<string, number> = {};
    for (const field of fields) {
      const outcome = resolved.get(field);
      if (!outcome) continue;
      if (!outcome.ok) {
        // Refuses only a binding this change breaks; one already stale stays stale.
        if (earlier.get(field)?.ok) return { ok: false, failure: { reason: "binding_invalid", error: outcome.error } };
        continue;
      }
      if (boundFieldValue(shape, field) !== outcome.value) values[field] = outcome.value;
    }
    if (!Object.keys(values).length) {
      result.push(shape);
      continue;
    }
    if (shape.locked) {
      return { ok: false, failure: { reason: "binding_failed", shapeId: shape.id, fields: Object.keys(values), failure: { reason: "shape_locked", ids: [shape.id] } } };
    }
    const changedShape = shapeWithRequestedChanges(shape, values);
    if (!changedShape.ok) return null;
    result.push(changedShape.shape);
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
