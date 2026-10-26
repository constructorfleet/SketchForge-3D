import { describe, expect, it } from "vitest";
import { parseClipboardShapes, pasteClipboardShapes } from "@/lib/editorClipboard";
import { cadBrepTransformForShape } from "@constructorfleet/sketchforge-engine/cadBakeMetadata";
import { serverCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { reconstructSolid } from "@/lib/cadModifierParts";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return sceneShape({
    name: "Box",
    kind: "box",
    color: "#d41721",
    width: 10,
    depth: 10,
    height: 10,
    ...overrides,
  });
}

describe("editor clipboard shapes", () => {
  it("preserves mirror flags on exact geometry when parsing clipboard payloads", () => {
    const mirrored: WorkplaneShape = {
      ...shape({
        id: "mirrored-exact",
        kind: "mesh",
        importedMesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
          baseWidth: 10,
          baseDepth: 10,
          baseHeight: 10,
          triangleCount: 1,
          sourceFormat: "json",
        },
      }),
      mirrorX: true,
      mirrorY: false,
      mirrorZ: true,
      cadBrep: "opaque-exact-brep",
      cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 10, depth: 10, height: 10 },
    };

    const [parsed] = parseClipboardShapes(JSON.stringify([mirrored]));

    expect(parsed).toMatchObject({ mirrorX: true, mirrorZ: true });
    expect(Boolean(parsed?.mirrorY)).toBe(false);
    expect(parsed?.cadBrep).toBe("opaque-exact-brep");
    expect(cadBrepTransformForShape(parsed!)).toEqual([
      -1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, -1, 0,
    ]);
  });

  it("keeps exact cut geometry and migrates legacy cut frames while parsing", () => {
    const oldCut: WorkplaneShape = {
      ...shape({
        id: "old-cut",
        name: "Cut",
        kind: "mesh",
        x: 24,
        z: -5,
        elevation: 2,
        groupedShapes: [shape({ id: "plate" }), shape({ id: "hole", hole: true })],
        importedMesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
          baseWidth: 10,
          baseDepth: 10,
          baseHeight: 10,
          triangleCount: 1,
          sourceFormat: "json",
        },
      }),
      cadBrep: "opaque-exact-brep",
      cadBrepFrame: { x: 24, z: -5, elevation: 2, width: 10, depth: 10, height: 10 },
    };

    const [parsed] = parseClipboardShapes(JSON.stringify([oldCut]));

    expect(parsed?.cadBrep).toBe("opaque-exact-brep");
    expect(parsed?.cadBrepFrame).toEqual({ x: 0, z: 0, elevation: 0, width: 10, depth: 10, height: 10 });
    expect(parsed).toMatchObject({ id: "old-cut", x: 24, z: -5, elevation: 2 });
  });

  it("pastes a legacy cut at its new placement with the same exact volume and translated centre", async () => {
    const cad = await serverCadKernel();
    try {
      const plate = cad.makeBoxFromCorners({ x: -5, y: 0, z: -5 }, { x: 5, y: 10, z: 5 });
      const bore = cad.makeCylinder(2, 10);
      const exactCut = cad.cut(plate, bore);
      const originalVolume = cad.getVolume(exactCut);
      const originalCentre = cad.getCenterOfMass(exactCut);
      const oldCut: WorkplaneShape = {
        ...shape({
          id: "old-cut",
          name: "Cut",
          kind: "mesh",
          x: 24,
          z: -5,
          elevation: 2,
          groupedShapes: [shape({ id: "plate" }), shape({ id: "hole", hole: true })],
          importedMesh: {
            positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
            baseWidth: 10,
            baseDepth: 10,
            baseHeight: 10,
            triangleCount: 1,
            sourceFormat: "json",
          },
        }),
        cadBrep: cad.toBREP(exactCut),
        cadBrepFrame: { x: 24, z: -5, elevation: 2, width: 10, depth: 10, height: 10 },
      };
      const [parsed] = parseClipboardShapes(JSON.stringify([oldCut]));
      expect(parsed?.cadBrep).toBeTruthy();
      expect(parsed?.cadBrepFrame).toMatchObject({ x: 0, z: 0, elevation: 0 });
      const [pasted] = pasteClipboardShapes([parsed!]);
      expect(pasted?.cadBrep).toBe(oldCut.cadBrep);

      const solid = reconstructSolid(cad, {
        hole: false,
        brep: pasted!.cadBrep!,
        brepTransform: cadBrepTransformForShape(pasted!),
      });
      expect(Math.abs(cad.getVolume(solid) - originalVolume)).toBeLessThan(originalVolume * 5e-4);
      const centre = cad.getCenterOfMass(solid);
      expect(centre.x).toBeCloseTo(originalCentre.x + 24 + 12, 3);
      expect(centre.y).toBeCloseTo(originalCentre.y + 2, 3);
      expect(centre.z).toBeCloseTo(originalCentre.z - 5 + 12, 3);
    } finally {
      cad.releaseAll();
    }
  }, CAD_TEST_TIMEOUT_MS);
});
