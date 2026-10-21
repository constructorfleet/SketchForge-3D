import { describe, expect, it } from "vitest";
import { importedShapeFromStepOnKernel } from "@/lib/engine/stepImportKernel";
import { withCadKernel } from "@/lib/engine/serverCadKernel";
import { exportSkfProject } from "@/lib/engine/skfProject";
import { readProjectDocument, writeProjectDocument } from "@/lib/engine/serverProjectDocument";
import { editorHistoryEntry } from "@/lib/engine/editorHistory";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/engine/workplaneSettings";
import { projectAssetFromBytes } from "@/lib/engine/projectAssets";
import type { WorkplaneShape } from "@/types/sketchforge";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("reading a project that holds a STEP source asset", () => {
  it("reads it through the server's own read path, where the browser's kernel loader does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "sketchforge-step-read-"));
    try {
      const archive = await projectHoldingAStepImport();
      // Written the way the server stores a project, then read the way the
      // server reads one -- which is the path that could not do this.
      await writeFile(join(root, "project-step.skf"), archive);
      await writeFile(join(root, "project-step.json"), JSON.stringify({
        id: "project-step",
        name: "STEP on the server",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        revision: 1,
      }));

      const document = await readProjectDocument(root, "project-step");
      expect(document).not.toBeNull();
      expect(document!.shapes).toHaveLength(1);

      const shape = document!.shapes[0];
      expect(shape.importedMesh?.positions.length).toBeGreaterThan(0);
      // Regenerated from the asset, so it has to be the same box: 30 wide,
      // 8 tall, 20 deep once Z-up becomes Y-up. Measured, not assumed.
      expect(shape.width).toBeCloseTo(30, 0);
      expect(shape.height).toBeCloseTo(8, 0);
      expect(shape.depth).toBeCloseTo(20, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
