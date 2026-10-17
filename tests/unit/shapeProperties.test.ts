import { describe, expect, it } from "vitest";
import { translatorFor } from "@/i18n/translator";
import {
  ABOVE_SLIDER_MAX_PROPERTIES,
  LENGTH_UNIT_PROPERTIES,
  getShapePropertiesWithAppLimits,
  getShapeTaperProperties,
  propertyUsesLengthUnit,
  type RangePropertyConfig,
  type ShapePropertyConfig,
  type ShapePropertyId,
} from "@/lib/shapeProperties";
import type { ShapeKind, WorkplaneShape } from "@/types/sketchforge";

const en = translatorFor("en");

const SHAPE_KINDS: ShapeKind[] = [
  "box", "cylinder", "sphere", "sketch", "scribble", "cone", "pyramid", "roof",
  "text", "roundRoof", "halfSphere", "torus", "tube", "gear", "ring", "wedge",
  "polygon", "icosahedron", "mesh", "loft",
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

// Every branch of the property list, not just the per-kind default: the revolve
// and gear-variant branches declare their own rows, the loft rows depend on each
// end's profile, and the taper rows are built by a separate function.
function everyPropertyVariant(): ShapePropertyConfig[] {
  const shapes: WorkplaneShape[] = [
    ...SHAPE_KINDS.map((kind) => shapeOfKind(kind)),
    ...SHAPE_KINDS.map((kind) => shapeOfKind(kind, { taperTopWidth: 10, taperTopDepth: 10, taperBottomWidth: 20, taperBottomDepth: 20 })),
    shapeOfKind("sketch", { sketchOperation: "revolve" }),
    shapeOfKind("scribble", { sketchRevolve: { startAngle: 0, sweepAngle: 360, sides: 96, quality: 6 } }),
    shapeOfKind("gear", { gearType: "spur" }),
    shapeOfKind("gear", { gearType: "helical" }),
    shapeOfKind("gear", { gearType: "bevel" }),
    shapeOfKind("loft", { loftTopShape: "Oval", loftBottomShape: "Oval" }),
    shapeOfKind("loft", { loftTopShape: "Hexagon", loftBottomShape: "Triangle" }),
  ];
  return shapes.flatMap((shape) => [
    ...getShapePropertiesWithAppLimits(shape, () => {}),
    ...getShapeTaperProperties(shape, () => {}, 480),
  ]);
}

const declaredIds = () => [...new Set(everyPropertyVariant().map((property) => property.id))];
const rangeProperties = () => everyPropertyVariant().filter(
  (property): property is RangePropertyConfig => property.type === undefined || property.type === "range",
);

// Rows are keyed on a stable ShapePropertyId, never on their visible text: the
// id picks the label message and drives the unit and slider-overflow rules, so
// none of it changes with the interface language. These tests fail if a row is
// added without a label message, or if either rule drifts from the English
// label rules they replaced.
describe("shape inspector property configuration", () => {
  it("covers every branch that declares properties", () => {
    const ids = new Set(declaredIds());
    for (const id of ["length", "width", "height", "startAngle", "sweep", "toothSize", "toothWidth", "centerHole", "helixAngle", "topLength", "bottomWidth", "topShape", "bottomRotation", "layers", "text", "font"] as ShapePropertyId[]) {
      expect(ids, `missing coverage for ${id}`).toContain(id);
    }
  });

  it("has a label message for every property it declares", () => {
    const unlabelled = declaredIds().filter((id) => {
      const label = en(`panels.property.${id}` as Parameters<typeof en>[0]);
      return !label || label.includes(`panels.property.${id}`);
    });
    expect(unlabelled).toEqual([]);
  });

  it("keeps the unit rule matching the English label rule it replaced", () => {
    const LENGTH_LABELS = ["Radius", "Length", "Width", "Height", "Bevel", "Top Radius", "Base Radius", "Thickness", "Tooth Size", "Tooth Width", "Center Hole", "Top Length", "Top Width", "Bottom Length", "Bottom Width"];
    const diverged = declaredIds().filter((id) => {
      const label = en(`panels.property.${id}` as Parameters<typeof en>[0]);
      return LENGTH_LABELS.includes(label) !== propertyUsesLengthUnit(id);
    });
    expect(diverged).toEqual([]);
  });

  it("keeps the slider-overflow rule matching the English label rule it replaced", () => {
    const legacy = (label: string) =>
      label === "Length" || label === "Width" || label === "Height"
      || label.endsWith(" Length") || label.endsWith(" Width");
    const diverged = declaredIds().filter((id) => {
      const label = en(`panels.property.${id}` as Parameters<typeof en>[0]);
      return legacy(label) !== ABOVE_SLIDER_MAX_PROPERTIES.includes(id);
    });
    expect(diverged).toEqual([]);
  });

  it("lists no id that nothing declares", () => {
    const declared = new Set(declaredIds());
    // A stale entry in either list is dead configuration: it reads as a rule
    // that applies to something, while no row ever asks for it.
    for (const id of [...LENGTH_UNIT_PROPERTIES, ...ABOVE_SLIDER_MAX_PROPERTIES]) {
      expect(declared, `${id} is listed but never declared`).toContain(id);
    }
  });

  it("never marks a non-range property as a length", () => {
    const ranges = new Set(rangeProperties().map((property) => property.id));
    const nonRange = everyPropertyVariant()
      .filter((property) => property.type === "text" || property.type === "select")
      .map((property) => property.id)
      .filter((id) => !ranges.has(id) && propertyUsesLengthUnit(id));
    expect(nonRange).toEqual([]);
  });
});
