import { describe, expect, it } from "vitest";
import {
  getShapePropertiesWithAppLimits,
  getShapeTaperProperties,
  propertyUsesLengthUnit,
  type RangePropertyConfig,
  type ShapePropertyConfig,
} from "@/lib/shapeProperties";
import type { ShapeKind, WorkplaneShape } from "@/types/sketchforge";

const SHAPE_KINDS: ShapeKind[] = [
  "box", "cylinder", "sphere", "sketch", "scribble", "cone", "pyramid", "roof",
  "text", "roundRoof", "halfSphere", "torus", "tube", "gear", "ring", "wedge",
  "polygon", "icosahedron", "mesh",
];

function shapeOfKind(kind: ShapeKind, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: `shape-${kind}`,
    name: kind,
    kind,
    color: "#0098c7",
    x: 0,
    z: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 20,
    rotation: 0,
    ...overrides,
  };
}

// Every branch of the property list, not just the per-kind default: the
// revolve and gear-variant branches declare their own rows, and the taper rows
// are built by a separate function.
function everyPropertyVariant(): ShapePropertyConfig[] {
  const shapes: WorkplaneShape[] = [
    ...SHAPE_KINDS.map((kind) => shapeOfKind(kind)),
    ...SHAPE_KINDS.map((kind) => shapeOfKind(kind, { taperTopWidth: 10, taperTopDepth: 10, taperBottomWidth: 20, taperBottomDepth: 20 })),
    shapeOfKind("sketch", { sketchOperation: "revolve" }),
    shapeOfKind("scribble", { sketchRevolve: { startAngle: 0, sweepAngle: 360, sides: 96 } }),
    shapeOfKind("gear", { gearType: "spur" }),
    shapeOfKind("gear", { gearType: "helical" }),
    shapeOfKind("gear", { gearType: "bevel" }),
  ];
  return shapes.flatMap((shape) => [
    ...getShapePropertiesWithAppLimits(shape, () => {}),
    ...getShapeTaperProperties(shape, () => {}, 480),
  ]);
}

function rangeProperties() {
  return everyPropertyVariant().filter(
    (property): property is RangePropertyConfig => property.type === undefined || property.type === "range",
  );
}

// The label lists these assertions compare against are the pre-#89 behaviour,
// kept in shapeProperties as the fallback for an unannotated property. They
// are English-only, so a translated build would silently stop matching them:
// these tests fail if a length property is ever added without the explicit
// configuration that replaced them.
describe("shape inspector property configuration", () => {
  it("covers every branch that declares a length property", () => {
    const labels = new Set(rangeProperties().map((property) => property.label));
    // Default rows, the revolve branch, gear teeth/helix rows, and taper rows.
    for (const label of ["Length", "Width", "Height", "Start Angle", "Sweep", "Tooth Size", "Tooth Width", "Center Hole", "Helix Angle", "Top Length", "Bottom Width"]) {
      expect(labels, `missing coverage for ${label}`).toContain(label);
    }
  });

  it("declares a length unit on every property the label list would have matched", () => {
    const unannotated = rangeProperties()
      .filter((property) => propertyUsesLengthUnit(property.label) && property.unit !== "length")
      .map((property) => property.label);
    expect([...new Set(unannotated)]).toEqual([]);
  });

  it("never marks a non-length property as a length", () => {
    const mislabelled = rangeProperties()
      .filter((property) => property.unit === "length" && !propertyUsesLengthUnit(property.label))
      .map((property) => property.label);
    expect([...new Set(mislabelled)]).toEqual([]);
  });

  it("keeps allowsAboveSliderMax matching the label rule it replaced", () => {
    const legacyAllowsAboveSliderMax = (label: string) =>
      label === "Length" || label === "Width" || label === "Height"
      || label.endsWith(" Length") || label.endsWith(" Width");

    const diverged = rangeProperties()
      .filter((property) => (property.allowsAboveSliderMax ?? false) !== legacyAllowsAboveSliderMax(property.label))
      .map((property) => `${property.label}=${property.allowsAboveSliderMax ?? false}`);
    expect([...new Set(diverged)]).toEqual([]);
  });
});
