import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OcctKernel } from "occt-wasm";
import { buildCadSketchSweep } from "@/lib/sketchCadSweep";
import type { SketchProfile } from "@/types/sketchforge";

function profileWithSpine(spine: Array<{ x: number; z: number }>): SketchProfile {
  const sectionPoints = [
    { id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 },
    { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
  ];
  const pathPoints = spine.map((point, index) => ({ id: `p${index}`, ...point }));
  return {
    points: [...sectionPoints, ...pathPoints],
    segments: [
      ...sectionPoints.map((point, index) => ({ id: `s${index}`, kind: "line" as const, startId: point.id, endId: sectionPoints[(index + 1) % sectionPoints.length].id })),
      ...pathPoints.slice(0, -1).map((point, index) => ({ id: `path${index}`, kind: "line" as const, startId: point.id, endId: pathPoints[index + 1].id })),
    ],
  };
}

describe("planar sketch sweep (real OCCT kernel)", () => {
  it.each([
    ["straight spine", [{ x: 0, z: 0 }, { x: 10, z: 0 }]],
    ["bent spine", [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }]],
  ])("builds a valid positive-volume solid along a %s", async (_label, spine) => {
    const wasm = join(dirname(fileURLToPath(import.meta.resolve("occt-wasm"))), "occt-wasm.wasm");
    const cad = await OcctKernel.init({ wasm });
    try {
      const solid = buildCadSketchSweep(cad, profileWithSpine(spine));
      expect(cad.isValid(solid)).toBe(true);
      expect(cad.isSolid(solid)).toBe(true);
      expect(cad.getVolume(solid)).toBeGreaterThan(0);
    } finally {
      cad.releaseAll();
    }
  });
});
