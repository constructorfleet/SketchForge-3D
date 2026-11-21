/**
 * Runs the parameter and expression tools against the local engine or REST v1.
 * Both modes refuse with the REST error code, so a caller handles one set of codes.
 */

export const PARAMETER_TOOL_NAMES = new Set([
  "sketchforge_list_parameters",
  "sketchforge_set_parameter",
  "sketchforge_rename_parameter",
  "sketchforge_delete_parameter",
  "sketchforge_set_shape_expression",
]);

const CREATE_HINT = "Pass expression and dimension together to create it.";

/** Formats as `message [code]`, then the detail JSON on the next line. */
export class McpToolError extends Error {
  constructor(headline, code, detail = {}) {
    const extra = Object.keys(detail).length ? `\n${JSON.stringify(detail)}` : "";
    super(`${headline}${code ? ` [${code}]` : ""}${extra}`);
    this.headline = headline;
    this.code = code;
    this.detail = detail;
  }
}

function withCreateHint(error) {
  if (!(error instanceof McpToolError) || error.code !== "parameter_not_found") return error;
  return new McpToolError(`${error.headline} ${CREATE_HINT}`, error.code, error.detail);
}

function requireText(args, key) {
  if (typeof args[key] !== "string" || !args[key].trim()) throw new McpToolError(`${key} is required.`, "invalid_request");
  return args[key];
}

function requireBinding(args) {
  const shapeId = requireText(args, "shapeId");
  const field = requireText(args, "field");
  if (args.expression !== null && typeof args.expression !== "string") {
    throw new McpToolError("expression is required: an expression string, or null to clear the binding.", "invalid_request");
  }
  return { shapeId, field, expression: args.expression };
}

/** Splits a set request into a create (both fields) or a change (either one). */
function parameterChanges(args) {
  const changes = {
    ...(typeof args.expression === "string" ? { expression: args.expression } : {}),
    ...(typeof args.dimension === "string" ? { dimension: args.dimension } : {}),
  };
  if (!Object.keys(changes).length) throw new McpToolError("Pass expression, dimension, or both.", "invalid_request");
  return { changes, create: "expression" in changes && "dimension" in changes };
}

// Mirrors apps/web/src/lib/apiEngine.ts so local and remote refusals carry the same code.
const PARAMETER_ERROR_CODES = {
  invalidParameter: "invalid_request",
  invalidName: "invalid_request",
  invalidDimension: "invalid_request",
  duplicateName: "parameter_exists",
  unknownParameter: "parameter_not_found",
  parameterInUse: "parameter_in_use",
  invalidExpression: "invalid_expression",
  tooManyParameters: "limit_exceeded",
};

function wireExpressionError(error) {
  return {
    code: error.code,
    message: error.message,
    span: { start: error.span.start, end: error.span.end },
    ...(error.cycle ? { cycle: [...error.cycle] } : {}),
  };
}

function bindingDetail(error, index) {
  return {
    ...(index === undefined ? { shapeId: error.shapeId } : { index }),
    field: error.field,
    reason: error.code,
    ...(error.expressionError ? { expressionError: wireExpressionError(error.expressionError) } : {}),
    ...Object.fromEntries(["value", "min", "max", "stored"].filter((key) => typeof error[key] === "number").map((key) => [key, error[key]])),
  };
}

/** Maps an engine failure to the REST code and detail fields. */
export function engineFailureError(failure, detail = {}) {
  switch (failure.reason) {
    case "parameter_invalid": {
      const { error } = failure;
      return new McpToolError(error.message, PARAMETER_ERROR_CODES[error.code], {
        parameter: error.parameter,
        reason: error.code,
        ...(error.expressionError ? { expressionError: wireExpressionError(error.expressionError) } : {}),
        ...(error.code === "parameterInUse" ? {
          dependents: [...(error.dependents ?? [])],
          shapeDependents: (error.shapeDependents ?? []).map(({ shapeId, fields }) => ({ shapeId, fields: [...fields] })),
        } : {}),
        ...detail,
      });
    }
    case "binding_invalid": {
      const { error } = failure;
      const fields = bindingDetail(error, failure.index);
      if (error.code === "shapeNotFound") return new McpToolError(error.message, "shape_not_found", { ...fields, ...detail });
      if (error.code === "fieldNotBindable") return new McpToolError(error.message, "unapplicable_fields", { ...fields, fields: [error.field], ...detail });
      return new McpToolError(error.message, "invalid_expression", { ...fields, ...detail });
    }
    case "binding_failed":
      return engineFailureError(failure.failure, {
        ...detail,
        ...(failure.index === undefined ? { shapeId: failure.shapeId } : { index: failure.index }),
        fields: [...failure.fields],
      });
    case "shape_locked":
      return new McpToolError("That shape is locked. Unlock it with sketchforge_update_object locked: false.", "shape_locked", detail);
    case "project_not_found":
      return new McpToolError("That project is not in the project directory.", "project_not_found", detail);
    case "project_busy":
      return new McpToolError("That project is being changed; try again.", "project_busy", detail);
    case "shapes_not_found":
      return new McpToolError(`Not in the project: ${failure.ids.join(", ")}.`, "shape_not_found", detail);
    case "unapplicable_fields":
      return new McpToolError(`A shape of kind "${failure.kind}" cannot take: ${failure.fields.join(", ")}.`, "unapplicable_fields", { fields: failure.fields, ...detail });
    case "invalid_shape_request":
      return new McpToolError(failure.message, "invalid_request", {
        ...(failure.shapeId === undefined ? {} : { shapeId: failure.shapeId }),
        ...(failure.field === undefined ? {} : { field: failure.field }),
        ...detail,
      });
    default:
      return new McpToolError(`Engine operation failed: ${JSON.stringify(failure)}`, undefined, detail);
  }
}

async function unwrap(result) {
  if (result.ok) return result.value;
  throw engineFailureError(result.failure);
}

/** A stale entry's NaN reads as null, as REST writes it. */
function wireParameter(parameter) {
  const issue = parameter.error;
  return {
    name: parameter.name,
    expression: parameter.expression,
    dimension: parameter.dimension,
    value: Number.isFinite(parameter.value) ? parameter.value : null,
    ...(issue ? { error: { code: issue.code, message: issue.message, ...(issue.expressionError ? { expressionError: wireExpressionError(issue.expressionError) } : {}) } } : {}),
  };
}

function written(value, name, summarize) {
  const parameter = value.parameters.find((entry) => entry.name === name);
  return {
    ...(parameter ? { parameter: wireParameter(parameter) } : {}),
    parameters: value.parameters.map(wireParameter),
    shapes: value.shapes.map(summarize),
    revision: value.revision,
  };
}

/** Runs one parameter tool on the local engine. `summarize` shapes each returned shape. */
export async function callLocalParameterTool(name, args, { engine, enginePackage, projectId, summarize }) {
  switch (name) {
    case "sketchforge_list_parameters": {
      const project = await unwrap(await engine.project(projectId));
      return {
        parameters: project.parameters.map(wireParameter),
        bindingIssues: enginePackage.shapeBindingIssues(project.shapes, project.parameters).map((issue) => ({
          shapeId: issue.shapeId,
          field: issue.field,
          code: issue.code,
          message: issue.message,
          ...(issue.expressionError ? { expressionError: wireExpressionError(issue.expressionError) } : {}),
        })),
        revision: project.revision,
      };
    }
    case "sketchforge_set_parameter": {
      const parameterName = requireText(args, "name");
      const { changes, create } = parameterChanges(args);
      if (create) {
        const added = await engine.addParameter(projectId, { name: parameterName, ...changes });
        if (added.ok) return { created: true, ...written(added.value, parameterName, summarize) };
        if (added.failure.reason !== "parameter_invalid" || added.failure.error.code !== "duplicateName") throw engineFailureError(added.failure);
      }
      try {
        return { created: false, ...written(await unwrap(await engine.updateParameter(projectId, parameterName, changes)), parameterName, summarize) };
      } catch (error) {
        throw create ? error : withCreateHint(error);
      }
    }
    case "sketchforge_rename_parameter": {
      const newName = requireText(args, "newName");
      return written(await unwrap(await engine.renameParameter(projectId, requireText(args, "name"), newName)), newName, summarize);
    }
    case "sketchforge_delete_parameter": {
      const parameterName = requireText(args, "name");
      const { parameters, shapes, revision } = written(await unwrap(await engine.deleteParameter(projectId, parameterName)), parameterName, summarize);
      return { deleted: true, name: parameterName, parameters, shapes, revision };
    }
    case "sketchforge_set_shape_expression": {
      const { shapeId, field, expression } = requireBinding(args);
      // changeShape, not bindShapeField: the same path as PATCH /shapes, so refusals match.
      const changed = await unwrap(await engine.changeShape(projectId, shapeId, { expressions: { [field]: expression } }));
      return { shape: summarize(changed.shape), revision: changed.revision };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Runs one parameter tool over REST v1. `request(method, path, { query, body })` throws McpToolError. */
export async function callRemoteParameterTool(name, args, request) {
  const projectId = args.projectId;
  switch (name) {
    case "sketchforge_list_parameters":
      return request("GET", "/parameters", { query: { projectId } });
    case "sketchforge_set_parameter": {
      const parameterName = requireText(args, "name");
      const { changes, create } = parameterChanges(args);
      if (create) {
        try {
          return { created: true, ...await request("POST", "/parameters", { query: { projectId }, body: { name: parameterName, ...changes } }) };
        } catch (error) {
          if (!(error instanceof McpToolError) || error.code !== "parameter_exists") throw error;
        }
      }
      try {
        return { created: false, ...await request("PATCH", "/parameters", { query: { projectId, name: parameterName }, body: changes }) };
      } catch (error) {
        throw create ? error : withCreateHint(error);
      }
    }
    case "sketchforge_rename_parameter":
      return request("PATCH", "/parameters", {
        query: { projectId, name: requireText(args, "name") },
        body: { name: requireText(args, "newName") },
      });
    case "sketchforge_delete_parameter":
      return request("DELETE", "/parameters", { query: { projectId, name: requireText(args, "name") } });
    case "sketchforge_set_shape_expression": {
      const { shapeId, field, expression } = requireBinding(args);
      return request("PATCH", "/shapes", { query: { projectId, shapeId }, body: { expressions: { [field]: expression } } });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
