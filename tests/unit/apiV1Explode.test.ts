import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createProject } from "@/app/api/v1/projects/route";
import { POST as explode } from "@/app/api/v1/explode/route";
import { API_TOKEN_ENV } from "@/lib/apiTokens";
import { SERVER_PROJECTS_ENV } from "@/lib/serverProjectStore";
import { importedShapeFromStepOnKernel } from "@constructorfleet/sketchforge-engine/stepImportKernel";
import { readProjectDocument, writeProjectDocument } from "@constructorfleet/sketchforge-engine/serverProjectDocument";
import type { ProjectAsset } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const TOKEN = "explode-test-token";
let projectsRoot = "";
let previousRoot: string | undefined;
let previousToken: string | undefined;

function authorized(url: string) {
  return new Request(`http://localhost${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

describe("REST API v1 STEP explosion", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  beforeEach(async () => {
    previousRoot = process.env[SERVER_PROJECTS_ENV];
    previousToken = process.env[API_TOKEN_ENV];
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-api-explode-"));
    process.env[SERVER_PROJECTS_ENV] = projectsRoot;
    process.env[API_TOKEN_ENV] = TOKEN;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env[SERVER_PROJECTS_ENV];
    else process.env[SERVER_PROJECTS_ENV] = previousRoot;
    if (previousToken === undefined) delete process.env[API_TOKEN_ENV];
    else process.env[API_TOKEN_ENV] = previousToken;
    await fs.rm(projectsRoot, { recursive: true, force: true });
  });

  it("requires a shapeId and rejects a missing assembly", async () => {
    const missingId = await explode(authorized("/api/v1/explode?projectId=project-1"));
    expect(missingId.status).toBe(400);
    expect(await missingId.json()).toMatchObject({ code: "invalid_shape_id" });

    const missingAssembly = await explode(authorized("/api/v1/explode?projectId=project-1&shapeId=missing"));
    expect(missingAssembly.status).toBe(404);
    expect(await missingAssembly.json()).toMatchObject({ code: "project_not_found" });
  });

  it("explodes an imported STEP product tree and returns contract-shaped summaries", async () => {
    const created = await createProject(new Request("http://localhost/api/v1/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Assembly" }),
    }));
    const { project } = await created.json() as { project: { id: string } };
    const document = await readProjectDocument(projectsRoot, project.id);
    if (!document) throw new Error("created project was not persisted");

    const step = await fs.readFile(new URL("../fixtures/step/nested-assembly.step", import.meta.url), "utf8");
    const bytes = new TextEncoder().encode(step);
    const asset: ProjectAsset = { id: "assembly-source", name: "nested-assembly.step", mediaType: "model/step", sourceFormat: "step", bytes, byteLength: bytes.byteLength, sha256: "test" };
    const imported = await importedShapeFromStepOnKernel(asset.name, step);
    imported.shape.importedMesh!.assetId = asset.id;
    await writeProjectDocument(projectsRoot, project.id, { ...document, assets: [asset] }, [imported.shape]);

    const response = await explode(authorized(`/api/v1/explode?projectId=${project.id}&shapeId=${imported.shape.id}`));
    const result = await response.json() as { shapes: Array<{ name: string }>; revision: number; code?: string };
    expect(response.status).toBe(200);
    expect(result.revision).toBeGreaterThan(0);
    expect(result.shapes.map(({ name }) => name)).toEqual(["MainAssembly"]);
  });
});
