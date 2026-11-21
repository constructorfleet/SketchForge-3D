import { apiEngine, apiEngineError, wireExpressionError } from "@/lib/apiEngine";
import { apiShapeSummary } from "@/lib/apiShapes";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody } from "@/lib/apiV1";
import { parseApiV1Query, validateApiV1RequestBody, withApiV1Contract } from "@/lib/apiV1OperationContract";
import type { ParametersWritten } from "@/lib/engine/engine";
import { shapeBindingIssues } from "@constructorfleet/sketchforge-engine/expressionBindings";
import type { ProjectParameter, ProjectParameterDimension } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import type { ExpressionError } from "@constructorfleet/sketchforge-engine/parameterExpressions";

export const runtime = "nodejs";
export const revalidate = false;

function apiIssue({ code, message, expressionError }: { code: string; message: string; expressionError?: ExpressionError }) {
  return { code, message, ...(expressionError ? { expressionError: wireExpressionError(expressionError) } : {}) };
}

/** Serializes one table entry. A stale entry's NaN becomes null, which JSON would write anyway. */
function apiParameter(parameter: ProjectParameter) {
  return {
    name: parameter.name,
    expression: parameter.expression,
    dimension: parameter.dimension,
    value: Number.isFinite(parameter.value) ? parameter.value : null,
    ...(parameter.error ? { error: apiIssue(parameter.error) } : {}),
  };
}

function written(value: ParametersWritten, name: string) {
  const parameter = value.parameters.find((entry) => entry.name === name);
  return {
    ...(parameter ? { parameter: apiParameter(parameter) } : {}),
    parameters: value.parameters.map(apiParameter),
    shapes: value.shapes.map(apiShapeSummary),
    revision: value.revision,
  };
}

function invalidQuery(invalid: readonly string[]) {
  return invalid.includes("projectId") ? apiErrors.invalidProjectId() : apiError("A parameter name is required.", 400, "invalid_request");
}

async function getHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("GET /api/v1/parameters", request);
  if (!query.ok) return invalidQuery(query.invalid);

  const project = await apiEngine(context.root, request).project(query.values.projectId!);
  if (!project.ok) return apiEngineError(project.failure);
  const { parameters, shapes, revision } = project.value;
  return apiJson({
    parameters: parameters.map(apiParameter),
    bindingIssues: shapeBindingIssues(shapes, parameters).map((issue) => ({ shapeId: issue.shapeId, field: issue.field, ...apiIssue(issue) })),
    revision,
  });
}

async function postHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("POST /api/v1/parameters", request);
  if (!query.ok) return invalidQuery(query.invalid);
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  if (!validateApiV1RequestBody("POST /api/v1/parameters", body)) {
    return apiError("A parameter needs a name, an expression, and a dimension of length, angle, or unitless.", 400, "invalid_request");
  }

  const name = body.name as string;
  const added = await apiEngine(context.root, request).addParameter(query.values.projectId!, {
    name,
    expression: body.expression as string,
    dimension: body.dimension as ProjectParameterDimension,
  });
  if (!added.ok) return apiEngineError(added.failure);
  return apiJson(written(added.value, name), 201);
}

/** Renames with `{ name }` alone; otherwise changes the expression, the dimension, or both. */
async function patchHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("PATCH /api/v1/parameters", request);
  if (!query.ok) return invalidQuery(query.invalid);
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  if (!validateApiV1RequestBody("PATCH /api/v1/parameters", body)) {
    return apiError("Send name alone to rename, or expression and dimension to change the value.", 400, "invalid_request");
  }

  const { projectId, name } = query.values as { projectId: string; name: string };
  const engine = apiEngine(context.root, request);
  if (typeof body.name === "string") {
    const renamed = await engine.renameParameter(projectId, name, body.name);
    if (!renamed.ok) return apiEngineError(renamed.failure);
    return apiJson(written(renamed.value, body.name));
  }
  const changed = await engine.updateParameter(projectId, name, {
    ...(typeof body.expression === "string" ? { expression: body.expression } : {}),
    ...(typeof body.dimension === "string" ? { dimension: body.dimension as ProjectParameterDimension } : {}),
  });
  if (!changed.ok) return apiEngineError(changed.failure);
  return apiJson(written(changed.value, name));
}

async function deleteHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("DELETE /api/v1/parameters", request);
  if (!query.ok) return invalidQuery(query.invalid);

  const { projectId, name } = query.values as { projectId: string; name: string };
  const removed = await apiEngine(context.root, request).deleteParameter(projectId, name);
  if (!removed.ok) return apiEngineError(removed.failure);
  const { parameters, shapes, revision } = written(removed.value, name);
  return apiJson({ deleted: true, name, parameters, shapes, revision });
}

export const GET = withApiV1Contract("GET /api/v1/parameters", getHandler);

export const POST = withApiV1Contract("POST /api/v1/parameters", postHandler);

export const PATCH = withApiV1Contract("PATCH /api/v1/parameters", patchHandler);

export const DELETE = withApiV1Contract("DELETE /api/v1/parameters", deleteHandler);
