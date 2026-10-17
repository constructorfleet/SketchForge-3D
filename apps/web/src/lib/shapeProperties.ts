// The shape inspector's property list: pure configuration, kept out of the
// component file so it can be exercised without a JSX-capable test setup.
import {
  DEFAULT_GEAR_HELIX_ANGLE,
  DEFAULT_GEAR_HELIX_QUALITY,
  DEFAULT_GEAR_TEETH,
  DEFAULT_GEAR_TOOTH_SIZE,
  MAX_GEAR_HELIX_ANGLE,
  MAX_GEAR_HELIX_QUALITY,
  MIN_GEAR_HELIX_ANGLE,
  MIN_GEAR_HELIX_QUALITY,
  gearCenterHoleLimits,
  gearToothPitch,
  normalizeGearCenterHoleSize,
  normalizeGearHelixAngle,
  normalizeGearHelixQuality,
  normalizeGearToothSize,
  normalizeGearToothWidth,
  normalizeGearType,
} from "@/lib/gearGeometry";
import { normalizeSketchRevolveSettings } from "@/lib/sketchRevolve";
import { MAX_HIGH_RESOLUTION_SIDES } from "@/lib/workplaneSettings";
import { resizedShapeSize, shapeDepth, shapeHasTaper, shapeOverallFootprintDimensions, shapeTaperDimensions, shapeWidth } from "@/lib/workplaneShapes";
import type { GearType, WorkplaneShape } from "@/types/sketchforge";

export const MIN_SHAPE_SIZE = 0.01;
export const TEXT_FONT_OPTIONS = ["Multilanguage", "Sans", "Serif", "Script", "Monospace", "Rounded", "Stencil"];
export const GEAR_TYPE_OPTIONS: Array<{ value: GearType; label: string }> = [
  { value: "spur", label: "Spur gear" },
  { value: "helical", label: "Helical gear" },
  { value: "bevel", label: "Bevel gear" },
];

export type ShapeInspectorUpdateOptions = { resizeAxis?: "width" | "depth" | "height" };
export type ShapeInspectorUpdate = (patch: Partial<WorkplaneShape>, options?: ShapeInspectorUpdateOptions) => void;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export type RangePropertyConfig = {
  type?: "range";
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  // Both fields are optional: when omitted the label lists below are used, so
  // existing property declarations keep working unchanged.
  unit?: "length";
  allowsAboveSliderMax?: boolean;
  onChange: (value: number) => void;
};

export type TextPropertyConfig = {
  type: "text";
  label: string;
  value: string;
  onChange: (value: string) => void;
};

export type SelectPropertyConfig = {
  type: "select";
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
};

export type ShapePropertyConfig = RangePropertyConfig | TextPropertyConfig | SelectPropertyConfig;

export function propertyUsesLengthUnit(label: string) {
  return ["Radius", "Length", "Width", "Height", "Bevel", "Top Radius", "Base Radius", "Thickness", "Tooth Size", "Tooth Width", "Center Hole", "Top Length", "Top Width", "Bottom Length", "Bottom Width"].includes(label);
}

export function getShapePropertiesWithAppLimits(shape: WorkplaneShape, onUpdate: ShapeInspectorUpdate, textWidthMax = 260): ShapePropertyConfig[] {
  const baseWidth = shapeWidth(shape);
  const baseDepth = shapeDepth(shape);
  const footprint = shapeOverallFootprintDimensions(shape);
  const width = footprint.width;
  const depth = footprint.depth;
  const taper = shapeTaperDimensions(shape);
  const widthPatch = (value: number): Partial<WorkplaneShape> => {
    if (!shapeHasTaper(shape)) {
      return { width: value, size: resizedShapeSize(value, baseDepth) };
    }
    const scale = value / Math.max(MIN_SHAPE_SIZE, width);
    const nextBaseWidth = Math.max(MIN_SHAPE_SIZE, baseWidth * scale);
    return {
      width: nextBaseWidth,
      size: resizedShapeSize(nextBaseWidth, baseDepth),
      taperTopWidth: Math.max(MIN_SHAPE_SIZE, taper.topWidth * scale),
      taperBottomWidth: Math.max(MIN_SHAPE_SIZE, taper.bottomWidth * scale),
    };
  };
  const depthPatch = (value: number): Partial<WorkplaneShape> => {
    if (!shapeHasTaper(shape)) {
      return { depth: value, size: resizedShapeSize(baseWidth, value) };
    }
    const scale = value / Math.max(MIN_SHAPE_SIZE, depth);
    const nextBaseDepth = Math.max(MIN_SHAPE_SIZE, baseDepth * scale);
    return {
      depth: nextBaseDepth,
      size: resizedShapeSize(baseWidth, nextBaseDepth),
      taperTopDepth: Math.max(MIN_SHAPE_SIZE, taper.topDepth * scale),
      taperBottomDepth: Math.max(MIN_SHAPE_SIZE, taper.bottomDepth * scale),
    };
  };
  const setWidth = (value: number) => onUpdate(widthPatch(value), { resizeAxis: "width" });
  const setDepth = (value: number) => onUpdate(depthPatch(value), { resizeAxis: "depth" });
  const setConeWidth = (value: number) => {
    const patch = widthPatch(value);
    patch.baseRadius = Math.max(MIN_SHAPE_SIZE, (patch.width ?? baseWidth) / 2);
    onUpdate(patch, { resizeAxis: "width" });
  };
  const setBaseRadius = (value: number) => {
    const diameter = value * 2;
    onUpdate({ baseRadius: value, width: diameter, size: resizedShapeSize(diameter, baseDepth) }, { resizeAxis: "width" });
  };
  const setHeight = (height: number) => onUpdate({ height }, { resizeAxis: "height" });

  if (shape.sketchOperation === "revolve" || shape.sketchRevolve) {
    const settings = normalizeSketchRevolveSettings(shape.sketchRevolve);
    const updateRevolve = (patch: Partial<typeof settings>) => onUpdate({ sketchRevolve: normalizeSketchRevolveSettings({ ...settings, ...patch }) });
    return [
      { label: "Start Angle", value: settings.startAngle, min: 0, max: 359, step: 1, onChange: (startAngle) => updateRevolve({ startAngle }) },
      { label: "Sweep", value: settings.sweepAngle, min: -360, max: 360, step: 1, onChange: (sweepAngle) => updateRevolve({ sweepAngle }) },
      { label: "Sides", value: settings.sides, min: 3, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => updateRevolve({ sides }) },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "box") {
    return [
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "cylinder") {
    return [
      { label: "Sides", value: shape.sides ?? 96, min: 3, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "sphere") {
    return [
      { label: "Steps", value: shape.steps ?? 24, min: 6, max: 64, step: 1, onChange: (steps) => onUpdate({ steps: Math.round(steps) }) },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "halfSphere") {
    return [
      { label: "Steps", value: shape.steps ?? 32, min: 6, max: 64, step: 1, onChange: (steps) => onUpdate({ steps: Math.round(steps) }) },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "cone") {
    return [
      { label: "Top Radius", unit: "length", value: shape.topRadius ?? 0, min: 0, max: 40, onChange: (topRadius) => onUpdate({ topRadius }) },
      { label: "Base Radius", unit: "length", value: shape.baseRadius ?? baseWidth / 2, min: MIN_SHAPE_SIZE, max: 80, onChange: setBaseRadius },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setConeWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
      { label: "Sides", value: shape.sides ?? 96, min: 3, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
    ];
  }

  if (shape.kind === "pyramid") {
    return [
      { label: "Sides", value: shape.sides ?? 4, min: 3, max: 24, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "roundRoof") {
    return [
      { label: "Sides", value: shape.sides ?? 64, min: 4, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "tube" || shape.kind === "ring") {
    return [
      { label: "Thickness", unit: "length", value: shape.bevel ?? 4, min: 0.5, max: 20, onChange: (bevel) => onUpdate({ bevel }) },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "gear") {
    const setGearWidth = (value: number) => {
      const toothSize = normalizeGearToothSize(shape.toothSize, value, depth);
      const toothWidth = normalizeGearToothWidth(shape.toothWidth, value, depth, shape.teeth);
      const centerHoleSize = normalizeGearCenterHoleSize(shape.centerHoleSize, value, depth, toothSize);
      onUpdate({ width: value, size: resizedShapeSize(value, depth), toothSize, toothWidth, centerHoleSize }, { resizeAxis: "width" });
    };
    const setGearDepth = (value: number) => {
      const toothSize = normalizeGearToothSize(shape.toothSize, width, value);
      const toothWidth = normalizeGearToothWidth(shape.toothWidth, width, value, shape.teeth);
      const centerHoleSize = normalizeGearCenterHoleSize(shape.centerHoleSize, width, value, toothSize);
      onUpdate({ depth: value, size: resizedShapeSize(width, value), toothSize, toothWidth, centerHoleSize }, { resizeAxis: "depth" });
    };
    const teeth = shape.teeth ?? DEFAULT_GEAR_TEETH;
    const toothPitch = gearToothPitch(width, depth, teeth);
    const toothSize = normalizeGearToothSize(shape.toothSize ?? DEFAULT_GEAR_TOOTH_SIZE, width, depth);
    const centerHoleLimits = gearCenterHoleLimits(width, depth, toothSize);
    const properties: ShapePropertyConfig[] = [
      {
        label: "Teeth",
        value: teeth,
        min: 6,
        max: 64,
        step: 1,
        onChange: (value) => {
          const nextTeeth = Math.round(value);
          onUpdate({
            teeth: nextTeeth,
            toothWidth: normalizeGearToothWidth(shape.toothWidth, width, depth, nextTeeth),
          });
        },
      },
      {
        label: "Tooth Size",
        unit: "length",
        value: toothSize,
        min: 0.2,
        max: Math.max(0.2, Math.min(width, depth) * 0.22),
        step: 0.1,
        onChange: (nextToothSize) => onUpdate({
          toothSize: nextToothSize,
          centerHoleSize: normalizeGearCenterHoleSize(shape.centerHoleSize, width, depth, nextToothSize),
        }),
      },
      {
        label: "Tooth Width",
        unit: "length",
        allowsAboveSliderMax: true,
        value: normalizeGearToothWidth(shape.toothWidth, width, depth, teeth),
        min: toothPitch * 0.12,
        max: toothPitch * 0.82,
        step: 0.1,
        onChange: (toothWidth) => onUpdate({ toothWidth }),
      },
    ];
    if (normalizeGearType(shape.gearType) === "helical") {
      properties.push({
        label: "Helix Angle",
        value: normalizeGearHelixAngle(shape.helixAngle ?? DEFAULT_GEAR_HELIX_ANGLE),
        min: MIN_GEAR_HELIX_ANGLE,
        max: MAX_GEAR_HELIX_ANGLE,
        step: 1,
        onChange: (helixAngle) => onUpdate({ helixAngle }),
      });
      properties.push({
        label: "Quality",
        value: normalizeGearHelixQuality(shape.helixQuality ?? DEFAULT_GEAR_HELIX_QUALITY),
        min: MIN_GEAR_HELIX_QUALITY,
        max: MAX_GEAR_HELIX_QUALITY,
        step: 1,
        onChange: (helixQuality) => onUpdate({ helixQuality: Math.round(helixQuality) }),
      });
    }
    properties.push(
      {
        label: "Center Hole",
        unit: "length",
        value: normalizeGearCenterHoleSize(shape.centerHoleSize, width, depth, toothSize),
        min: centerHoleLimits.min,
        max: centerHoleLimits.max,
        step: 0.1,
        onChange: (centerHoleSize) => onUpdate({ centerHoleSize }),
      },
      { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setGearDepth },
      { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setGearWidth },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    );
    return properties;
  }

  if (shape.kind === "text") {
    return [
      {
        type: "text",
        label: "Text",
        value: shape.text ?? "TEXT",
        onChange: (text) => {
          const nextText = text.slice(0, 24) || " ";
          const nextWidth = clamp(Math.max(Math.min(46, textWidthMax), nextText.length * 19), MIN_SHAPE_SIZE, textWidthMax);
          onUpdate({ text: nextText, width: nextWidth, size: nextWidth });
        },
      },
      { type: "select", label: "Font", value: shape.font ?? "Multilanguage", options: TEXT_FONT_OPTIONS, onChange: (font) => onUpdate({ font }) },
      { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 40, onChange: setHeight },
      { label: "Bevel", unit: "length", value: shape.bevel ?? 0, min: 0, max: 8, onChange: (bevel) => onUpdate({ bevel }) },
      { label: "Segments", value: shape.segments ?? 0, min: 0, max: 24, step: 1, onChange: (segments) => onUpdate({ segments: Math.round(segments) }) },
    ];
  }

  return [
    { label: "Length", unit: "length", allowsAboveSliderMax: true, value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
    { label: "Width", unit: "length", allowsAboveSliderMax: true, value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
    { label: "Height", unit: "length", allowsAboveSliderMax: true, value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
  ];
}

// The taper rows are a separate inspector section, so they are built apart
// from the per-kind property list but carry the same unit configuration.
export function getShapeTaperProperties(
  shape: WorkplaneShape,
  onUpdate: ShapeInspectorUpdate,
  taperDimensionMax: number,
): ShapePropertyConfig[] {
  const taper = shapeTaperDimensions(shape);
  if (shape.kind === "gear") return [];
  return [
    {
      label: "Top Length",
      unit: "length",
      allowsAboveSliderMax: true,
      value: taper.topDepth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperTopDepth) => onUpdate({ taperTopDepth, taperTopWidth: taper.topWidth, taperTopScale: undefined }),
    },
    {
      label: "Top Width",
      unit: "length",
      allowsAboveSliderMax: true,
      value: taper.topWidth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperTopWidth) => onUpdate({ taperTopWidth, taperTopDepth: taper.topDepth, taperTopScale: undefined }),
    },
    {
      label: "Bottom Length",
      unit: "length",
      allowsAboveSliderMax: true,
      value: taper.bottomDepth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperBottomDepth) => onUpdate({ taperBottomDepth, taperBottomWidth: taper.bottomWidth, taperBottomScale: undefined }),
    },
    {
      label: "Bottom Width",
      unit: "length",
      allowsAboveSliderMax: true,
      value: taper.bottomWidth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperBottomWidth) => onUpdate({ taperBottomWidth, taperBottomDepth: taper.bottomDepth, taperBottomScale: undefined }),
    },
  ];
}
