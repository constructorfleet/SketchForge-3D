import { describe, expect, it } from "vitest";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { CAD_TEST_TIMEOUT_MS } from "../unit/support/cadTestTimeout";
import { buildFaceDraft } from "@/lib/engine/draftFace";
import editorExtrusion from "../fixtures/face-draft-editor-extrusion.json";

describe("face draft kernel operation", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  async function extrusionSource(rotation?: {
    axis: { point: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } };
    angleRad: number;
  }) {
    return withCadKernel((cad) => {
      const points = [
        { x: -10, y: 0, z: -10 }, { x: 10, y: 0, z: -10 },
        { x: 10, y: 0, z: 10 }, { x: -10, y: 0, z: 10 },
      ];
      const edges = points.map((point, index) => cad.makeLineEdge(point, points[(index + 1) % points.length]!));
      const solid = cad.extrude(cad.makeFace(cad.makeWire(edges)), 0, 10, 0);
      const oriented = rotation ? cad.rotate(solid, rotation.axis, rotation.angleRad) : solid;
      const faces = cad.getSubShapes(oriented, "face");
      return { brep: cad.toBREP(oriented), faceIds: faces.map((_, index) => `face-${index}`) };
    });
  }

  it("supports only measured face, CAD axis, and signed-angle combinations for an editor-plane extrusion", async () => {
    const source = await extrusionSource();
    const cases = await withCadKernel((cad) => {
      const supported: string[] = [];
      for (const axis of ["x", "y", "z"] as const) {
        for (const angle of [-5, 5]) {
          for (let face = 0; face < 6; face += 1) {
            try {
              buildFaceDraft(cad, { ...source, faceId: `face-${face}`, angle, pullDirection: axis });
              supported.push(`${face}/${axis}/${angle}`);
            } catch {
              // The measured support boundary includes rejected cases.
            } finally {
              cad.releaseAll();
            }
          }
        }
      }
      return supported;
    });
    expect(cases).toEqual([
      "1/z/-5", "3/z/-5", "4/z/-5", "5/z/-5",
      "1/z/5", "3/z/5", "4/z/5", "5/z/5",
    ]);
  });

  it("applies the supported draft to the exact BREP captured from the editor", async () => {
    const faceIds = Array.from({ length: 6 }, (_, index) => `editor-shape-face-index-${index}`);
    const result = await withCadKernel((cad) => buildFaceDraft(cad, {
      brep: editorExtrusion.brep,
      faceIds,
      faceId: faceIds[1]!,
      angle: -5,
      pullDirection: "z",
    }));
    expect(result.brep).not.toBe(editorExtrusion.brep);
    expect(result.volume).toBeGreaterThan(0);
  });

  it("drafts verified +X and +Y cases on geometry oriented for the selected local CAD axis", async () => {
    const cases = [
      {
        pullDirection: "x" as const,
        rotation: { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, angleRad: Math.PI / 2 },
        face: 0,
        angles: [-30, 30],
      },
      {
        pullDirection: "y" as const,
        rotation: { axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, angleRad: -Math.PI / 2 },
        face: 2,
        angles: [10],
      },
    ];
    for (const { pullDirection, rotation, face, angles } of cases) {
      const source = await extrusionSource(rotation);
      for (const angle of angles) {
        const result = await withCadKernel((cad) => buildFaceDraft(cad, {
          ...source, faceId: `face-${face}`, angle, pullDirection,
        }));
        expect(result.brep).toContain("CASCADE Topology");
        expect(result.brep).not.toBe(source.brep);
        expect(result.volume).toBeGreaterThan(0);
        expect(result.triangleCount).toBeGreaterThan(0);
      }
    }
  });

  it("drafts box faces along negative X and negative Y", async () => {
    const source = await withCadKernel((cad) => {
      const solid = cad.makeBox(10, 10, 10);
      return { brep: cad.toBREP(solid), faceIds: cad.getSubShapes(solid, "face").map((_, index) => `face-${index}`) };
    });
    for (const { face, axis } of [{ face: 0, axis: "-x" }, { face: 2, axis: "-y" }] as const) {
      const result = await withCadKernel((cad) => buildFaceDraft(cad, {
        ...source, faceId: `face-${face}`, angle: 30, pullDirection: axis,
      }));
      expect(result.brep).toContain("CASCADE Topology");
      expect(result.volume).toBeGreaterThan(0);
    }
  });

  it("creates a valid exact solid for a supported stable face selection", async () => {
    const source = await extrusionSource();
    const result = await withCadKernel((cad) => buildFaceDraft(cad, {
      ...source, faceId: "face-1", angle: -5, pullDirection: "z",
    }));
    expect(result.brep).toContain("CASCADE Topology");
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.faceCount).toBeGreaterThan(0);
    expect(result.volume).toBeGreaterThan(0);
  });

  it("returns a localized failure for an unsupported face and pull axis", async () => {
    const source = await extrusionSource();
    await expect(withCadKernel((cad) => buildFaceDraft(cad, {
      ...source, faceId: "face-0", angle: 5, pullDirection: "x",
    }))).rejects.toMatchObject({ key: "errors.cadModifier.draftFaceIncompatible" });
  });

  it("keeps the measured box boundary across every face, axis, and angle sign", async () => {
    const source = await withCadKernel((cad) => {
      const solid = cad.makeBox(10, 10, 10);
      return { brep: cad.toBREP(solid), faceIds: cad.getSubShapes(solid, "face").map((_, index) => `face-${index}`) };
    });
    const supported = await withCadKernel((cad) => {
      const cases: string[] = [];
      for (const axis of ["x", "-x", "y", "-y", "z", "-z"] as const) for (const angle of [-30, -5, 5, 30]) {
        for (let face = 0; face < 6; face += 1) {
          try {
            buildFaceDraft(cad, { ...source, faceId: `face-${face}`, angle, pullDirection: axis });
            cases.push(`${face}/${axis}/${angle}`);
          } catch {
            // Keep every unsupported orientation in the measured boundary.
          } finally {
            cad.releaseAll();
          }
        }
      }
      return cases;
    });
    expect(supported).toEqual([
      "0/-x/5", "0/-x/30",
      "2/-y/5", "2/-y/30",
      "0/z/-30", "1/z/-30", "2/z/-30", "3/z/-30",
      "0/z/-5", "1/z/-5", "2/z/-5", "3/z/-5",
      "0/z/5", "1/z/5", "2/z/5", "3/z/5",
      "0/z/30", "1/z/30", "2/z/30", "3/z/30",
      "0/-z/-30", "1/-z/-30", "2/-z/-30", "3/-z/-30",
      "0/-z/-5", "1/-z/-5", "2/-z/-5", "3/-z/-5",
      "0/-z/5", "1/-z/5", "2/-z/5", "3/-z/5",
      "0/-z/30", "1/-z/30", "2/-z/30", "3/-z/30",
    ]);
  });
});
