/**
 * Runs the parameter and expression tools over REST v1, or over the local engine.
 *
 * Both modes run one tool flow against a `request(method, path, { query, body })`.
 * Local mode answers it with the engine's own REST helpers (`apiErrors`,
 * `apiParameters`, `apiShapeSummary`), so replies and refusals match.
 */

export const PARAMETER_TOOL_NAMES = new Set([
  "sketchforge_list_parameters",
  "sketchforge_set_parameter",
  "sketchforge_rename_parameter",
  "sketchforge_delete_parameter",
  "sketchforge_set_shape_expression",
  "sketchforge_bind_sketch_constraint",
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

/** Reads shapeId, the named target and an expression string or null. */
function requireBinding(args, target = "field") {
  const shapeId = requireText(args, "shapeId");
  const bound = requireText(args, target);
  if (args.expression !== null && typeof args.expression !== "string") {
    throw new McpToolError("expression is required: an expression string, or null to clear the binding.", "invalid_request");
  }
  return { shapeId, bound, expression: args.expression };
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

/** Runs one parameter tool. `request` throws McpToolError for a refusal. */
export async function callParameterTool(name, args, request) {
  const projectId = args.projectId;
  switch (name) {
    case "sketchforge_list_parameters":
      return request("GET", "/parameters", { query: { projectId } });
    case "sketchforge_set_parameter": {
      const parameterName = requireText(args, "name");
      const { changes, create } = parameterChanges(args);
      // An upsert: an existing name is overwritten, not refused.
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
      const { shapeId, bound: field, expression } = requireBinding(args);
      return request("PATCH", "/shapes", { query: { projectId, shapeId }, body: { expressions: { [field]: expression } } });
    }
    case "sketchforge_bind_sketch_constraint": {
      const { shapeId, bound: constraintId, expression } = requireBinding(args, "constraintId");
      return request("PATCH", "/sketch-constraints", { query: { projectId, shapeId, constraintId }, body: { expression } });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** A query value as the URL carries it: absent, or a string. */
function queryText(value) {
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Answers the requests `callParameterTool` makes, as the REST v1 routes do.
 * `api` is the engine package; its helpers are the ones the routes call.
 */
export function localParameterRequest(engine, api) {
  const refusal = (reply) => new McpToolError(reply.message, reply.code, reply.detail);
  const unwrap = async (result, toError = (failure) => api.engineFailureToApiError(failure)) => {
    if (result.ok) return result.value;
    throw refusal(toError(result.failure));
  };
  const requireProject = (query) => {
    const projectId = api.apiProjectId(queryText(query.projectId));
    if (!projectId) throw new McpToolError(api.API_ERROR_MESSAGES.invalidProjectId, "invalid_project_id");
    return projectId;
  };
  const requireShape = (query) => {
    const shapeId = api.apiShapeId(queryText(query.shapeId));
    if (!shapeId) throw new McpToolError(api.API_ERROR_MESSAGES.shapeIdRequired, "invalid_shape_id");
    return shapeId;
  };
  const requireName = (query) => {
    const parameterName = api.apiParameterName(queryText(query.name));
    if (!parameterName) throw new McpToolError(api.API_PARAMETER_MESSAGES.nameRequired, "invalid_request");
    return parameterName;
  };

  return async function request(method, route, { query = {}, body } = {}) {
    // The same JSON a remote call would carry: undefined fields drop out.
    const sent = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
    switch (`${method} ${route}`) {
      case "GET /parameters":
        return api.apiParameterList(await unwrap(await engine.project(requireProject(query))));
      case "POST /parameters": {
        const projectId = requireProject(query);
        if (!api.isApiParameterCreateRequest(sent)) throw new McpToolError(api.API_PARAMETER_MESSAGES.create, "invalid_request");
        return api.apiParametersWritten(await unwrap(await engine.addParameter(projectId, sent)), sent.name);
      }
      case "PATCH /parameters": {
        const projectId = requireProject(query);
        const parameterName = requireName(query);
        if (!api.isApiParameterChangeRequest(sent)) throw new McpToolError(api.API_PARAMETER_MESSAGES.change, "invalid_request");
        if (typeof sent.name === "string") {
          return api.apiParametersWritten(await unwrap(await engine.renameParameter(projectId, parameterName, sent.name)), sent.name);
        }
        return api.apiParametersWritten(await unwrap(await engine.updateParameter(projectId, parameterName, sent)), parameterName);
      }
      case "DELETE /parameters": {
        const projectId = requireProject(query);
        const parameterName = requireName(query);
        const { parameters, shapes, revision } = api.apiParametersWritten(await unwrap(await engine.deleteParameter(projectId, parameterName)), parameterName);
        return { deleted: true, name: parameterName, parameters, shapes, revision };
      }
      case "PATCH /shapes": {
        const projectId = requireProject(query);
        const shapeId = requireShape(query);
        const changed = await unwrap(
          await engine.changeShape(projectId, shapeId, sent),
          (failure) => api.shapeChangeApiError(failure, shapeId),
        );
        return { shape: api.apiShapeSummary(changed.shape), revision: changed.revision };
      }
      case "PATCH /sketch-constraints": {
        const projectId = requireProject(query);
        const shapeId = requireShape(query);
        const constraintId = api.apiConstraintId(queryText(query.constraintId));
        if (!constraintId) throw new McpToolError(api.API_SKETCH_CONSTRAINT_MESSAGES.constraintIdRequired, "invalid_request");
        if (!api.isApiSketchConstraintBindRequest(sent)) throw new McpToolError(api.API_SKETCH_CONSTRAINT_MESSAGES.body, "invalid_request");
        const bound = await unwrap(
          await engine.bindSketchConstraint(projectId, shapeId, constraintId, sent.expression),
          (failure) => api.engineFailureToApiError(failure, api.SKETCH_CONSTRAINT_WORDING),
        );
        return api.apiSketchConstraintBound(bound, constraintId);
      }
      default:
        throw new Error(`No local route for ${method} ${route}.`);
    }
  };
}
