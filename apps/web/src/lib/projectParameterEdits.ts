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
import { parameterShapeDependents, withoutBindings } from "@constructorfleet/sketchforge-engine/expressionBindings";
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
