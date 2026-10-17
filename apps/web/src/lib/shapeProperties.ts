// The shape inspector's property list: pure configuration, kept out of the
// component file so it can be exercised without a JSX-capable test setup.
//
// Every row is keyed on a stable ShapePropertyId rather than its visible text.
// The id selects the label message `panels.property.<id>`, and the unit and
// slider-overflow rules below are keyed on it too, so none of this depends on
// the interface language.
import type { MessageKey, Translator } from "@/i18n";
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
import {
  LOFT_PROFILE_SHAPES,
  MAX_LOFT_LAYERS,
  MAX_LOFT_SEGMENTS,
  MIN_LOFT_LAYERS,
  MIN_LOFT_SEGMENTS,
  isPolygonLoftShape,
  loftProfileShapeLabel,
  loftSettings,
} from "@/lib/loftGeometry";
import { normalizeSketchRevolveSettings } from "@/lib/sketchRevolve";
import { MAX_HIGH_RESOLUTION_SIDES } from "@/lib/workplaneSettings";
import { resizedShapeSize, shapeDepth, shapeHasTaper, shapeOverallFootprintDimensions, shapeTaperDimensions, shapeWidth } from "@/lib/workplaneShapes";
import type { GearType, LoftProfileShape, WorkplaneShape } from "@/types/sketchforge";

export const MIN_SHAPE_SIZE = 0.01;
export const TEXT_FONT_OPTIONS = ["Multilanguage", "Sans", "Serif", "Script", "Monospace", "Rounded", "Stencil"];
export const GEAR_TYPE_OPTIONS: GearType[] = ["spur", "helical", "bevel"];

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const TEXT_FONT_LABEL_KEYS: Record<string, MessageKey> = {
  Multilanguage: "panels.font.multilanguage",
  Sans: "panels.font.sans",
  Serif: "panels.font.serif",
  Script: "panels.font.script",
  Monospace: "panels.font.monospace",
  Rounded: "panels.font.rounded",
  Stencil: "panels.font.stencil",
};

/** Display text for a stored text font value; unknown fonts pass through. */
export function textFontLabel(t: Translator, font: string): string {
  const key = TEXT_FONT_LABEL_KEYS[font];
  return key ? t(key) : font;
}

/** Identifies a property row; also selects its label `panels.property.<id>`. */
export type ShapePropertyId =
  | "length"
  | "width"
  | "height"
  | "sides"
  | "steps"
  | "startAngle"
  | "sweep"
  | "topRadius"
  | "baseRadius"
  | "thickness"
  | "teeth"
  | "toothSize"
  | "toothWidth"
  | "helixAngle"
  | "quality"
  | "centerHole"
  | "text"
  | "font"
  | "bevel"
  | "segments"
  | "topLength"
  | "topWidth"
  | "bottomLength"
  | "bottomWidth"
  | "topShape"
  | "bottomShape"
  | "topRotation"
  | "bottomRotation"
  | "layers";

export type RangePropertyConfig = {
  type?: "range";
  id: ShapePropertyId;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
};

export type TextPropertyConfig = {
  type: "text";
  id: ShapePropertyId;
  value: string;
  onChange: (value: string) => void;
};

export type SelectPropertyConfig = {
  type: "select";
  id: ShapePropertyId;
  value: string;
  options: string[];
  optionLabel: (t: Translator, option: string) => string;
  onChange: (value: string) => void;
};

export type ShapePropertyConfig = RangePropertyConfig | TextPropertyConfig | SelectPropertyConfig;
export type ShapeInspectorUpdateOptions = { resizeAxis?: "width" | "depth" | "height" };
export type ShapeInspectorUpdate = (patch: Partial<WorkplaneShape>, options?: ShapeInspectorUpdateOptions) => void;

export const LENGTH_UNIT_PROPERTIES: readonly ShapePropertyId[] = ["length", "width", "height", "bevel", "topRadius", "baseRadius", "thickness", "toothSize", "toothWidth", "centerHole", "topLength", "topWidth", "bottomLength", "bottomWidth"];
/** Typed values may exceed the slider maximum (the slider still clamps). */
export const ABOVE_SLIDER_MAX_PROPERTIES: readonly ShapePropertyId[] = ["length", "width", "height", "topLength", "topWidth", "bottomLength", "bottomWidth", "toothWidth"];

export function propertyUsesLengthUnit(id: ShapePropertyId) {
  return LENGTH_UNIT_PROPERTIES.includes(id);
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
      { id: "startAngle", value: settings.startAngle, min: 0, max: 359, step: 1, onChange: (startAngle) => updateRevolve({ startAngle }) },
      { id: "sweep", value: settings.sweepAngle, min: -360, max: 360, step: 1, onChange: (sweepAngle) => updateRevolve({ sweepAngle }) },
      { id: "sides", value: settings.sides, min: 3, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => updateRevolve({ sides }) },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "box") {
    return [
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "cylinder") {
    return [
      { id: "sides", value: shape.sides ?? 96, min: 3, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "sphere") {
    return [
      { id: "steps", value: shape.steps ?? 24, min: 6, max: 64, step: 1, onChange: (steps) => onUpdate({ steps: Math.round(steps) }) },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "halfSphere") {
    return [
      { id: "steps", value: shape.steps ?? 32, min: 6, max: 64, step: 1, onChange: (steps) => onUpdate({ steps: Math.round(steps) }) },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "cone") {
    return [
      { id: "topRadius", value: shape.topRadius ?? 0, min: 0, max: 40, onChange: (topRadius) => onUpdate({ topRadius }) },
      { id: "baseRadius", value: shape.baseRadius ?? baseWidth / 2, min: MIN_SHAPE_SIZE, max: 80, onChange: setBaseRadius },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setConeWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
      { id: "sides", value: shape.sides ?? 96, min: 3, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
    ];
  }

  if (shape.kind === "pyramid") {
    return [
      { id: "sides", value: shape.sides ?? 4, min: 3, max: 24, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "roundRoof") {
    return [
      { id: "sides", value: shape.sides ?? 64, min: 4, max: MAX_HIGH_RESOLUTION_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "tube" || shape.kind === "ring") {
    return [
      { id: "thickness", value: shape.bevel ?? 4, min: 0.5, max: 20, onChange: (bevel) => onUpdate({ bevel }) },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
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
        id: "teeth",
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
        id: "toothSize",
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
        id: "toothWidth",
        value: normalizeGearToothWidth(shape.toothWidth, width, depth, teeth),
        min: toothPitch * 0.12,
        max: toothPitch * 0.82,
        step: 0.1,
        onChange: (toothWidth) => onUpdate({ toothWidth }),
      },
    ];
    if (normalizeGearType(shape.gearType) === "helical") {
      properties.push({
        id: "helixAngle",
        value: normalizeGearHelixAngle(shape.helixAngle ?? DEFAULT_GEAR_HELIX_ANGLE),
        min: MIN_GEAR_HELIX_ANGLE,
        max: MAX_GEAR_HELIX_ANGLE,
        step: 1,
        onChange: (helixAngle) => onUpdate({ helixAngle }),
      });
      properties.push({
        id: "quality",
        value: normalizeGearHelixQuality(shape.helixQuality ?? DEFAULT_GEAR_HELIX_QUALITY),
        min: MIN_GEAR_HELIX_QUALITY,
        max: MAX_GEAR_HELIX_QUALITY,
        step: 1,
        onChange: (helixQuality) => onUpdate({ helixQuality: Math.round(helixQuality) }),
      });
    }
    properties.push(
      {
        id: "centerHole",
        value: normalizeGearCenterHoleSize(shape.centerHoleSize, width, depth, toothSize),
        min: centerHoleLimits.min,
        max: centerHoleLimits.max,
        step: 0.1,
        onChange: (centerHoleSize) => onUpdate({ centerHoleSize }),
      },
      { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setGearDepth },
      { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setGearWidth },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    );
    return properties;
  }

  if (shape.kind === "loft") {
    const settings = loftSettings(shape);
    const topWidth = shape.loftTopWidth ?? width;
    const topDepth = shape.loftTopDepth ?? depth;
    // Top is an independent end (like cone's Top Radius) -- its size never touches the shape's
    // own width/depth. Bottom's size *is* the shape's generic width/depth, so the on-canvas
    // resize gizmo (which always drags width/depth/height) keeps working for it unmodified.
    const properties: ShapePropertyConfig[] = [
      { type: "select", id: "topShape", value: settings.topShape, options: LOFT_PROFILE_SHAPES, optionLabel: loftProfileShapeLabel, onChange: (value) => onUpdate({ loftTopShape: value as LoftProfileShape }) },
    ];
    if (!isPolygonLoftShape(settings.topShape)) {
      properties.push({ id: "topLength", value: topDepth, min: MIN_SHAPE_SIZE, max: 160, onChange: (value) => onUpdate({ loftTopDepth: value }) });
    }
    properties.push(
      { id: "topWidth", value: topWidth, min: MIN_SHAPE_SIZE, max: 160, onChange: (value) => onUpdate({ loftTopWidth: value }) },
      { id: "topRotation", value: settings.topRotation, min: 0, max: 359, step: 1, onChange: (value) => onUpdate({ loftTopRotation: value }) },
      { type: "select", id: "bottomShape", value: settings.bottomShape, options: LOFT_PROFILE_SHAPES, optionLabel: loftProfileShapeLabel, onChange: (value) => onUpdate({ loftBottomShape: value as LoftProfileShape }) },
    );
    if (!isPolygonLoftShape(settings.bottomShape)) {
      properties.push({ id: "bottomLength", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth });
    }
    properties.push(
      { id: "bottomWidth", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { id: "bottomRotation", value: settings.bottomRotation, min: 0, max: 359, step: 1, onChange: (value) => onUpdate({ loftBottomRotation: value }) },
      { id: "segments", value: settings.segments, min: MIN_LOFT_SEGMENTS, max: MAX_LOFT_SEGMENTS, step: 1, onChange: (value) => onUpdate({ loftSegments: Math.round(value) }) },
      { id: "layers", value: settings.layers, min: MIN_LOFT_LAYERS, max: MAX_LOFT_LAYERS, step: 1, onChange: (value) => onUpdate({ loftLayers: Math.round(value) }) },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    );
    return properties;
  }

  if (shape.kind === "text") {
    return [
      {
        type: "text",
        id: "text",
        value: shape.text ?? "TEXT",
        onChange: (text) => {
          const nextText = text.slice(0, 24) || " ";
          const nextWidth = clamp(Math.max(Math.min(46, textWidthMax), nextText.length * 19), MIN_SHAPE_SIZE, textWidthMax);
          onUpdate({ text: nextText, width: nextWidth, size: nextWidth });
        },
      },
      { type: "select", id: "font", value: shape.font ?? "Multilanguage", options: TEXT_FONT_OPTIONS, optionLabel: textFontLabel, onChange: (font) => onUpdate({ font }) },
      { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 40, onChange: setHeight },
      { id: "bevel", value: shape.bevel ?? 0, min: 0, max: 8, onChange: (bevel) => onUpdate({ bevel }) },
      { id: "segments", value: shape.segments ?? 0, min: 0, max: 24, step: 1, onChange: (segments) => onUpdate({ segments: Math.round(segments) }) },
    ];
  }

  return [
    { id: "length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
    { id: "width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
    { id: "height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
  ];
}

// The taper rows are a separate inspector section, so they are built apart
// from the per-kind property list but carry the same id keying.
export function getShapeTaperProperties(
  shape: WorkplaneShape,
  onUpdate: ShapeInspectorUpdate,
  taperDimensionMax: number,
): ShapePropertyConfig[] {
  if (shape.kind === "gear") return [];
  const taper = shapeTaperDimensions(shape);
  return [
    {
      id: "topLength",
      value: taper.topDepth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperTopDepth) => onUpdate({ taperTopDepth, taperTopWidth: taper.topWidth, taperTopScale: undefined }),
    },
    {
      id: "topWidth",
      value: taper.topWidth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperTopWidth) => onUpdate({ taperTopWidth, taperTopDepth: taper.topDepth, taperTopScale: undefined }),
    },
    {
      id: "bottomLength",
      value: taper.bottomDepth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperBottomDepth) => onUpdate({ taperBottomDepth, taperBottomWidth: taper.bottomWidth, taperBottomScale: undefined }),
    },
    {
      id: "bottomWidth",
      value: taper.bottomWidth,
      min: MIN_SHAPE_SIZE,
      max: taperDimensionMax,
      onChange: (taperBottomWidth) => onUpdate({ taperBottomWidth, taperBottomDepth: taper.bottomDepth, taperBottomScale: undefined }),
    },
  ];
}
