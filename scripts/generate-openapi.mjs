import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(root, "apps/web/src/lib/apiV1OperationContract.ts");
const outputPath = path.join(root, "docs/openapi-v1.json");
const source = await readFile(contractPath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const contractUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { API_V1_OPERATIONS } = await import(contractUrl);

const paths = {};
const omitted = [];
for (const operation of API_V1_OPERATIONS) {
  const reason = omissionReason(operation);
  if (reason) {
    omitted.push({ method: operation.method, path: operation.path, operationId: operation.operationId, reason });
    continue;
  }

  const pathItem = paths[operation.path] ?? (paths[operation.path] = {});
  const responses = Object.fromEntries(Object.entries(operation.responseSchemas).map(([status, schema]) => [
    status,
    {
      description: responseDescription(Number(status)),
      content: { "application/json": { schema: toJsonSchema(schema) } },
    },
  ]));
  const generated = { operationId: operation.operationId, responses };
  if (operation.description) generated.description = operation.description;
  if (operation.auth === "bearer") generated.security = [{ bearerAuth: [] }, { sketchForgeToken: [] }];
  if (operation.query) {
    generated.parameters = Object.entries(operation.query.properties).map(([name, rule]) => ({
      name,
      in: "query",
      required: operation.query.required.includes(name),
      ...(rule.description ? { description: rule.description } : {}),
      schema: {
        type: rule.type,
        ...(rule.pattern ? { pattern: rule.pattern } : {}),
        ...(rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
        ...(rule.maxLength !== undefined ? { maxLength: rule.maxLength } : {}),
      },
    }));
  }
  if (operation.requestBody) {
    generated.requestBody = {
      required: operation.requestBody.required,
      content: { [operation.requestBody.contentType]: { schema: toJsonSchema(operation.requestBody.schema) } },
    };
  }
  pathItem[operation.method.toLowerCase()] = generated;
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "SketchForge REST API v1 (contracted subset)",
    version: "1",
    description: "Generated from the runtime-facing API operation registry. This document contains only operations whose request, query, and response metadata can be represented accurately. See x-sketchforge-omitted-operations for the registered operations that still need contract work.",
  },
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      sketchForgeToken: { type: "apiKey", in: "header", name: "X-SketchForge-Token" },
    },
  },
  "x-sketchforge-source": "apps/web/src/lib/apiV1OperationContract.ts",
  "x-sketchforge-omitted-operations": omitted,
};
const output = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== output) {
    console.error("docs/openapi-v1.json is stale; run node scripts/generate-openapi.mjs");
    process.exitCode = 1;
  } else {
    console.log("docs/openapi-v1.json is current");
  }
} else {
  await writeFile(outputPath, output);
  console.log("Generated docs/openapi-v1.json");
}

function omissionReason(operation) {
  if (operation.method === "OPTIONS") return "Preflight-only operation; omitted from the resource API document.";
  if (!operation.responses || !operation.responseSchemas) return "Response schemas or verified response statuses are not declared.";
  const declaredStatuses = Object.keys(operation.responseSchemas).map(Number).sort((a, b) => a - b);
  if ([...operation.responses].sort((a, b) => a - b).join(",") !== declaredStatuses.join(",")) {
    return "Not every declared response status has a response schema.";
  }
  if (operation.operationId === "updateShape" && operation.requestBody?.faceColors) {
    return "PATCH /shapes is omitted because faceColors uses custom validation not expressible in JSON Schema. It also accepts sketchProfile to rebuild a retained sketch sweep; see https://constructorfleet.github.io/SketchForge-3D/docs/REST_API#sketch-sweeps.";
  }
  if (operation.response || operation.requestBody?.faceColors) return "The current metadata uses custom validation rules that are not fully expressible in its JSON Schema.";
  if (operation.requestBody && !operation.requestBody.schema) return "Request body schema is not declared.";
  return undefined;
}

function toJsonSchema(schema) {
  if (schema.oneOf) return { oneOf: schema.oneOf.map(toJsonSchema) };
  const result = { type: schema.nullable ? [schema.type, "null"] : schema.type };
  if (schema.required) result.required = [...schema.required];
  if (schema.enum) result.enum = [...schema.enum, ...(schema.nullable ? [null] : [])];
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (schema.maximum !== undefined) result.maximum = schema.maximum;
  if (schema.minimumLength !== undefined) result.minLength = schema.minimumLength;
  if (schema.maximumLength !== undefined) result.maxLength = schema.maximumLength;
  if (schema.pattern !== undefined) result.pattern = schema.pattern;
  if (schema.minItems !== undefined) result.minItems = schema.minItems;
  if (schema.maxItems !== undefined) result.maxItems = schema.maxItems;
  if (schema.description !== undefined) result.description = schema.description;
  if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, toJsonSchema(child)]));
  if (schema.items) result.items = toJsonSchema(schema.items);
  if (schema.additionalProperties !== undefined) result.additionalProperties = typeof schema.additionalProperties === "boolean" ? schema.additionalProperties : toJsonSchema(schema.additionalProperties);
  return result;
}

function responseDescription(status) {
  if (status >= 200 && status < 300) return status === 201 ? "Resource created." : "Successful response.";
  if (status === 400) return "Invalid request.";
  if (status === 401) return "Authentication failed.";
  if (status === 404) return "Resource not found or API disabled.";
  if (status === 409) return "The project is busy or the request conflicts with current state.";
  if (status === 413) return "Request exceeds the supported size or item limit.";
  if (status === 422) return "Request is valid JSON but cannot be applied.";
  if (status >= 500) return "Server-side failure.";
  return "Response declared by the operation contract.";
}
