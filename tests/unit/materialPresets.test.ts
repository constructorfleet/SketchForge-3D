import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATERIAL_ID,
  MATERIAL_PRESETS,
  MAX_MATERIAL_PRICE_PER_KG,
  cubicMillimetersToCubicCentimeters,
  isMaterialId,
  materialCost,
  materialPreset,
  materialPricePerKg,
  materialWeightGrams,
  meshVolumeCentroid,
  meshVolumeMm3,
  normalizeMaterialPrices,
  shapeMaterialEstimate,
  type MaterialMesh,
} from "@/lib/materialPresets";
import type { WorkplaneShape } from "@/types/sketchforge";

/** Axis-aligned box centred at `centre`, as 12 outward-wound triangles. */
function boxMesh(centre: [number, number, number], size: [number, number, number]): MaterialMesh {
  const [cx, cy, cz] = centre;
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  return {
    vertices: [
      [cx - hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz + hz],
      [cx - hx, cy - hy, cz + hz],
      [cx - hx, cy + hy, cz - hz],
      [cx + hx, cy + hy, cz - hz],
      [cx + hx, cy + hy, cz + hz],
      [cx - hx, cy + hy, cz + hz],
    ],
    faces: [
      [0, 2, 1], [0, 3, 2],
      [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4],
      [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6],
      [3, 0, 4], [3, 4, 7],
    ],
  };
}

/** A regular tetrahedron on the unit-cube corners: volume = edge^3 / 6 for this construction. */
function tetrahedronMesh(scale: number): MaterialMesh {
  return {
    vertices: [[0, 0, 0], [scale, 0, 0], [0, scale, 0], [0, 0, scale]],
    faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
  };
}

function shape(fields: Partial<WorkplaneShape>): Pick<WorkplaneShape, "material" | "hole"> {
  return { material: fields.material, hole: fields.hole };
}

describe("mesh volume", () => {
  it("measures a 20 mm cube as 8000 mm3 wherever it sits", () => {
    expect(meshVolumeMm3(boxMesh([0, 0, 0], [20, 20, 20]))).toBeCloseTo(8000, 9);
    // Away from the origin the signed tetrahedra are individually large and
    // must still cancel to the same volume.
    expect(meshVolumeMm3(boxMesh([137, -58, 412], [20, 20, 20]))).toBeCloseTo(8000, 6);
  });

  it("measures a rectangular box as the product of its sides", () => {
    expect(meshVolumeMm3(boxMesh([0, 0, 0], [10, 4, 2.5]))).toBeCloseTo(100, 9);
  });

  it("reports a positive volume for an inward-wound mesh", () => {
    const outward = boxMesh([0, 0, 0], [20, 20, 20]);
    const inward: MaterialMesh = { vertices: outward.vertices, faces: outward.faces.map(([a, b, c]) => [a, c, b] as const) };
    expect(meshVolumeMm3(inward)).toBeCloseTo(8000, 9);
  });

  it("measures a tetrahedron against its closed form", () => {
    // The corner tetrahedron on legs of length s has volume s^3 / 6.
    expect(meshVolumeMm3(tetrahedronMesh(6))).toBeCloseTo(216 / 6, 9);
    expect(meshVolumeMm3(tetrahedronMesh(1))).toBeCloseTo(1 / 6, 12);
  });

  it("is zero for a mesh with no triangles", () => {
    expect(meshVolumeMm3({ vertices: boxMesh([0, 0, 0], [20, 20, 20]).vertices, faces: [] })).toBe(0);
  });
});

describe("mesh volume centroid", () => {
  it("finds the centre of an off-origin box, not its bounding extents alone", () => {
    const centre = meshVolumeCentroid(boxMesh([12, -5, 7.5], [10, 20, 30]));
    expect(centre[0]).toBeCloseTo(12, 9);
    expect(centre[1]).toBeCloseTo(-5, 9);
    expect(centre[2]).toBeCloseTo(7.5, 9);
  });

  it("finds a tetrahedron's centroid at a quarter of each leg", () => {
    const centre = meshVolumeCentroid(tetrahedronMesh(8));
    centre.forEach((value) => expect(value).toBeCloseTo(2, 9));
  });
});

describe("material presets", () => {
  it("prices and weighs with PLA at the documented density", () => {
    const pla = materialPreset("pla");
    expect(pla?.density).toBe(1.24);
    // 20 mm cube = 8000 mm3 = 8 cm3; 8 x 1.24 = 9.92 g.
    expect(materialWeightGrams(8000, 1.24)).toBeCloseTo(9.92, 10);
    // 9.92 g of a 20/kg filament is 0.1984.
    expect(materialCost(9.92, 20)).toBeCloseTo(0.1984, 10);
  });

  it("weighs a 100 mm cube of each preset against volume x density", () => {
    // 100 mm cube = 1,000,000 mm3 = 1000 cm3, so grams = density x 1000.
    MATERIAL_PRESETS.forEach((preset) => {
      expect(materialWeightGrams(1_000_000, preset.density)).toBeCloseTo(preset.density * 1000, 6);
    });
    expect(materialWeightGrams(1_000_000, 1.27)).toBeCloseTo(1270, 6);
  });

  it("converts cubic millimetres to cubic centimetres by a thousand", () => {
    expect(cubicMillimetersToCubicCentimeters(8000)).toBe(8);
    expect(cubicMillimetersToCubicCentimeters(1)).toBe(0.001);
  });

  it("keeps every preset's density in the plausible polymer range and its id unique", () => {
    const ids = MATERIAL_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_MATERIAL_ID);
    MATERIAL_PRESETS.forEach((preset) => {
      expect(preset.density).toBeGreaterThan(0.8);
      expect(preset.density).toBeLessThan(2.5);
      expect(preset.defaultPricePerKg).toBeGreaterThan(0);
    });
  });

  it("recognises known ids and refuses anything else", () => {
    expect(isMaterialId("petg")).toBe(true);
    expect(isMaterialId("unobtainium")).toBe(false);
    expect(isMaterialId(undefined)).toBe(false);
    expect(materialPreset(undefined)).toBeUndefined();
    expect(materialPreset("unobtainium")).toBeUndefined();
  });
});

describe("material price overrides", () => {
  it("prefers the user's price over the preset default", () => {
    expect(materialPricePerKg("pla")).toBe(20);
    expect(materialPricePerKg("pla", { pla: 32.5 })).toBe(32.5);
    expect(materialPricePerKg("pla", { petg: 99 })).toBe(20);
  });

  it("falls back to the default for a price that cannot be used", () => {
    expect(materialPricePerKg("pla", { pla: Number.NaN })).toBe(20);
    expect(materialPricePerKg("pla", { pla: -5 })).toBe(20);
  });

  it("accepts a free material at zero", () => {
    expect(materialPricePerKg("pla", { pla: 0 })).toBe(0);
  });

  it("caps an absurd price rather than carrying it into the readout", () => {
    expect(materialPricePerKg("pla", { pla: 1e12 })).toBe(MAX_MATERIAL_PRICE_PER_KG);
  });

  it("normalizes stored prices down to known materials and usable numbers", () => {
    expect(normalizeMaterialPrices({ pla: 25, petg: "19", unobtainium: 400, abs: -1, asa: 1e12 }))
      .toEqual({ pla: 25, asa: MAX_MATERIAL_PRICE_PER_KG });
    expect(normalizeMaterialPrices(undefined)).toEqual({});
    expect(normalizeMaterialPrices("nonsense")).toEqual({});
    expect(normalizeMaterialPrices([1, 2, 3])).toEqual({});
  });

  it("keeps the fallback prices when the stored value is missing entirely", () => {
    expect(normalizeMaterialPrices(undefined, { pla: 27 })).toEqual({ pla: 27 });
    // A present-but-empty map is a real choice to have no overrides.
    expect(normalizeMaterialPrices({}, { pla: 27 })).toEqual({});
  });
});

describe("shape material estimate", () => {
  it("gives the closed-form weight and cost of a PLA cube", () => {
    const estimate = shapeMaterialEstimate(shape({ material: "pla" }), 8000);
    expect(estimate?.volumeCm3).toBeCloseTo(8, 10);
    expect(estimate?.grams).toBeCloseTo(9.92, 10);
    expect(estimate?.cost).toBeCloseTo(0.1984, 10);
    expect(estimate?.density).toBe(1.24);
    expect(estimate?.pricePerKg).toBe(20);
  });

  it("follows the user's price into the cost", () => {
    const estimate = shapeMaterialEstimate(shape({ material: "pla" }), 8000, { pla: 40 });
    expect(estimate?.grams).toBeCloseTo(9.92, 10);
    expect(estimate?.cost).toBeCloseTo(0.3968, 10);
  });

  it("weighs a PETG part at PETG's density, not the default", () => {
    // 8 cm3 x 1.27 = 10.16 g.
    expect(shapeMaterialEstimate(shape({ material: "petg" }), 8000)?.grams).toBeCloseTo(10.16, 10);
  });

  it("has nothing to say without a material, for a hole, or for no volume", () => {
    expect(shapeMaterialEstimate(shape({}), 8000)).toBeUndefined();
    expect(shapeMaterialEstimate(shape({ material: "pla", hole: true }), 8000)).toBeUndefined();
    expect(shapeMaterialEstimate(shape({ material: "pla" }), 0)).toBeUndefined();
    expect(shapeMaterialEstimate(shape({ material: "pla" }), -1)).toBeUndefined();
    expect(shapeMaterialEstimate(shape({ material: "pla" }), Number.NaN)).toBeUndefined();
  });

  it("stays quiet for a material a newer build chose, rather than pricing it as PLA", () => {
    expect(shapeMaterialEstimate(shape({ material: "future-polymer" }), 8000)).toBeUndefined();
  });

  it("measures a real mesh end to end", () => {
    const volume = meshVolumeMm3(boxMesh([4, 4, 4], [20, 20, 20]));
    const estimate = shapeMaterialEstimate(shape({ material: "pla" }), volume);
    expect(estimate?.grams).toBeCloseTo(9.92, 6);
  });
});
