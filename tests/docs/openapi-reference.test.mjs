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
  const faces = spec.paths["/api/v1/faces"].get;
  assert.ok(faces, "GET /faces should be present once its runtime contract is complete");
  assert.deepEqual(Object.keys(faces.responses).sort(), ["200", "400", "401", "404", "422", "500", "503"]);
  assert.equal(faces.responses["409"], undefined, "read-only face listing does not take the project write lock");
  assert.deepEqual(faces.parameters.map(({ name, required }) => [name, required]), [["projectId", true], ["shapeId", true]]);
  assert.match(faces.parameters[0].description, /trimmed before validation/);
  const faceSchema = faces.responses["200"].content["application/json"].schema;
  assert.deepEqual(faceSchema.required, ["faces"]);
  const face = faceSchema.properties.faces.items;
  assert.deepEqual(face.required, ["index", "id", "surfaceType", "area", "centroid", "normal", "facing"]);
  assert.equal(face.additionalProperties, false);
  assert.deepEqual(face.properties.normal.type, ["object", "null"]);
  assert.deepEqual(face.properties.facing.type, ["string", "null"]);
  assert.deepEqual(face.properties.facing.enum, ["top", "bottom", "right", "left", "front", "back", null]);
  assert.deepEqual(faces.responses["404"].content["application/json"].schema.properties.code.enum, ["api_disabled", "project_not_found", "shape_not_found"]);
  assert.ok(spec.paths["/api/v1/projects"].post.requestBody.content["application/json"].schema.properties.name);
  assert.equal(spec.paths["/api/v1/projects"].post.requestBody.content["application/json"].schema.properties.name.maxLength, 80);
  assert.ok(spec.paths["/api/v1/projects"].post.responses["201"].content["application/json"].schema);
  assert.deepEqual(spec.paths["/api/v1/projects"].post.security, [{ bearerAuth: [] }, { sketchForgeToken: [] }]);
  assert.deepEqual(spec.paths["/api/v1/projects"].get.parameters[0], {
    name: "projectId", in: "query", required: false,
    schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 120 },
  });
  assert.equal(spec["x-sketchforge-omitted-operations"].some(({ operationId }) => operationId === "listFaces"), false);
  const patchOmission = spec["x-sketchforge-omitted-operations"].find(({ operationId }) => operationId === "updateShape");
  assert.match(patchOmission.reason, /custom validation/);
  assert.match(patchOmission.reason, /sketchProfile.*rebuild/i);
  assert.match(patchOmission.reason, /https:\/\/constructorfleet\.github\.io\/SketchForge-3D\/docs\/REST_API#sketch-sweeps/);
});

test("docs scripts generate and check OpenAPI from the REST operation registry", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(scripts["docs:generate"].includes("scripts/generate-openapi.mjs"));
  assert.ok(scripts["docs:check"].includes("scripts/generate-openapi.mjs --check"));
  assert.ok(scripts["docs:check"].includes("tests/docs/openapi-reference.test.mjs"));
});
