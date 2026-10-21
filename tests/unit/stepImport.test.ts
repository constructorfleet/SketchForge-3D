import { describe, expect, it } from "vitest";
import { importedShapeFromStep } from "@constructorfleet/sketchforge-engine/stepImport";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { createFaceColorPreviewGeometry } from "@/lib/faceColorPreview";
import * as THREE from "three";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

describe("STEP import face mapping", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("retains triangle ranges mapped to CAD face indexes for viewport coloring", async () => {
    const source = await withCadKernel((cad) => cad.exportStep(cad.makeBox(10, 8, 6)));
    const shape = await importedShapeFromStep("box.step", new TextEncoder().encode(source).buffer);

    expect(shape.importedMesh?.faceGroups).toEqual([
      0, 2, 0,
      2, 2, 1,
      4, 2, 2,
      6, 2, 3,
      8, 2, 4,
      10, 2, 5,
    ]);
  });

  it("preserves explicit component colors as stable face colors on a regular import", async () => {
    const source = await withCadKernel((cad) => {
      const document = cad.createXCAFDocument();
      try {
        document.addShape(cad.makeBox(10, 8, 6), { name: "Red housing", color: [0.8, 0.1, 0.2] });
        document.addShape(cad.translate(cad.makeBox(5, 4, 3), 20, 0, 0), { name: "Blue pin", color: [0.1, 0.2, 0.9] });
        return document.exportSTEP();
      } finally {
        document.close();
      }
    });
    const shape = await importedShapeFromStep("colored-assembly.step", new TextEncoder().encode(source).buffer);

    expect(shape.faceIds).toHaveLength(12);
    expect(shape.faceColors).toBeDefined();
    expect(Object.values(shape.faceColors ?? {}).sort()).toEqual([
      ...Array(6).fill("#1a33e5"),
      ...Array(6).fill("#cc1a33"),
    ]);
    expect(shape.importedMesh?.faceGroups).toHaveLength(36);

    const mesh = shape.importedMesh!;
    const preview = createFaceColorPreviewGeometry({
      positions: new Float32Array(mesh.positions),
      faceGroups: mesh.faceGroups!,
      faceIds: shape.faceIds!,
    }, shape.faceColors!, shape.color);
    const colors = preview.getAttribute("color");
    const displayed = new Set(Array.from({ length: colors.count }, (_, index) => [
      colors.getX(index), colors.getY(index), colors.getZ(index),
    ].map((channel) => Math.round(channel * 255)).join(",")));
    const rgb8 = (hex: string) => {
      const color = new THREE.Color(hex);
      return [color.r, color.g, color.b].map((channel) => Math.round(channel * 255)).join(",");
    };
    expect(displayed).toContain(rgb8("#cc1a33"));
    expect(displayed).toContain(rgb8("#1a33e5"));
  });
});
