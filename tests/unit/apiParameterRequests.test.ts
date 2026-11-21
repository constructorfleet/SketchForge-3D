import { describe, expect, it } from "vitest";
import { API_V1_OPERATIONS, validateApiV1Schema, type ApiV1FieldSchema } from "@/lib/apiV1OperationContract";
import {
  API_PARAMETER_EXPRESSION_MAX_LENGTH,
  API_PARAMETER_NAME_MAX_LENGTH,
  apiParameterName,
  isApiParameterChangeRequest,
  isApiParameterCreateRequest,
} from "@constructorfleet/sketchforge-engine/apiParameters";

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
});
