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
  assert.ok(spec["x-sketchforge-omitted-operations"].some(({ operationId, reason }) => operationId === "updateShape" && reason.includes("custom validation")));

  const listMeasurements = spec.paths["/api/v1/measurements"].get;
  assert.ok(listMeasurements, "GET /measurements should be present once its runtime contract is complete");
  assert.deepEqual(Object.keys(listMeasurements.responses).sort(), ["200", "400", "401", "404", "409", "500", "503"]);
  const measurement = listMeasurements.responses["200"].content["application/json"].schema.properties.measurements.items;
  assert.deepEqual(measurement.required, ["entity", "index", "geometryType", "length", "area", "radius", "diameter", "sweepDegrees", "radiusUnavailable"]);
  assert.deepEqual(measurement.properties.radius.type, ["number", "null"]);
  const measureEntities = spec.paths["/api/v1/measurements"].post;
  assert.ok(measureEntities, "POST /measurements should describe both entity selectors and its conditional index requirement");
  assert.deepEqual(Object.keys(measureEntities.responses).sort(), ["200", "400", "401", "404", "409", "422", "500", "503"]);
  const body = measureEntities.requestBody.content["application/json"].schema;
  assert.deepEqual(body.required, ["from", "to"]);
  assert.ok(body.properties.from.oneOf.some((variant) => variant.required.includes("index")));
  const resultSchema = measureEntities.responses["200"].content["application/json"].schema;
  assert.equal(resultSchema.oneOf.length, 2, "the angle is either available or has one declared unavailability reason");
  assert.ok(resultSchema.oneOf.every((variant) => variant.required.includes("distance") && variant.required.includes("angleDegrees") && variant.required.includes("angleUnavailable")));
  const fromSchema = body.properties.from.oneOf;
  assert.ok(fromSchema.some((variant) => variant.not?.required?.includes("entity")), "omitting entity means the route defaults it to shape");
  assert.ok(fromSchema.some((variant) => variant.required.includes("index") && variant.properties.entity.enum.includes("edge")));
  assert.equal(spec["x-sketchforge-omitted-operations"].some(({ operationId }) => operationId === "measureEntities"), false);
  const documentedOperationCount = Object.values(spec.paths).reduce((count, pathItem) => count + Object.keys(pathItem).length, 0);
  assert.equal(documentedOperationCount, 9);
  assert.equal(spec["x-sketchforge-omitted-operations"].length, 23);
});

test("docs scripts generate and check OpenAPI from the REST operation registry", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(scripts["docs:generate"].includes("scripts/generate-openapi.mjs"));
  assert.ok(scripts["docs:check"].includes("scripts/generate-openapi.mjs --check"));
  assert.ok(scripts["docs:check"].includes("tests/docs/openapi-reference.test.mjs"));
});
