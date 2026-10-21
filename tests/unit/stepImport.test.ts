import { describe, expect, it } from "vitest";
import { importedShapeFromStep } from "@constructorfleet/sketchforge-engine/stepImport";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

describe("STEP import face mapping", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("retains triangle ranges mapped to CAD face indexes for viewport coloring", async () => {
    const source = await withCadKernel((cad) => cad.exportStep(cad.makeBox(10, 8, 6)));
    const shape = await importedShapeFromStep("box.step", new TextEncoder().encode(source).buffer);

    expect(shape.importedMesh?.faceGroups).toEqual([
      0, 6, 0,
      6, 6, 1,
      12, 6, 2,
      18, 6, 3,
      24, 6, 4,
      30, 6, 5,
    ]);
  });
});
