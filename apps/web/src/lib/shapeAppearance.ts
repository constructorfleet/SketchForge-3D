import type { WorkplaneShape } from "@/types/sketchforge";

export type ShapeAppearancePreset = {
  id: string;
  name: string;
  baseColor: string;
  roughness: number;
  metalness: number;
  sheen: number;
};

/** Surface presets adjust viewport shading; they do not provide textures or simulate real materials. */
export const SHAPE_APPEARANCE_PRESETS: readonly ShapeAppearancePreset[] = [
  { id: "painted", name: "Painted surface", baseColor: "#cfd8df", roughness: 0.57, metalness: 0, sheen: 0 },
  { id: "wood", name: "Wood", baseColor: "#8a5a2b", roughness: 0.78, metalness: 0, sheen: 0.08 },
  { id: "fabric", name: "Fabric", baseColor: "#b98254", roughness: 0.92, metalness: 0, sheen: 0.34 },
  { id: "ceramic", name: "Ceramic", baseColor: "#f2caa0", roughness: 0.22, metalness: 0, sheen: 0.05 },
  { id: "metal", name: "Metal", baseColor: "#b8c2cc", roughness: 0.24, metalness: 0.86, sheen: 0.04 },
] as const;

export type ResolvedShapeAppearance = {
  presetId: string | undefined;
  baseColor: string;
  roughness: number;
  metalness: number;
  sheen: number;
};

function unitValue(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value as number)) : fallback;
}

export function shapeAppearancePreset(presetId: string | undefined) {
  return SHAPE_APPEARANCE_PRESETS.find((preset) => preset.id === presetId);
}

export function resolveShapeAppearance(shape: Pick<WorkplaneShape, "color" | "appearance">): ResolvedShapeAppearance {
  const appearance = shape.appearance;
  const preset = shapeAppearancePreset(appearance?.presetId);
  const baseColor = typeof appearance?.baseColor === "string"
    ? appearance.baseColor
    : preset?.baseColor ?? shape.color;
  return {
    presetId: appearance?.presetId,
    baseColor,
    roughness: unitValue(appearance?.roughness, preset?.roughness ?? 0.57),
    metalness: unitValue(appearance?.metalness, preset?.metalness ?? 0.02),
    sheen: unitValue(appearance?.sheen, preset?.sheen ?? 0),
  };
}
