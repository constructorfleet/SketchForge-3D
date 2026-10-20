import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importedShapeFromStepOnKernel } from "@constructorfleet/sketchforge-engine/stepImportKernel";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { exportSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { readProjectDocument } from "@constructorfleet/sketchforge-engine/serverProjectDocument";
import { writeProjectMetadata, writeProjectPackage } from "@constructorfleet/sketchforge-engine/serverProjectFiles";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { projectAssetFromBytes } from "@constructorfleet/sketchforge-engine/projectAssets";
import type { WorkplaneShape } from "@/types/sketchforge";

/**
 * A project holding a STEP source asset has to be readable by the server.
 *
 * A shape whose mesh came from a source asset is *regenerated* from that asset
 * when the project is read back, and the default importer's STEP branch loads
 * the browser's OCCT from `/occt/index.js`. Under Node that module does not
 * exist, so the read throws -- which means a STEP imported in the browser and
 * saved to server storage cannot be read by the server at all.
 */
async function stepText() {
  return withCadKernel(async (cad) => cad.exportStep(
    cad.makeBoxFromCorners({ x: -15, y: -10, z: 0 }, { x: 15, y: 10, z: 8 }),
  ));
}

async function projectHoldingAStepImport() {
  const text = await stepText();
  const { shape } = await importedShapeFromStepOnKernel("bracket.step", text);
  const asset = await projectAssetFromBytes("bracket.step", "step", new TextEncoder().encode(text));
  const withSource: WorkplaneShape = {
    ...shape,
    importedMesh: { ...shape.importedMesh!, assetId: asset.id },
  };
  return exportSkfProject({
    projectName: "STEP on the server",
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_100_000,
    shapes: [withSource],
    history: [editorHistoryEntry([withSource], [])],
    historyIndex: 0,
    assets: [asset],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
  });
}

let projectsRoot = "";

afterEach(async () => {
  if (projectsRoot) await fs.rm(projectsRoot, { recursive: true, force: true });
  projectsRoot = "";
});

describe("reading a project that holds a STEP source asset", () => {
  it("reads it on the server, where the browser's kernel loader does not exist", async () => {
    const archive = await projectHoldingAStepImport();
    projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sketchforge-server-step-project-"));
    await writeProjectMetadata(projectsRoot, "step-source", { name: "STEP on the server", createdAt: 1_700_000_000_000 });
    await writeProjectPackage(projectsRoot, "step-source", archive);
    const restored = await readProjectDocument(projectsRoot, "step-source");

    expect(restored?.shapes).toHaveLength(1);
    const mesh = restored?.shapes[0].importedMesh;
    expect(mesh?.positions.length).toBeGreaterThan(0);
    // Regenerated from the asset, so it must be the same box: 30 x 8 x 20 in
    // Y-up terms, measured rather than assumed.
    expect(restored?.shapes[0].width).toBeCloseTo(30, 0);
    expect(restored?.shapes[0].height).toBeCloseTo(8, 0);
    expect(restored?.shapes[0].depth).toBeCloseTo(20, 0);
  }, 300_000);
});
