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
  const edges = spec.paths["/api/v1/edges"].get;
  assert.ok(edges, "GET /edges should be present once its runtime contract is complete");
  assert.deepEqual(Object.keys(edges.responses).sort(), ["200", "400", "401", "404", "422", "500", "503"]);
  assert.deepEqual(edges.parameters.map(({ name, required }) => [name, required]), [["projectId", true], ["shapeId", true]]);
  assert.match(edges.description, /indexes can change when topology changes/);
  const edgeSchema = edges.responses["200"].content["application/json"].schema;
  assert.deepEqual(edgeSchema.required, ["edges"]);
  const edge = edgeSchema.properties.edges.items;
  assert.deepEqual(edge.required, ["index", "length", "curveType", "midpoint", "filletable"]);
  assert.equal(edge.additionalProperties, false);
  assert.deepEqual(edge.properties.midpoint.required, ["x", "y", "z"]);
  assert.equal(edge.properties.filletable.type, "boolean");
  assert.deepEqual(edges.responses["404"].content["application/json"].schema.properties.code.enum, ["api_disabled", "project_not_found", "shape_not_found"]);
  assert.equal(spec["x-sketchforge-omitted-operations"].some(({ operationId }) => operationId === "listEdges"), false);
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
  const align = spec.paths["/api/v1/align"].post;
  assert.ok(align, "POST /align should be present once its runtime contract is complete");
  assert.deepEqual(align.requestBody.content["application/json"].schema.required, ["ids", "axis", "target"]);
  assert.deepEqual(align.requestBody.content["application/json"].schema.properties.axis.enum, ["x", "y", "z"]);
  assert.deepEqual(Object.keys(align.responses).sort(), ["200", "400", "401", "404", "409", "422", "500", "503"]);
  assert.deepEqual(align.responses["200"].content["application/json"].schema.required, ["moved", "axis", "target", "anchorId", "shapes", "revision"]);
  const distribute = spec.paths["/api/v1/distribute"].post;
  assert.ok(distribute, "POST /distribute should be present once its runtime contract is complete");
  assert.deepEqual(distribute.requestBody.content["application/json"].schema.required, ["ids"]);
  assert.deepEqual(distribute.requestBody.content["application/json"].schema.properties.axis.enum, ["x", "z"]);
  assert.deepEqual(distribute.requestBody.content["application/json"].schema.properties.spacing.enum, ["gaps", "centers"]);
  assert.deepEqual(distribute.responses["200"].content["application/json"].schema.required, ["moved", "axis", "spacing", "shapes", "revision"]);
  assert.equal(spec["x-sketchforge-omitted-operations"].some(({ operationId }) => operationId === "alignShapes" || operationId === "distributeShapes"), false);
  for (const [pathName, method, operationId] of [
    ["/api/v1/booleans", "post", "booleanShapes"],
    ["/api/v1/treatments", "post", "treatShape"],
    ["/api/v1/shell", "post", "shellShape"],
    ["/api/v1/draft-prism", "post", "draftPrism"],
  ]) {
    assert.ok(spec.paths[pathName]?.[method], `${method.toUpperCase()} ${pathName} has a verified runtime contract`);
    assert.equal(spec.paths[pathName][method].operationId, operationId);
    assert.ok(spec.paths[pathName][method].requestBody.content["application/json"].schema);
    assert.ok(spec.paths[pathName][method].responses["200"] || spec.paths[pathName][method].responses["201"]);
  }
  const documentedOperationCount = Object.values(spec.paths).reduce((count, pathItem) => count + Object.keys(pathItem).length, 0);
  assert.equal(documentedOperationCount, 16);
  assert.equal(spec["x-sketchforge-omitted-operations"].length, 16);
});

test("docs scripts generate and check OpenAPI from the REST operation registry", async () => {
  const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(scripts["docs:generate"].includes("scripts/generate-openapi.mjs"));
  assert.ok(scripts["docs:verify"].includes("scripts/generate-openapi.mjs --check"));
  assert.ok(scripts["docs:verify"].includes("tests/docs/openapi-reference.test.mjs"));
});
