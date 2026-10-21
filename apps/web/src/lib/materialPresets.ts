/**
 * Material presets, and the weight and cost a part made of one would have.
 *
 * This is deliberately not a shading model: what a print-oriented editor needs
 * from a material is its density, so that volume x density gives a weight and
 * weight x price gives a cost. All of the arithmetic lives here rather than in
 * the inspector component so it can be checked against closed-form values.
 *
 * Densities are the solid-polymer figures from the manufacturers' technical
 * data sheets, in g/cm3, each sourced below. They are bulk material densities,
 * so a printed part with sparse infill weighs less than the readout says --
 * the readout is the solid-part weight, which is the upper bound and the usual
 * thing a designer wants when picking a size or a material.
 */
// React-free i18n entry points only: `@/i18n` re-exports `useTranslations`, and
// `lib/engine/workplaneSettings` reaches this module for its normalizers.
import type { MessageKey } from "@/i18n/locales";
import type { Translator } from "@/i18n/translator";
import type { WorkplaneShape } from "@/types/sketchforge";

export type MaterialId = "pla" | "petg" | "abs" | "asa" | "tpu" | "pa12" | "pc" | "resin";

export type MaterialPreset = {
  id: MaterialId;
  /** Solid density in g/cm3. */
  density: number;
  /** Starting price per kilogram, in whatever currency the user prices in. */
  defaultPricePerKg: number;
};

/**
 * Density sources (all "specific gravity"/"density" from the data sheet):
 *  - PLA   1.24  NatureWorks Ingeo 3D850 / 4043D technical data sheet
 *  - PETG  1.27  Eastman Amphora 3D polymer (PETG copolyester) data sheet
 *  - ABS   1.04  generic injection/FFF ABS data sheets (1.03-1.06 range)
 *  - ASA   1.07  ASA (acrylonitrile styrene acrylate) data sheets
 *  - TPU   1.21  TPU 95A filament data sheets (BASF Ultrafuse 1.22, NinjaTek 1.19)
 *  - PA12  1.01  PA12 / nylon-12 data sheets
 *  - PC    1.20  polycarbonate data sheets
 *  - resin 1.10  standard 405 nm photopolymer data sheets (Elegoo/Anycubic standard)
 *
 * Default prices are rough spool/bottle street prices per kilogram and are
 * only a starting point -- the price is a user-editable setting.
 */
export const MATERIAL_PRESETS: readonly MaterialPreset[] = [
  { id: "pla", density: 1.24, defaultPricePerKg: 20 },
  { id: "petg", density: 1.27, defaultPricePerKg: 22 },
  { id: "abs", density: 1.04, defaultPricePerKg: 22 },
  { id: "asa", density: 1.07, defaultPricePerKg: 30 },
  { id: "tpu", density: 1.21, defaultPricePerKg: 35 },
  { id: "pa12", density: 1.01, defaultPricePerKg: 45 },
  { id: "pc", density: 1.20, defaultPricePerKg: 40 },
  { id: "resin", density: 1.10, defaultPricePerKg: 50 },
];

export const DEFAULT_MATERIAL_ID: MaterialId = "pla";

const PRESETS_BY_ID = new Map(MATERIAL_PRESETS.map((preset) => [preset.id, preset]));

export const MAX_MATERIAL_PRICE_PER_KG = 100_000;

export function isMaterialId(value: unknown): value is MaterialId {
  return typeof value === "string" && PRESETS_BY_ID.has(value as MaterialId);
}

/**
 * The preset for a stored id.
 *
 * An id this build does not know about -- a project written by a newer one --
 * reads as "no material chosen" rather than being coerced to PLA, so the file
 * keeps its value and the readout simply stays empty.
 */
export function materialPreset(id: string | undefined): MaterialPreset | undefined {
  return id === undefined ? undefined : PRESETS_BY_ID.get(id as MaterialId);
}

/** Price per kilogram for a material, honouring the user's override. */
export function materialPricePerKg(id: MaterialId, overrides: Readonly<Record<string, number>> = {}) {
  const override = overrides[id];
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return Math.min(MAX_MATERIAL_PRICE_PER_KG, override);
  }
  return PRESETS_BY_ID.get(id)?.defaultPricePerKg ?? 0;
}

/**
 * Keeps only finite, non-negative prices for materials this build knows, so a
 * hand-edited or newer project cannot put junk in the settings.
 */
export function normalizeMaterialPrices(
  value: unknown,
  fallback: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const normalized: Record<string, number> = {};
  MATERIAL_PRESETS.forEach((preset) => {
    const raw = candidate === undefined ? fallback[preset.id] : candidate[preset.id];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return;
    normalized[preset.id] = Math.min(MAX_MATERIAL_PRICE_PER_KG, raw);
  });
  return normalized;
}

export type MaterialMesh = {
  vertices: readonly (readonly [number, number, number])[];
  faces: readonly (readonly [number, number, number])[];
};

/**
 * Volume enclosed by a triangle mesh, in mm3, by the signed-tetrahedron sum.
 *
 * Each triangle contributes the signed volume of the tetrahedron it forms with
 * the origin; for a closed surface the outward-facing contributions cancel
 * everywhere but the interior. The absolute value is taken so a mesh whose
 * winding runs inward still reports a positive volume.
 *
 * `svgImport.ts` carries the same sum over a non-indexed triangle soup, where
 * it is used per connected component to reject a non-solid import. This is the
 * indexed-mesh form, which is what the editor's shape meshes are.
 */
export function meshVolumeMm3(mesh: MaterialMesh) {
  let total = 0;
  for (const [ai, bi, ci] of mesh.faces) {
    const a = mesh.vertices[ai];
    const b = mesh.vertices[bi];
    const c = mesh.vertices[ci];
    if (!a || !b || !c) continue;
    total += (
      a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
  }
  return Math.abs(total);
}

/** Centroid of the volume a closed triangle mesh encloses, in mm. */
export function meshVolumeCentroid(mesh: MaterialMesh): [number, number, number] {
  let volume = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const [ai, bi, ci] of mesh.faces) {
    const a = mesh.vertices[ai];
    const b = mesh.vertices[bi];
    const c = mesh.vertices[ci];
    if (!a || !b || !c) continue;
    const signed = (
      a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
    volume += signed;
    // The tetrahedron's centroid is the mean of its four corners, one of which
    // is the origin.
    cx += signed * (a[0] + b[0] + c[0]) / 4;
    cy += signed * (a[1] + b[1] + c[1]) / 4;
    cz += signed * (a[2] + b[2] + c[2]) / 4;
  }
  if (volume === 0) return [0, 0, 0];
  return [cx / volume, cy / volume, cz / volume];
}

export const CUBIC_MM_PER_CUBIC_CM = 1000;
export const GRAMS_PER_KILOGRAM = 1000;

export function cubicMillimetersToCubicCentimeters(volumeMm3: number) {
  return volumeMm3 / CUBIC_MM_PER_CUBIC_CM;
}

/** Weight in grams of `volumeMm3` of a material at `density` g/cm3. */
export function materialWeightGrams(volumeMm3: number, density: number) {
  return cubicMillimetersToCubicCentimeters(volumeMm3) * density;
}

/** Cost of `grams` at `pricePerKg`, in the same currency as the price. */
export function materialCost(grams: number, pricePerKg: number) {
  return (grams / GRAMS_PER_KILOGRAM) * pricePerKg;
}

export type MaterialEstimate = {
  materialId: MaterialId;
  density: number;
  pricePerKg: number;
  volumeMm3: number;
  volumeCm3: number;
  grams: number;
  cost: number;
};

export type MaterialVolumePrecision = "exact" | "tessellated";

export function materialVolumePrecisionMessage(precision: MaterialVolumePrecision): MessageKey {
  return precision === "exact" ? "panels.material.precision.exact" : "panels.material.precision.tessellated";
}

/**
 * Weight and cost for one shape, or undefined when there is nothing to price:
 * no material chosen, a material this build does not know, a hole (which
 * removes material rather than using any), or a degenerate volume.
 */
export function shapeMaterialEstimate(
  shape: Pick<WorkplaneShape, "material" | "hole">,
  volumeMm3: number,
  priceOverrides: Readonly<Record<string, number>> = {},
): MaterialEstimate | undefined {
  if (shape.hole) return undefined;
  const preset = materialPreset(shape.material);
  if (!preset) return undefined;
  if (!Number.isFinite(volumeMm3) || volumeMm3 <= 0) return undefined;
  const pricePerKg = materialPricePerKg(preset.id, priceOverrides);
  const grams = materialWeightGrams(volumeMm3, preset.density);
  return {
    materialId: preset.id,
    density: preset.density,
    pricePerKg,
    volumeMm3,
    volumeCm3: cubicMillimetersToCubicCentimeters(volumeMm3),
    grams,
    cost: materialCost(grams, pricePerKg),
  };
}

/** Rounds a readout to a fixed number of decimals without exponent notation. */
export function formatMaterialNumber(value: number, decimals: number) {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(decimals);
}

const MATERIAL_NAME_KEYS: Record<MaterialId, MessageKey> = {
  pla: "panels.material.name.pla",
  petg: "panels.material.name.petg",
  abs: "panels.material.name.abs",
  asa: "panels.material.name.asa",
  tpu: "panels.material.name.tpu",
  pa12: "panels.material.name.pa12",
  pc: "panels.material.name.pc",
  resin: "panels.material.name.resin",
};

/** Display name for a material id; an id this build does not know passes through. */
export function materialLabel(t: Translator, id: string): string {
  const key = MATERIAL_NAME_KEYS[id as MaterialId];
  return key ? t(key) : id;
}
