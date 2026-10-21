import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { sectionShapesToDxf, sectionShapesToSvg } from "@constructorfleet/sketchforge-engine/serverCadSection";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(request: Record<string, unknown>) {
  return shapeFromRequest(request) as WorkplaneShape;
}

describe("section drawings from stored shapes", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("returns a bounded SVG contour for a named plane through a solid", async () => {
    const svg = await sectionShapesToSvg(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane: "xy", offset: 2 },
    );

    expect(svg).toMatch(/^<svg [^>]*viewBox=/);
    expect(svg).toContain('data-plane="xy"');
    expect(svg).toContain('data-offset="2"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    const coordinates = [...svg.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
      .map((match) => [Number(match[1]), Number(match[2])] as const);
    expect(Math.min(...coordinates.map(([u]) => u))).toBe(-10);
    expect(Math.max(...coordinates.map(([u]) => u))).toBe(10);
    expect(Math.min(...coordinates.map(([, v]) => v))).toBe(-5);
    expect(Math.max(...coordinates.map(([, v]) => v))).toBe(5);
  });

  it("exports the same section contour as millimetre-space DXF polylines", async () => {
    const dxf = await sectionShapesToDxf(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane: "xy", offset: 2 },
    );
    expect(dxf).toContain("LWPOLYLINE");
    expect(dxf).toContain("\n10\n-10\n20\n-5\n");
    expect(dxf).toContain("\n10\n10\n20\n5\n");
    expect(dxf.endsWith("0\nEOF\n")).toBe(true);
  });

  it("refuses a plane that misses the selected scene", async () => {
    await expect(sectionShapesToSvg(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane: "xy", offset: 100 },
    )).rejects.toThrow(/does not intersect/i);
  });

  it.each([
    { plane: "xz" as const, offset: 0, expected: [[-10, 0], [-10, 4], [10, 0], [10, 4]] },
    { plane: "yz" as const, offset: 0, expected: [[-5, 0], [-5, 4], [5, 0], [5, 4]] },
  ])("uses the named $plane plane frame", async ({ plane, offset, expected }) => {
    const svg = await sectionShapesToSvg(
      [shape({ kind: "box", width: 20, depth: 10, height: 4 })],
      { plane, offset },
    );
    const coordinates = [...svg.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
      .map((match) => [Number(match[1]), Number(match[2])] as const);
    for (const point of expected) expect(coordinates).toContainEqual(point);
  });

  it("bounds scene size and object count before invoking the kernel", async () => {
    await expect(sectionShapesToSvg(
      [shape({ kind: "box", width: 10_000, depth: 10_000, height: 10_000 })],
      { plane: "xy", offset: 1 },
    )).rejects.toThrow(/maximum section span/i);

    const many = Array.from({ length: 101 }, () => shape({ kind: "box", width: 1, depth: 1, height: 1 }));
    await expect(sectionShapesToSvg(many, { plane: "xy", offset: 0.5 }))
      .rejects.toThrow(/maximum of 100 shapes/i);

    const imported = {
      ...shape({ kind: "box", width: 1, depth: 1, height: 1 }),
      importedMesh: { positions: [], baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 50_001, sourceFormat: "stl" as const },
    };
    await expect(sectionShapesToSvg([imported], { plane: "xy", offset: 0.5 }))
      .rejects.toThrow(/maximum of 50000 imported mesh triangles/i);
  });
});
