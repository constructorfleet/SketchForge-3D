import { describe, expect, it } from "vitest";
import { BELOW_SLIDER_MIN_PROPERTIES, placementProperties, signedDegrees, sliderReach, type RangePropertyConfig, type ShapeInspectorUpdate } from "@/lib/shapeProperties";
import type { WorkplaneShape } from "@/types/sketchforge";

const BOUNDS = { halfWidth: 150, halfDepth: 150, maxElevation: 300 };

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "s", name: "s", kind: "box", color: "#000",
    x: 0, z: 0, elevation: 0, size: 20, width: 20, depth: 20, height: 20, rotation: 0,
    ...overrides,
  };
}

function rows(shape: WorkplaneShape, onUpdate: ShapeInspectorUpdate = () => {}) {
  return placementProperties(shape, onUpdate, BOUNDS) as RangePropertyConfig[];
}

const row = (s: WorkplaneShape, id: string) => rows(s).find((r) => r.id === id)!;

describe("signedDegrees", () => {
  it("folds a turn into the half open range the rows show", () => {
    // A shape stored at 350 reads as -10 rather than pinning the slider.
    expect(signedDegrees(350)).toBe(-10);
    expect(signedDegrees(190)).toBe(-170);
    expect(signedDegrees(180)).toBe(180);
    expect(signedDegrees(-190)).toBe(170);
  });

  it("leaves an angle already in range alone", () => {
    for (const angle of [-179, -90, 0, 45, 179, 180]) {
      expect(signedDegrees(angle)).toBe(angle);
    }
  });

  it("folds the two names for half a turn onto one", () => {
    // The range is half open, (-180, 180]: -180 and 180 are the same angle, so
    // the slider never has two positions meaning the same thing.
    expect(signedDegrees(-180)).toBe(180);
  });

  it("wraps multiple turns", () => {
    expect(signedDegrees(720 + 30)).toBe(30);
    expect(signedDegrees(-720 - 30)).toBe(-30);
  });

  it("is 0 for a value that is not a number", () => {
    expect(signedDegrees(Number.NaN)).toBe(0);
    expect(signedDegrees(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("placement rows", () => {
  it("offers a row for each axis of position and rotation", () => {
    expect(rows(shape()).map((r) => r.id)).toEqual([
      "positionX", "positionY", "positionZ", "rotationX", "rotationY", "rotationZ",
    ]);
  });

  it("reads the shape's current placement", () => {
    const s = shape({ x: 12.5, z: -7, elevation: 3, rotation: 45, rotationX: 10, rotationZ: -20 });
    expect(row(s, "positionX").value).toBe(12.5);
    expect(row(s, "positionY").value).toBe(3);
    expect(row(s, "positionZ").value).toBe(-7);
    expect(row(s, "rotationY").value).toBe(45);
    expect(row(s, "rotationX").value).toBe(10);
    expect(row(s, "rotationZ").value).toBe(-20);
  });

  it("treats a missing elevation and rotation as zero", () => {
    const s = shape();
    delete (s as Partial<WorkplaneShape>).elevation;
    expect(row(s, "positionY").value).toBe(0);
    expect(row(s, "rotationX").value).toBe(0);
  });

  it("lets position go negative, which is half the build plate", () => {
    expect(row(shape(), "positionX").min).toBe(-150);
    expect(row(shape(), "positionZ").min).toBe(-150);
  });

  it("keeps elevation at or above the plate", () => {
    // Below the workplane is not somewhere a shape is placed by typing.
    expect(row(shape(), "positionY").min).toBe(0);
  });

  it("spans a full turn each way for rotation", () => {
    for (const id of ["rotationX", "rotationY", "rotationZ"]) {
      expect(row(shape(), id).min).toBe(-180);
      expect(row(shape(), id).max).toBe(180);
    }
  });

  it("steps finely enough for the decimals the request asks for", () => {
    expect(row(shape(), "positionX").step).toBe(0.1);
    expect(row(shape(), "rotationY").step).toBe(1);
  });

  it("writes the field it owns and nothing else", () => {
    const patches: Partial<WorkplaneShape>[] = [];
    const written = rows(shape(), (patch) => patches.push(patch));
    written.forEach((r) => r.onChange(5));
    expect(patches).toEqual([
      { x: 5 }, { elevation: 5 }, { z: 5 }, { rotationX: 5 }, { rotation: 5 }, { rotationZ: 5 },
    ]);
  });

  it("accepts negative and fractional values, as the request asks", () => {
    const patches: Partial<WorkplaneShape>[] = [];
    const written = rows(shape(), (patch) => patches.push(patch));
    written.find((r) => r.id === "positionX")!.onChange(-12.75);
    written.find((r) => r.id === "rotationY")!.onChange(-90);
    expect(patches).toEqual([{ x: -12.75 }, { rotation: -90 }]);
  });

  it("spans the build plate while the shape is on it", () => {
    for (const x of [0, 149.9, -149.9]) {
      expect(row(shape({ x }), "positionX").max).toBe(150);
      expect(row(shape({ x }), "positionX").min).toBe(-150);
    }
    expect(row(shape({ elevation: 299 }), "positionY").max).toBe(300);
  });

  it("widens to keep a shape beyond the plate inside the slider", () => {
    for (const [x, reach] of [[150, 300], [-150, 300], [400, 600], [-650, 1200], [5000, 9600]]) {
      const position = row(shape({ x }), "positionX");
      expect([position.min, position.max], `x ${x}`).toEqual([-reach, reach]);
      expect(position.value).toBe(x);
    }
    expect(row(shape({ z: -400 }), "positionZ").min).toBe(-600);
    expect(row(shape({ elevation: 900 }), "positionY").max).toBe(1200);
  });

  it("shows a shape dragged below the plate at its real height", () => {
    const lowered = row(shape({ elevation: -40 }), "positionY");
    expect(lowered.value).toBe(-40);
    expect(lowered.min).toBe(-300);
  });

  it("lets a typed X or Z go past the slider minimum", () => {
    expect([...BELOW_SLIDER_MIN_PROPERTIES].sort()).toEqual(["positionX", "positionZ"]);
  });
});

describe("sliderReach", () => {
  it("doubles the base until the value is strictly inside it", () => {
    expect(sliderReach(100, 0)).toBe(100);
    expect(sliderReach(100, 99.9)).toBe(100);
    expect(sliderReach(100, 100)).toBe(200);
    expect(sliderReach(100, -250)).toBe(400);
  });

  it("falls back to the base for values it cannot span", () => {
    expect(sliderReach(100, Number.NaN)).toBe(100);
    expect(sliderReach(100, Number.POSITIVE_INFINITY)).toBe(100);
    expect(sliderReach(0, 5)).toBe(8);
  });
});
