import { describe, expect, it } from "vitest";
import { horizontalPlacementWorkplane, normalizePlacementWorkplane, placementWorkplaneFromSurface } from "@constructorfleet/sketchforge-engine/placementWorkplane";

/**
 * The dashboard persists projects by re-serialising them and writing the result
 * back to state, stopping only when the serialisation matches the previous one.
 * A normaliser that never lands on the same value makes that comparison never
 * match, so the effect re-runs until React gives up with "Maximum update depth
 * exceeded" -- which is what a tilted workplane used to do.
 */
const TILTED = {
  origin: { x: 6.20598261170637, y: 7.588034776587263, z: 0.3968728417270333 },
  normal: { x: 0.894427190999916, y: 0.447213595499958, z: 0 },
  xAxis: { x: 0.40824829046386313, y: -0.8164965809277263, z: 0.40824829046386313 },
  zAxis: { x: -0.18257418583505536, y: 0.3651483716701107, z: 0.9128709291752768 },
};

describe("normalizePlacementWorkplane is a fixed point", () => {
  it("returns a tilted workplane unchanged, the case that used to oscillate", () => {
    // It alternated between two values in the last digits, forever.
    const once = normalizePlacementWorkplane(TILTED, 0);
    const twice = normalizePlacementWorkplane(once, 0);
    const thrice = normalizePlacementWorkplane(twice, 0);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(JSON.stringify(thrice)).toBe(JSON.stringify(once));
  });

  it("settles for every workplane the builder can produce", () => {
    const normals = [
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0.894427190999916, y: 0.447213595499958, z: 0 },
      { x: 0.3, y: 0.5, z: -0.81 },
      { x: -0.57735, y: 0.57735, z: 0.57735 },
    ];
    for (const normal of normals) {
      const built = placementWorkplaneFromSurface({ x: 1, y: 2, z: 3 }, normal, { x: 1, y: 0, z: 0 });
      let current = normalizePlacementWorkplane(built, 0);
      const settled = JSON.stringify(current);
      for (let pass = 0; pass < 8; pass += 1) {
        current = normalizePlacementWorkplane(current, 0);
        expect(JSON.stringify(current), `normal ${JSON.stringify(normal)} drifted on pass ${pass + 2}`).toBe(settled);
      }
    }
  });

  it("survives a round trip through JSON, which is how it is stored", () => {
    let current = normalizePlacementWorkplane(TILTED, 0);
    const settled = JSON.stringify(current);
    for (let pass = 0; pass < 5; pass += 1) {
      current = normalizePlacementWorkplane(JSON.parse(JSON.stringify(current)), 0);
      expect(JSON.stringify(current)).toBe(settled);
    }
  });

  it("still rebuilds a frame that is not orthonormal", () => {
    // A hand-written or drifted frame must be repaired, not trusted.
    const skewed = { ...TILTED, xAxis: { x: 1, y: 0, z: 0 } };
    const fixed = normalizePlacementWorkplane(skewed, 0);
    expect(fixed.xAxis).not.toEqual(skewed.xAxis);
    const n = fixed.normal, x = fixed.xAxis;
    expect(n.x * x.x + n.y * x.y + n.z * x.z).toBeCloseTo(0, 9);
    expect(Math.hypot(x.x, x.y, x.z)).toBeCloseTo(1, 9);
  });

  it("rebuilds when the stored z axis points the wrong way", () => {
    const flipped = { ...TILTED, zAxis: { x: -TILTED.zAxis.x, y: -TILTED.zAxis.y, z: -TILTED.zAxis.z } };
    const fixed = normalizePlacementWorkplane(flipped, 0);
    expect(fixed.zAxis.z).toBeCloseTo(TILTED.zAxis.z, 9);
  });

  it("rebuilds when the z axis is missing entirely", () => {
    const { zAxis: _dropped, ...withoutZ } = TILTED;
    const fixed = normalizePlacementWorkplane(withoutZ, 0);
    expect(fixed.zAxis).toBeTruthy();
    expect(Math.hypot(fixed.zAxis.x, fixed.zAxis.y, fixed.zAxis.z)).toBeCloseTo(1, 9);
  });

  it("still falls back for rubbish", () => {
    const flat = horizontalPlacementWorkplane(0);
    expect(normalizePlacementWorkplane(null, 0)).toEqual(flat);
    expect(normalizePlacementWorkplane({ normal: { x: 0, y: 0, z: 0 } }, 0)).toEqual(flat);
  });

  it("keeps the horizontal workplane stable too", () => {
    const flat = horizontalPlacementWorkplane(5);
    expect(JSON.stringify(normalizePlacementWorkplane(flat, 5))).toBe(JSON.stringify(flat));
  });
});
