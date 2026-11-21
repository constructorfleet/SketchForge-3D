import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiError, apiErrors, apiJson, apiJsonBody } from "@/lib/apiV1";
import { parseApiV1Query, withApiV1Contract } from "@/lib/apiV1OperationContract";
import {
  API_CONFIGURATION_MESSAGES,
  apiConfigurationsWritten,
  isApiConfigurationActivateRequest,
} from "@constructorfleet/sketchforge-engine/apiParameters";

export const runtime = "nodejs";
export const revalidate = false;

async function postHandler(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const query = parseApiV1Query("POST /api/v1/parameter-configurations/activate", request);
  if (!query.ok) return apiErrors.invalidProjectId();
  const body = await apiJsonBody(request);
  if (body instanceof Response) return body;
  if (!body) return apiErrors.jsonBodyRequired();
  if (!isApiConfigurationActivateRequest(body)) return apiError(API_CONFIGURATION_MESSAGES.activate, 400, "invalid_request");

  const activated = await apiEngine(context.root, request).activateConfiguration(query.values.projectId!, body.name);
  if (!activated.ok) return apiEngineError(activated.failure);
  return apiJson(apiConfigurationsWritten(activated.value));
}

export const POST = withApiV1Contract("POST /api/v1/parameter-configurations/activate", postHandler);
