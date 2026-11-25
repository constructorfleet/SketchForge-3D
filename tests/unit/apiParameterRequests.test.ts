import { describe, expect, it } from "vitest";
import { API_V1_OPERATIONS } from "@/lib/apiV1OperationContract";
import { API_ERROR_CODES, API_QUERY_RULES, API_REQUEST_BODIES } from "@constructorfleet/sketchforge-engine/apiRequestDefinitions";

/** The engine checks run the request definitions; the contract has to publish those same objects. */
function operation(operationId: string) {
  const found = API_V1_OPERATIONS.find((item) => item.operationId === operationId);
  if (!found) throw new Error(`No operation ${operationId}.`);
  return found;
}

describe("request definitions", () => {
  it("are the request schemas the contract publishes", () => {
    for (const [operationId, definition] of Object.entries(API_REQUEST_BODIES)) {
      const body = operation(operationId).requestBody as { schema?: unknown } | undefined;
      expect(body?.schema, operationId).toBe(definition);
    }
  });

  it("are the query rules the contract publishes", () => {
    const rules = (operationId: string) => operation(operationId).query!.properties;
    expect(rules("updateParameter").name).toBe(API_QUERY_RULES.parameterName);
    expect(rules("deleteParameter").name).toBe(API_QUERY_RULES.parameterName);
    expect(rules("updateParameterConfiguration").name).toBe(API_QUERY_RULES.configurationName);
    expect(rules("deleteParameterConfiguration").name).toBe(API_QUERY_RULES.configurationName);
    expect(rules("bindSketchConstraint").constraintId).toBe(API_QUERY_RULES.constraintId);
    expect(rules("bindSketchConstraint").shapeId).toBe(API_QUERY_RULES.shapeId);
    for (const item of API_V1_OPERATIONS) {
      const projectId = item.query?.properties.projectId;
      if (!projectId) continue;
      const { description: _description, ...rule } = projectId;
      expect(rule, item.operationId).toEqual(API_QUERY_RULES.projectId);
    }
  });

  it("supply the error codes the contract publishes", () => {
    const errorSchema = operation("createParameter").responseSchemas![401] as { properties: { code: { enum: unknown } } };
    expect(errorSchema.properties.code.enum).toBe(API_ERROR_CODES);
  });
});
