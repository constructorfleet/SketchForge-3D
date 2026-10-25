import { afterEach, describe, expect, it, vi } from "vitest";
import { cadModifierBoolean } from "@/lib/cadModifierBoolean";
import { serverCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import type { CadModifierMeshPart } from "@/lib/cadModifierTypes";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

const parts: CadModifierMeshPart[] = [{ hole: false }, { hole: true }];

afterEach(() => vi.restoreAllMocks());

describe("exact cut handle ownership during an edge-modifier session", () => {
  it.each(["success", "reconstruction", "validation", "validation-throws", "serialization"] as const)(
    "restores the session handle baseline after %s",
    async (outcome) => {
      const cad = await serverCadKernel();
      cad.releaseAll();
      try {
        const retained = cad.makeBoxFromCorners({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 });
        const edges = cad.getSubShapes(retained, "edge");
        const baseline = cad.shapeCount;
        const releaseAll = vi.spyOn(cad, "releaseAll");
        if (outcome === "validation") vi.spyOn(cad, "isValid").mockReturnValue(false);
        if (outcome === "validation-throws") vi.spyOn(cad, "isValid").mockImplementation(() => { throw new Error("kernel validator failed"); });
        if (outcome === "serialization") vi.spyOn(cad, "toBREP").mockImplementation(() => { throw new Error("serialization failed"); });
        const run = () => cadModifierBoolean(cad, parts, (part) => {
          const box = cad.makeBoxFromCorners({ x: 0, y: 0, z: 0 }, { x: part.hole ? 5 : 10, y: 10, z: 10 });
          if (outcome === "reconstruction" && part.hole) throw new Error("reconstruction failed");
          return box;
        });
        if (outcome === "success") {
          for (let i = 0; i < 3; i++) {
            const result = run();
            expect(result.fusedVolume).toBeCloseTo(1000);
            expect(result.cutVolume).toBeCloseTo(500);
            expect(result.triangleCount).toBeGreaterThan(0);
            expect(result.brep.length).toBeGreaterThan(0);
            const restored = cad.fromBREP(result.brep);
            expect(cad.getVolume(restored)).toBeCloseTo(500);
            const center = cad.getCenterOfMass(restored);
            expect(center.x).toBeCloseTo(0);
            expect(center.y).toBeCloseTo(5);
            expect(center.z).toBeCloseTo(0);
            cad.release(restored);
            expect(cad.shapeCount).toBe(baseline);
          }
        } else {
          expect(run).toThrow(outcome.startsWith("validation") ? /invalid or overlapping edge geometry/ : `${outcome} failed`);
        }
        expect(cad.shapeCount).toBe(baseline);
        expect(releaseAll).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        expect(cad.getVolume(retained)).toBeCloseTo(1000);
        for (const coordinate of Object.values(cad.getCenterOfMass(retained))) expect(coordinate).toBeCloseTo(5);
        expect(edges.every((edge) => cad.isValid(edge))).toBe(true);
      } finally {
        vi.restoreAllMocks();
        cad.releaseAll();
      }
    }, CAD_TEST_TIMEOUT_MS,
  );
});
