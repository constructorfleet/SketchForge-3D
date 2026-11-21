import { describe, expect, it } from "vitest";
import { API_V1_OPERATIONS, validateApiV1Schema, type ApiV1FieldSchema } from "@/lib/apiV1OperationContract";
import {
  API_CONFIGURATION_NAME_MAX_LENGTH,
  API_PARAMETER_EXPRESSION_MAX_LENGTH,
  API_PARAMETER_NAME_MAX_LENGTH,
  apiParameterName,
  isApiConfigurationActivateRequest,
  isApiConfigurationChangeRequest,
  isApiConfigurationCreateRequest,
  isApiParameterChangeRequest,
  isApiParameterCreateRequest,
} from "@constructorfleet/sketchforge-engine/apiParameters";
import { API_CONSTRAINT_ID_MAX_LENGTH, apiConstraintId, isApiSketchConstraintBindRequest } from "@constructorfleet/sketchforge-engine/apiSketchConstraints";

/** The routes validate with the engine's checks; the published schema has to say the same thing. */
function schemaFor(key: string) {
  const operation = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === key);
  const body = operation?.requestBody as { schema?: ApiV1FieldSchema } | undefined;
  if (!body?.schema) throw new Error(`${key} has no request schema.`);
  return body.schema;
}

const long = "x".repeat(API_PARAMETER_EXPRESSION_MAX_LENGTH);
const bodies: unknown[] = [
  {},
  { name: "wall" },
  { name: "" },
  { name: "x".repeat(API_PARAMETER_NAME_MAX_LENGTH) },
  { name: "x".repeat(API_PARAMETER_NAME_MAX_LENGTH + 1) },
  { name: 5 },
  { name: "wall", expression: "2" },
  { name: "wall", expression: "2", dimension: "length" },
  { name: "wall", expression: "2", dimension: "angle", extra: true },
  { name: "wall", expression: "", dimension: "length" },
  { name: "wall", expression: "   ", dimension: "unitless" },
  { name: "wall", expression: long, dimension: "unitless" },
  { name: "wall", expression: `${long}1`, dimension: "unitless" },
  { name: "wall", expression: "2", dimension: "bogus" },
  { name: "wall", expression: null, dimension: "length" },
  { expression: "2" },
  { expression: "" },
  { dimension: "angle" },
  { dimension: "bogus" },
  { expression: "2", dimension: "length" },
  { expression: "2", other: 1 },
];

describe("parameter request checks", () => {
  it("agree with the published POST and PATCH schemas", () => {
    const create = schemaFor("POST /api/v1/parameters");
    const change = schemaFor("PATCH /api/v1/parameters");
    for (const body of bodies) {
      expect(isApiParameterCreateRequest(body), `POST ${JSON.stringify(body).slice(0, 80)}`).toBe(validateApiV1Schema(body, create));
      expect(isApiParameterChangeRequest(body), `PATCH ${JSON.stringify(body).slice(0, 80)}`).toBe(validateApiV1Schema(body, change));
    }
  });

  it("trims a query name and bounds its length as the contract does", () => {
    const rule = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === "PATCH /api/v1/parameters")!.query!.properties.name as { minLength: number; maxLength: number };
    expect(rule.maxLength).toBe(API_PARAMETER_NAME_MAX_LENGTH);
    expect(apiParameterName(" wall ")).toBe("wall");
    expect(apiParameterName("   ")).toBeUndefined();
    expect(apiParameterName("x".repeat(rule.maxLength + 1))).toBeUndefined();
  });

  it("agree with the published sketch constraint body schema and constraintId rule", () => {
    const key = "PATCH /api/v1/sketch-constraints";
    const schema = schemaFor(key);
    for (const body of [...bodies, { expression: null }, { expression: null, other: 1 }, { expression: 5 }, { expression: "w", name: "x" }]) {
      expect(isApiSketchConstraintBindRequest(body), `${key} ${JSON.stringify(body).slice(0, 80)}`).toBe(validateApiV1Schema(body, schema));
    }
    const rule = API_V1_OPERATIONS.find((item) => `${item.method} ${item.path}` === key)!.query!.properties.constraintId as { maxLength: number };
    expect(rule.maxLength).toBe(API_CONSTRAINT_ID_MAX_LENGTH);
    expect(apiConstraintId(" width ")).toBe("width");
    expect(apiConstraintId(" ")).toBeUndefined();
    expect(apiConstraintId("x".repeat(rule.maxLength + 1))).toBeUndefined();
  });

  it("agree with the published configuration schemas", () => {
    const create = schemaFor("POST /api/v1/parameter-configurations");
    const change = schemaFor("PATCH /api/v1/parameter-configurations");
    const activate = schemaFor("POST /api/v1/parameter-configurations/activate");
    const configurationBodies: unknown[] = [
      ...bodies,
      [],
      null,
      { name: "x".repeat(API_CONFIGURATION_NAME_MAX_LENGTH) },
      { name: "x".repeat(API_CONFIGURATION_NAME_MAX_LENGTH + 1) },
      { name: null },
      { name: "Large", overrides: {} },
      { name: "Large", overrides: { wall: "4" } },
      { name: "Large", overrides: { wall: 4 } },
      { name: "Large", overrides: { wall: " " } },
      { name: "Large", overrides: ["wall"] },
      { name: "Large", overrides: null },
      { name: "Large", extra: 1 },
      { parameter: "wall", expression: "4" },
      { parameter: "wall", expression: null },
      { parameter: "wall", expression: " " },
      { parameter: "wall", expression: 4 },
      { parameter: "wall" },
      { parameter: "", expression: "4" },
      { parameter: "x".repeat(API_PARAMETER_NAME_MAX_LENGTH + 1), expression: "4" },
      { parameter: "wall", expression: "4", name: "Large" },
      { expression: "4" },
    ];
    for (const body of configurationBodies) {
      const label = JSON.stringify(body)?.slice(0, 80);
      expect(isApiConfigurationCreateRequest(body), `POST ${label}`).toBe(validateApiV1Schema(body, create));
      expect(isApiConfigurationChangeRequest(body), `PATCH ${label}`).toBe(validateApiV1Schema(body, change));
      expect(isApiConfigurationActivateRequest(body), `activate ${label}`).toBe(validateApiV1Schema(body, activate));
    }
  });
});
