import { describe, expect, it } from "vitest";
import {
  buildAngles,
  DEFAULT_LOFT_BOTTOM_SHAPE,
  DEFAULT_LOFT_LAYERS,
  DEFAULT_LOFT_ROTATION,
  DEFAULT_LOFT_SEGMENTS,
  DEFAULT_LOFT_TOP_SHAPE,
  isPolygonLoftShape,
  loftSettings,
  normalizeLoftLayers,
  normalizeLoftRotation,
  normalizeLoftSegments,
  normalizeLoftShape,
  normalizeLoftTopSize,
  shapeCorners,
  shapePoint,
  smootherstep,
} from "@sketchforge/engine/loftProfile";
import type { LoftProfileShape } from "@/types/sketchforge";

// These were only ever reachable through `createLoftGeometry`, which meant every assertion about
// them had to be made about a mesh. Splitting the mesh builder out into `loftMesh` makes the
// profile maths directly callable, so the invariants the long comments in `loftProfile` describe
// can be asserted as invariants instead of inferred from vertex positions.

const PROFILE_SHAPES: LoftProfileShape[] = ["Oval", "Rectangle", "Triangle", "Pentagon", "Hexagon"];
const DEG = Math.PI / 180;

/** Shoelace area and area-centroid of a closed 2D ring, in the ring's own winding. */
function ringAreaAndCentroid(points: Array<[number, number]>) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;
  return { area, cx: cx / (6 * area), cy: cy / (6 * area) };
}

function sampleRing(kind: LoftProfileShape, halfX: number, halfY: number, rotation: number, count: number) {
  const corners = shapeCorners(kind, halfX, halfY, rotation);
  const angles = buildAngles(corners, corners, count, rotation, rotation);
  return angles.map((angle) => shapePoint(kind, angle.aBottom, halfX, halfY, rotation));
}

describe("loft normalizers", () => {
  it("falls back to the stored defaults, and to a caller's own fallback when it gives one", () => {
    expect(normalizeLoftShape(undefined)).toBe(DEFAULT_LOFT_BOTTOM_SHAPE);
    expect(normalizeLoftShape("not a shape")).toBe(DEFAULT_LOFT_BOTTOM_SHAPE);
    expect(normalizeLoftShape(undefined, DEFAULT_LOFT_TOP_SHAPE)).toBe(DEFAULT_LOFT_TOP_SHAPE);
    expect(normalizeLoftShape("not a shape", "Hexagon")).toBe("Hexagon");
    // A stored value spelled differently is not a loft shape: the union is exact, not case-folded.
    expect(normalizeLoftShape("hexagon", "Pentagon")).toBe("Pentagon");
    for (const kind of PROFILE_SHAPES) expect(normalizeLoftShape(kind, "Oval")).toBe(kind);
  });

  it("wraps a rotation into [0, 360) and treats a missing or broken one as the default", () => {
    expect(normalizeLoftRotation(37)).toBe(37);
    expect(normalizeLoftRotation(397)).toBe(37);
    expect(normalizeLoftRotation(-37)).toBe(323);
    expect(normalizeLoftRotation(-397)).toBe(323);
    expect(normalizeLoftRotation(359.97)).toBe(0);
    expect(normalizeLoftRotation(undefined)).toBe(DEFAULT_LOFT_ROTATION);
    expect(normalizeLoftRotation(Number.NaN)).toBe(DEFAULT_LOFT_ROTATION);
    expect(normalizeLoftRotation(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LOFT_ROTATION);
  });

  it("clamps and rounds segments and layers, which are separate ranges", () => {
    expect(normalizeLoftSegments(37)).toBe(37);
    expect(normalizeLoftSegments(36.6)).toBe(37);
    expect(normalizeLoftSegments(7)).toBe(8);
    expect(normalizeLoftSegments(129)).toBe(128);
    expect(normalizeLoftSegments(undefined)).toBe(DEFAULT_LOFT_SEGMENTS);
    expect(normalizeLoftSegments(Number.NaN)).toBe(DEFAULT_LOFT_SEGMENTS);

    expect(normalizeLoftLayers(37)).toBe(37);
    expect(normalizeLoftLayers(36.6)).toBe(37);
    expect(normalizeLoftLayers(1)).toBe(2);
    expect(normalizeLoftLayers(81)).toBe(80);
    expect(normalizeLoftLayers(undefined)).toBe(DEFAULT_LOFT_LAYERS);
    expect(normalizeLoftLayers(Number.NaN)).toBe(DEFAULT_LOFT_LAYERS);
    // The two ranges are not the same range: 100 is in neither, 90 only in neither, 60 in both.
    expect(normalizeLoftSegments(100)).toBe(100);
    expect(normalizeLoftLayers(100)).toBe(80);
  });

  it("keeps a top dimension strictly positive and only falls back when it is unusable", () => {
    expect(normalizeLoftTopSize(14, 37)).toBe(14);
    expect(normalizeLoftTopSize(undefined, 37)).toBe(37);
    expect(normalizeLoftTopSize(Number.NaN, 37)).toBe(37);
    expect(normalizeLoftTopSize(0, 37)).toBe(0.01);
    expect(normalizeLoftTopSize(-14, 37)).toBe(0.01);
    // A fallback that is itself unusable is floored too, not passed through.
    expect(normalizeLoftTopSize(undefined, -37)).toBe(0.01);
  });

  it("counts only the regular polygons as polygon ends", () => {
    expect(PROFILE_SHAPES.filter(isPolygonLoftShape)).toEqual(["Triangle", "Pentagon", "Hexagon"]);
  });

  it("routes every loft field through its own normalizer, with no two fields crossed", () => {
    // Every input is distinct and every expected output differs from every other, so swapping any
    // two fields -- bottom/top shape, bottom/top rotation, segments/layers -- changes the result.
    expect(loftSettings({
      loftBottomShape: "Triangle",
      loftTopShape: "Hexagon",
      loftBottomRotation: 397,
      loftTopRotation: -37,
      loftSegments: 7,
      loftLayers: 81,
    })).toEqual({
      bottomShape: "Triangle",
      topShape: "Hexagon",
      bottomRotation: 37,
      topRotation: 323,
      segments: 8,
      layers: 80,
    });
  });

  it("gives each end its own default when the stored shape has no loft fields at all", () => {
    expect(loftSettings({})).toEqual({
      bottomShape: DEFAULT_LOFT_BOTTOM_SHAPE,
      topShape: DEFAULT_LOFT_TOP_SHAPE,
      bottomRotation: DEFAULT_LOFT_ROTATION,
      topRotation: DEFAULT_LOFT_ROTATION,
      segments: DEFAULT_LOFT_SEGMENTS,
      layers: DEFAULT_LOFT_LAYERS,
    });
    expect(DEFAULT_LOFT_BOTTOM_SHAPE).not.toBe(DEFAULT_LOFT_TOP_SHAPE);
  });
});

describe("loft profile maths", () => {
  it("blends with zero slope at both ends and passes through the midpoint", () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 12);
    expect(smootherstep(-3)).toBe(0);
    expect(smootherstep(4)).toBe(1);
    // Smootherstep, not linear: a quarter of the way along it has gone far less than a quarter.
    expect(smootherstep(0.25)).toBeLessThan(0.25);
    expect(smootherstep(0.25)).toBeCloseTo(0.103515625, 12);
    expect(smootherstep(0.75)).toBeCloseTo(1 - smootherstep(0.25), 12);
  });

  it("reports one corner angle per side, and none for a smooth end", () => {
    expect(shapeCorners("Oval", 19, 13, 0)).toEqual([]);
    expect(shapeCorners("Rectangle", 19, 13, 0)).toHaveLength(4);
    expect(shapeCorners("Triangle", 19, 13, 0)).toHaveLength(3);
    expect(shapeCorners("Pentagon", 19, 13, 0)).toHaveLength(5);
    expect(shapeCorners("Hexagon", 19, 13, 0)).toHaveLength(6);
  });

  it("puts a rectangle's corners where its half-extents actually are, not on the diagonals", () => {
    // halfX != halfY, so a 45-degree answer would mean the corner angle ignores the aspect ratio.
    const [first] = shapeCorners("Rectangle", 19, 13, 0);
    expect(first).toBeCloseTo(Math.atan2(13, 19), 12);
    expect(first).not.toBeCloseTo(Math.PI / 4, 3);
  });

  it("offsets every corner by the end's own rotation", () => {
    const rotation = 37 * DEG;
    const unrotated = shapeCorners("Pentagon", 19, 13, 0);
    const rotated = shapeCorners("Pentagon", 19, 13, rotation);
    expect(rotated).toHaveLength(unrotated.length);
    rotated.forEach((angle, index) => expect(angle).toBeCloseTo(unrotated[index] + rotation, 12));
  });

  it.each(PROFILE_SHAPES)("spins a %s end rigidly rather than reshaping it", (kind) => {
    // The invariant behind `shapePoint`'s `angle - rotation` step: sampling a rotated end at a
    // correspondingly advanced angle must give the unrotated point, turned. A non-right-angle
    // rotation and halfX != halfY keep an aspect-blind or sign-flipped rotation from passing.
    const rotation = 37 * DEG;
    for (let i = 0; i < 12; i += 1) {
      const angle = (i * 2 * Math.PI) / 12 + 0.17;
      const [x, y] = shapePoint(kind, angle, 19, 13, 0);
      const [rx, ry] = shapePoint(kind, angle + rotation, 19, 13, rotation);
      expect(rx).toBeCloseTo(x * Math.cos(rotation) - y * Math.sin(rotation), 9);
      expect(ry).toBeCloseTo(x * Math.sin(rotation) + y * Math.cos(rotation), 9);
    }
  });

  it("samples a rectangle end on its own edges, so the ring closes the requested box exactly", () => {
    const [x0, y0] = shapePoint("Rectangle", 0, 19, 13, 0);
    expect(x0).toBeCloseTo(19, 12);
    expect(y0).toBeCloseTo(0, 12);
    const [x1, y1] = shapePoint("Rectangle", Math.PI / 2, 19, 13, 0);
    expect(x1).toBeCloseTo(0, 12);
    expect(y1).toBeCloseTo(13, 12);

    // Area, not extents: a ring that reached the right extents by cutting the corners off would
    // have the right bounding box and the wrong area.
    const { area } = ringAreaAndCentroid(sampleRing("Rectangle", 19, 13, 0, 32));
    expect(Math.abs(area)).toBeCloseTo(38 * 26, 6);
  });

  it("samples an oval end on its own ellipse", () => {
    const { area } = ringAreaAndCentroid(sampleRing("Oval", 19, 13, 0, 512));
    expect(Math.abs(area)).toBeCloseTo(Math.PI * 19 * 13, 1);
  });

  it.each<[LoftProfileShape, number]>([["Triangle", 3], ["Pentagon", 5], ["Hexagon", 6]])(
    "centres a %s on its circumcenter, not on its bounding box",
    (kind, sides) => {
      // The comment this protects: "Triangle/Pentagon are centered on their true circumcenter
      // (origin), not their bounding box ... Don't 'fix' that by recentring the bbox". For an odd
      // polygon the area centroid IS the circumcenter, while the bbox centre is not -- so a
      // recentring regression moves the centroid off the origin by a known, non-zero amount. The
      // bounding box cannot see that, which is why this measures area and centroid.
      const radius = 19;
      const points = sampleRing(kind, radius, 13, 0, sides * 8);
      const { area, cx, cy } = ringAreaAndCentroid(points);
      expect(Math.abs(area)).toBeCloseTo((sides / 2) * radius * radius * Math.sin((2 * Math.PI) / sides), 6);
      expect(cx).toBeCloseTo(0, 9);
      expect(cy).toBeCloseTo(0, 9);
      // halfY is deliberately ignored for a polygon end: the ring is the circumcircle's, so the
      // apex sits a full circumradius out even though halfY is much smaller.
      const apex = Math.max(...points.map(([, y]) => y));
      expect(apex).toBeCloseTo(radius, 6);
      expect(apex).toBeGreaterThan(13);
    },
  );

  it("places every corner of both ends on a ring vertex and spends the rest of the budget between them", () => {
    const bottom = shapeCorners("Rectangle", 19, 13, 0);
    const top = shapeCorners("Hexagon", 17, 17, 37 * DEG);
    const angles = buildAngles(bottom, top, 32, 0, 37 * DEG);
    expect(angles).toHaveLength(32);

    const near = (want: number, have: number[]) => have.some((a) => {
      const d = Math.abs(a - want) % (2 * Math.PI);
      return Math.min(d, 2 * Math.PI - d) < 1e-9;
    });
    for (const corner of bottom) expect(near(corner, angles.map((a) => a.aBottom))).toBe(true);
    for (const corner of top) expect(near(corner, angles.map((a) => a.aTop))).toBe(true);
  });

  it("never spends fewer vertices than there are corners, however small the segment budget", () => {
    const corners = shapeCorners("Hexagon", 17, 17, 0);
    expect(buildAngles(corners, corners, 1, 0, 0)).toHaveLength(6);
    expect(buildAngles(corners, corners, 6, 0, 0)).toHaveLength(6);
    expect(buildAngles(corners, corners, 7, 0, 0)).toHaveLength(7);
  });

  it("keeps both ends' angle streams monotonic, however the two ends are rotated", () => {
    // This is the invariant the per-stream `forwardDelta` in `buildAngles` exists to hold: the
    // two streams are independently matched, so each may wrap somewhere the other does not. A
    // non-monotonic stream is a self-crossing (non-manifold) ring, which a volume test on the
    // finished mesh sees only as a sign flip and a corner-count test cannot see at all.
    for (const bottomShape of PROFILE_SHAPES) {
      for (const topShape of PROFILE_SHAPES) {
        for (const [bottomDeg, topDeg] of [[0, 0], [37, 0], [0, 37], [40, -65], [170, 11], [25, 115]]) {
          const bottomRotation = bottomDeg * DEG;
          const topRotation = topDeg * DEG;
          const angles = buildAngles(
            shapeCorners(bottomShape, 19, 13, bottomRotation),
            shapeCorners(topShape, 17, 11, topRotation),
            24,
            bottomRotation,
            topRotation,
          );
          const label = `${bottomShape}@${bottomDeg} -> ${topShape}@${topDeg}`;
          for (const stream of ["aBottom", "aTop"] as const) {
            const values = angles.map((a) => a[stream]);
            let wraps = 0;
            for (let i = 1; i < values.length; i += 1) if (values[i] <= values[i - 1]) wraps += 1;
            // At most the single seam where the ring closes, and the whole ring must cover
            // exactly one turn -- not zero (a collapsed stream) and not two (a doubled-back one).
            expect(wraps, label).toBeLessThanOrEqual(1);
            const span = values.reduce((most, value, i) => (i === 0 ? 0 : Math.max(most, value - values[0])), 0);
            expect(span, label).toBeLessThan(2 * Math.PI + 1e-9);
          }
        }
      }
    }
  });

  it("matches a square's corners to their nearest partner when the two ends are a quarter-turn apart", () => {
    // A square has 90-degree symmetry, so a 0-degree and a 90-degree square are the same corner
    // set: a correct matcher pairs each bottom corner with a coincident top corner, leaving the
    // two streams a constant 90 degrees apart rather than twisting between them.
    const bottom = shapeCorners("Rectangle", 17, 17, 0);
    const top = shapeCorners("Rectangle", 17, 17, 90 * DEG);
    const angles = buildAngles(bottom, top, 4, 0, 90 * DEG);
    expect(angles).toHaveLength(4);
    for (const { aBottom, aTop } of angles) {
      const [bx, by] = shapePoint("Rectangle", aBottom, 17, 17, 0);
      const [tx, ty] = shapePoint("Rectangle", aTop, 17, 17, 90 * DEG);
      expect(tx).toBeCloseTo(bx, 6);
      expect(ty).toBeCloseTo(by, 6);
    }
  });

  it("pairs each corner with its nearest partner, not with whichever one the loop reaches first", () => {
    // The square case above cannot see this: a square's corner set is unchanged by a quarter
    // turn, so after normalizeCorners both ends hold the *same four numbers* and every pairing
    // -- including no pairing at all -- gives the same answer. A 4-corner end against a 6-corner
    // one is the case that separates them. A 19x13 rectangle's corners sit 4.4 degrees from a
    // hexagon's, so the best matching pairs every anchor within about that; a matcher that
    // ignored the angular cost and took corners in index order would leave pairs 55, 64 and 116
    // degrees apart, and every corner would still land on a ring vertex, so corner coverage
    // alone cannot see it either.
    const bottom = shapeCorners("Rectangle", 19, 13, 0);
    const top = shapeCorners("Hexagon", 17, 17, 0);
    const angles = buildAngles(bottom, top, 6, 0, 0);
    expect(angles).toHaveLength(6);
    for (const { aBottom, aTop } of angles) {
      const raw = Math.abs(aBottom - aTop) % (2 * Math.PI);
      expect(Math.min(raw, 2 * Math.PI - raw)).toBeLessThan(5 * DEG);
    }
  });

  it("finds the nearest pairing whichever corner the two ends' seams happen to fall between", () => {
    // The matcher's subsequence DP aligns the two corner lists starting from one index, so it has
    // to try every rotational offset: the best pairing frequently wraps past the point where the
    // sorted lists begin, and a matcher that only tried offset zero would pair across the seam
    // instead of around it. That is invisible whenever the two ends are unrotated or a symmetry
    // period apart -- the cases a loft test reaches for first -- so these pairs are deliberately
    // at angles with no relationship to either end's symmetry.
    const circular = (a: number, b: number) => {
      const raw = Math.abs(a - b) % (2 * Math.PI);
      return Math.min(raw, 2 * Math.PI - raw);
    };
    // Equal corner counts on both ends, so every corner is matched and the whole matching is one
    // cyclic shift -- which makes "nearest" exact and checkable, rather than the order-preserving
    // compromise an unequal pair has to settle for. Each relative rotation is deliberately not a
    // multiple of either end's symmetry period, so the correct shift is not the identity.
    const cases: Array<[LoftProfileShape, number, number]> = [
      ["Rectangle", 0, 33],
      ["Rectangle", 11, 85],
      ["Triangle", 5, 25],
      ["Pentagon", 23, 40],
      ["Hexagon", 41, 17],
    ];
    for (const [kind, bottomDeg, topDeg] of cases) {
      const bottomRotation = bottomDeg * DEG;
      const topRotation = topDeg * DEG;
      const bottom = shapeCorners(kind, 19, 13, bottomRotation);
      const top = shapeCorners(kind, 17, 11, topRotation);
      const angles = buildAngles(bottom, top, 12, bottomRotation, topRotation);
      const label = `${kind}@${bottomDeg} -> ${kind}@${topDeg}`;
      expect(bottom.length, label).toBe(top.length);

      // The worst any corner has to reach for its own nearest partner on the other end. With the
      // counts equal, the nearest matching achieves this for every corner, so anything further
      // apart is a pairing the matcher should have rejected.
      const worstNearest = Math.max(...bottom.map((a) => Math.min(...top.map((b) => circular(a, b)))));
      for (const { aBottom, aTop } of angles) {
        expect(circular(aBottom, aTop), label).toBeLessThanOrEqual(worstNearest + 1e-9);
      }
    }
  });

  it("re-expresses a corner-less end's angles in its own frame so it spins rigidly", () => {
    // fallbackSmallAngle's zero-match branch, reported by a user against the mesh: an Oval top
    // has no corners, so every ring point takes that branch. Sampling the resulting stream must
    // give a rigidly turned ellipse -- same area, centroid still on the circumcenter.
    const rotation = 37 * DEG;
    const bottom = shapeCorners("Rectangle", 19, 13, 0);
    const angles = buildAngles(bottom, [], 8, 0, rotation);
    const ring = angles.map((angle) => shapePoint("Oval", angle.aTop, 19, 13, rotation));
    const spun = angles.map((angle) => shapePoint("Oval", angle.aTop, 19, 13, 0));
    const turned = ringAreaAndCentroid(ring);
    const flat = ringAreaAndCentroid(spun);
    expect(Math.abs(turned.area)).toBeCloseTo(Math.abs(flat.area), 6);
    expect(turned.cx).toBeCloseTo(0, 9);
    expect(turned.cy).toBeCloseTo(0, 9);
  });
});
