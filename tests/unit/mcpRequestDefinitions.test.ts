import { describe, expect, it } from "vitest";
import {
  API_QUERY_RULES,
  API_REQUEST_BODIES,
  API_REQUEST_FIELDS,
  apiJsonSchema,
  apiQueryJsonSchema,
  type ApiSchema,
} from "@constructorfleet/sketchforge-engine/apiRequestDefinitions";
// @ts-expect-error - the MCP bridge and its helpers are plain ESM scripts with no types.
import { engineTools } from "../../packages/sketchforge-client/mcp/toolCatalog.mjs";

const { parameterName, parameterExpression, parameterDimension, configurationName } = API_REQUEST_FIELDS;
const body = (schema: ApiSchema) => apiJsonSchema(schema);
const bodies = API_REQUEST_BODIES;
const query = (rule: Parameters<typeof apiQueryJsonSchema>[0]) => apiQueryJsonSchema(rule);

/** Each argument the tool sends to a request check, and the definition that check runs. */
const ARGUMENTS: Record<string, Record<string, unknown>> = {
  sketchforge_set_parameter: { name: body(parameterName), expression: body(parameterExpression), dimension: body(parameterDimension) },
  sketchforge_rename_parameter: { name: query(API_QUERY_RULES.parameterName), newName: body(parameterName) },
  sketchforge_delete_parameter: { name: query(API_QUERY_RULES.parameterName) },
  sketchforge_bind_sketch_constraint: { constraintId: query(API_QUERY_RULES.constraintId), expression: body(bodies.bindSketchConstraint.properties.expression) },
  sketchforge_create_parameter_configuration: {
    name: body(configurationName),
    overrides: body(bodies.createParameterConfiguration.properties.overrides),
  },
  sketchforge_rename_parameter_configuration: { name: query(API_QUERY_RULES.configurationName), newName: body(configurationName) },
  sketchforge_set_configuration_override: {
    name: query(API_QUERY_RULES.configurationName),
    parameter: body(parameterName),
    expression: body(bodies.updateParameterConfiguration.oneOf[1].properties.expression),
  },
  sketchforge_delete_parameter_configuration: { name: query(API_QUERY_RULES.configurationName) },
  sketchforge_activate_parameter_configuration: { name: body(bodies.activateParameterConfiguration.properties.name) },
};

const withoutDescription = (schema: unknown) => {
  const { description: _description, ...rest } = schema as Record<string, unknown>;
  return rest;
};

describe("MCP parameter tool schemas", () => {
  it("advertise the engine's request definitions", () => {
    for (const [toolName, expected] of Object.entries(ARGUMENTS)) {
      const tool = engineTools.find((candidate: { name: string }) => candidate.name === toolName);
      expect(tool, toolName).toBeDefined();
      for (const [argument, schema] of Object.entries(expected)) {
        const advertised = tool.inputSchema.properties[argument];
        expect(withoutDescription(advertised), `${toolName}.${argument}`).toEqual(withoutDescription(schema));
        expect(typeof advertised.description, `${toolName}.${argument} keeps its tool description`).toBe("string");
      }
    }
  });
});
