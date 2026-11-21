import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody } from "@/lib/apiV1";
import { parseApiV1Query, withApiV1Contract } from "@/lib/apiV1OperationContract";
// The engine's checks, not the contract schema, so MCP local mode can refuse the same bodies.
import {
  API_CONFIGURATION_MESSAGES,
  apiConfigurationList,
  apiConfigurationsWritten as written,
  isApiConfigurationChangeRequest,
  isApiConfigurationCreateRequest,
} from "@constructorfleet/sketchforge-engine/apiParameters";

export const runtime = "nodejs";
export const revalidate = false;

function invalidQuery(invalid: readonly string[]) {
  return invalid.includes("projectId") ? apiErrors.invalidProjectId() : apiError(API_CONFIGURATION_MESSAGES.nameRequired, 400, "invalid_request");
}

async function getHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("GET /api/v1/parameter-configurations", request);
  if (!query.ok) return invalidQuery(query.invalid);

  const project = await apiEngine(context.root, request).project(query.values.projectId!);
  if (!project.ok) return apiEngineError(project.failure);
  return apiJson(apiConfigurationList(project.value));
}

async function postHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("POST /api/v1/parameter-configurations", request);
  if (!query.ok) return invalidQuery(query.invalid);
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  if (!isApiConfigurationCreateRequest(body)) return apiError(API_CONFIGURATION_MESSAGES.create, 400, "invalid_request");

  const added = await apiEngine(context.root, request).addConfiguration(query.values.projectId!, body.name, body.overrides);
  if (!added.ok) return apiEngineError(added.failure);
  return apiJson(written(added.value, body.name), 201);
}

/** Renames with `{ name }`; otherwise sets `{ parameter, expression }`, or clears it for a null expression. */
async function patchHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("PATCH /api/v1/parameter-configurations", request);
  if (!query.ok) return invalidQuery(query.invalid);
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  if (!isApiConfigurationChangeRequest(body)) return apiError(API_CONFIGURATION_MESSAGES.change, 400, "invalid_request");

  const { projectId, name } = query.values as { projectId: string; name: string };
  const engine = apiEngine(context.root, request);
  if ("name" in body) {
    const renamed = await engine.renameConfiguration(projectId, name, body.name);
    if (!renamed.ok) return apiEngineError(renamed.failure);
    return apiJson(written(renamed.value, body.name));
  }
  const changed = body.expression === null
    ? await engine.clearConfigurationOverride(projectId, name, body.parameter)
    : await engine.setConfigurationOverride(projectId, name, body.parameter, body.expression);
  if (!changed.ok) return apiEngineError(changed.failure);
  return apiJson(written(changed.value, name));
}

async function deleteHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("DELETE /api/v1/parameter-configurations", request);
  if (!query.ok) return invalidQuery(query.invalid);

  const { projectId, name } = query.values as { projectId: string; name: string };
  const removed = await apiEngine(context.root, request).deleteConfiguration(projectId, name);
  if (!removed.ok) return apiEngineError(removed.failure);
  return apiJson({ deleted: true, name, ...written(removed.value) });
}

export const GET = withApiV1Contract("GET /api/v1/parameter-configurations", getHandler);

export const POST = withApiV1Contract("POST /api/v1/parameter-configurations", postHandler);

export const PATCH = withApiV1Contract("PATCH /api/v1/parameter-configurations", patchHandler);

export const DELETE = withApiV1Contract("DELETE /api/v1/parameter-configurations", deleteHandler);
