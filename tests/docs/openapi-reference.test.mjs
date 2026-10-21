import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("generated OpenAPI is a source-backed subset and calls out omitted operations", async () => {
  const spec = JSON.parse(await readFile(path.join(root, "docs/openapi-v1.json"), "utf8"));

  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/api/v1/projects"].post);
  assert.ok(spec.paths["/api/v1/shapes"].get);
  assert.equal(spec.paths["/api/v1/shapes"].patch, undefined, "PATCH has custom validation that its current broad schema does not express");
  assert.equal(spec.paths["/api/v1/faces"], undefined, "face response metadata is not yet a complete runtime schema");
  assert.ok(spec.paths["/api/v1/projects"].post.requestBody.content["application/json"].schema.properties.name);
  assert.equal(spec.paths["/api/v1/projects"].post.requestBody.content["application/json"].schema.properties.name.maxLength, 80);
  assert.ok(spec.paths["/api/v1/projects"].post.responses["201"].content["application/json"].schema);
  assert.deepEqual(spec.paths["/api/v1/projects"].post.security, [{ bearerAuth: [] }, { sketchForgeToken: [] }]);
  assert.deepEqual(spec.paths["/api/v1/projects"].get.parameters[0], {
    name: "projectId", in: "query", required: false,
    schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
  });
  assert.ok(spec["x-sketchforge-omitted-operations"].some(({ operationId }) => operationId === "listFaces"));
  assert.ok(spec["x-sketchforge-omitted-operations"].some(({ operationId, reason }) => operationId === "updateShape" && reason.includes("custom validation")));
});

test("docs scripts generate and check OpenAPI from the REST operation registry", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(scripts["docs:generate"].includes("scripts/generate-openapi.mjs"));
  assert.ok(scripts["docs:check"].includes("scripts/generate-openapi.mjs --check"));
  assert.ok(scripts["docs:check"].includes("tests/docs/openapi-reference.test.mjs"));
});
