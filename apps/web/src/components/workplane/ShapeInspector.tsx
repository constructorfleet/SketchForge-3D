"use client";

import { Box, ChevronDown, ChevronUp, LockKeyhole, LockKeyholeOpen, Split } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { ToolbarHideSelectedIcon } from "@/components/icons";
import { normalizeGearType } from "@/lib/gearGeometry";
import {
  MATERIAL_PRESETS,
  formatMaterialNumber,
  materialLabel,
  materialPreset,
  materialPricePerKg,
  materialVolumePrecisionMessage,
  shapeMaterialEstimate,
  type MaterialId,
} from "@/lib/materialPresets";
import { unitLabel, useTranslations, type MessageKey } from "@/i18n";
import { shapeDisplayName } from "@/lib/shapeDisplayNames";
import { resolveShapeAppearance, SHAPE_APPEARANCE_PRESETS, shapeAppearancePreset } from "@/lib/shapeAppearance";
import { draftPrismControlForShape, draftPrismRequestForShape, isDraftPrismAngle } from "@/lib/draftPrismEditor";
import type { DraftFacePullAxis } from "@/lib/draftFaceEditor";
import { shapeHasExactFaces } from "@/lib/shapeFaces";
import { ShapeFaceTools } from "@/components/workplane/ShapeFaceTools";
import { RetainedFaceDraftCard } from "@/components/workplane/RetainedFaceDraftCard";
import { ShapeShellCard } from "@/components/workplane/ShapeShellCard";
import type { ShellOpenFace } from "@/lib/shellEditor";
import { retainedFaceDraftEditable, retainedPrismDraftAvailable } from "@/lib/retainedDrafts";
import { displayStepFromMillimeters, displayToMillimeters, formatMeasurementNumber, lengthDisplayUnit, millimetersToDisplay, parseMeasurementInput, snapGridLabel } from "@/lib/measurementUnits";
import {
  ABOVE_SLIDER_MAX_PROPERTIES,
  GEAR_TYPE_OPTIONS,
  clamp,
  getShapePropertiesWithAppLimits,
  getShapeTaperProperties,
  placementProperties,
  propertyUsesLengthUnit,
  type RangePropertyConfig,
  type SelectPropertyConfig,
  type ShapeInspectorUpdate,
  type ShapePropertyConfig,
  type ShapePropertyId,
  type TextPropertyConfig,
} from "@/lib/shapeProperties";
import type { GearType, GridSize, MeasurementAccuracy, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export type { RangePropertyConfig, ShapeInspectorUpdate, ShapeInspectorUpdateOptions, ShapePropertyConfig, ShapePropertyId } from "@/lib/shapeProperties";
export { getShapePropertiesWithAppLimits, propertyUsesLengthUnit, textFontLabel } from "@/lib/shapeProperties";

const GRID_SIZES: GridSize[] = ["Off", "0.1 mm", "0.25 mm", "0.5 mm", "1.0 mm", "2.0 mm", "5.0 mm", "Brick"];
const SOLID_COLORS = [
  "#d41721",
  "#ff4b4b",
  "#ff7a1a",
  "#d97813",
  "#f6a21a",
  "#f2cf10",
  "#f7e65a",
  "#a8d642",
  "#33983d",
  "#1fb66d",
  "#18b99a",
  "#0098c7",
  "#49c7ef",
  "#3b82f6",
  "#294c93",
  "#5b5ce2",
  "#6e2786",
  "#9b3bd2",
  "#c9009a",
  "#f062b6",
  "#8a5a2b",
  "#b98254",
  "#f2caa0",
  "#ffffff",
  "#cfd8df",
  "#8a98a6",
  "#4b5563",
  "#111111",
];
const APPEARANCE_PRESET_LABELS: Record<string, MessageKey> = {
  painted: "panels.appearance.presets.painted",
  wood: "panels.appearance.presets.wood",
  fabric: "panels.appearance.presets.fabric",
  ceramic: "panels.appearance.presets.ceramic",
  metal: "panels.appearance.presets.metal",
};

function formatPropertyNumber(value: number, accuracy: MeasurementAccuracy, step: number) {
  if (step >= 1) return String(Math.round(value));
  return formatMeasurementNumber(value, accuracy, step);
}


function getShapeProperties(shape: WorkplaneShape, onUpdate: ShapeInspectorUpdate, workspace: WorkplaneWorkspaceSettings): ShapePropertyConfig[] {
  const customLimit = workspace.shapeCustomizations[shape.kind]?.maxDimension;
  const properties = getShapePropertiesWithAppLimits(shape, onUpdate, customLimit ?? 260);
  if (customLimit === undefined) return properties;
  return properties.map((property) => {
    if (property.type === "text" || property.type === "select") return property;
    if (property.id === "length" || property.id === "width" || property.id === "height") return { ...property, max: customLimit };
    if (property.id === "topRadius" || property.id === "baseRadius") return { ...property, max: customLimit / 2 };
    return property;
  });
}

export function ShapeInspector({
  shape,
  snap,
  snapOpen,
  workspace,
  onUpdate,
  onSnapChange,
  onSnapOpenChange,
  onEditSketch,
  onApplyDraftPrism,
  onApplyDraftFace,
  onUpdateRetainedFaceDraft,
  onEnableFaceEditing,
  onApplyShell,
  onHighlightFace,
  onFacePickingChange,
  pickedFace,
  canSeparateParts = false,
  onSeparateParts,
  onInteractionActiveChange,
  volumeMm3,
  onMaterialPriceChange,
}: {
  shape: WorkplaneShape;
  snap: GridSize;
  snapOpen: boolean;
  workspace: WorkplaneWorkspaceSettings;
  onUpdate: ShapeInspectorUpdate;
  onSnapChange: Dispatch<SetStateAction<GridSize>>;
  onSnapOpenChange: Dispatch<SetStateAction<boolean>>;
  onEditSketch?: () => void;
  onApplyDraftPrism?: (angle: number) => Promise<void> | void;
  onApplyDraftFace?: (faceIndex: number, angle: number, pullDirection: DraftFacePullAxis) => Promise<void> | void;
  /** Change the direction or angle of the face draft the shape keeps with its sketch. */
  onUpdateRetainedFaceDraft?: (angle: number, pullDirection: DraftFacePullAxis) => Promise<void> | void;
  /** Present when the shape can be rebuilt as exact geometry to gain editable faces. */
  onEnableFaceEditing?: () => Promise<void> | void;
  /** Present when the shape may be hollowed; the editor refuses what it cannot shell with a notice. */
  onApplyShell?: (thickness: number, openFaces: ShellOpenFace[]) => Promise<void> | void;
  /** The face the face tools point at, or null; the viewport highlights it. */
  onHighlightFace?: (faceIndex: number | null) => void;
  onFacePickingChange?: (shapeId: string | null) => void;
  pickedFace?: { shapeId: string; faceIndex: number; serial: number } | null;
  canSeparateParts?: boolean;
  onSeparateParts?: () => void;
  onInteractionActiveChange?: (active: boolean) => void;
  /** Solid volume of this shape in mm3; absent when nothing has been measured. */
  volumeMm3?: number;
  onMaterialPriceChange?: (materialId: MaterialId, pricePerKg: number) => void;
}) {
  const t = useTranslations();
  const solidColor = shape.color;
  const surfaceAppearance = resolveShapeAppearance(shape);
  const locked = Boolean(shape.locked);
  const properties = getShapeProperties(shape, onUpdate, workspace);
  const draftControl = draftPrismControlForShape(shape);
  const gearType = shape.kind === "gear" ? normalizeGearType(shape.gearType) : null;
  const primaryProperties = shape.kind === "gear"
    ? properties.filter((property) => (["centerHole", "length", "width", "height"] as ShapePropertyId[]).includes(property.id))
    : properties;
  const gearTeethProperties = shape.kind === "gear"
    ? properties.filter((property) => (["teeth", "toothSize", "toothWidth"] as ShapePropertyId[]).includes(property.id))
    : [];
  const gearHelixProperties = shape.kind === "gear"
    ? properties.filter((property) => (["helixAngle", "quality"] as ShapePropertyId[]).includes(property.id))
    : [];
  const taperDimensionMax = workspace.shapeCustomizations[shape.kind]?.maxDimension ?? 480;
  const taperProperties = getShapeTaperProperties(shape, onUpdate, taperDimensionMax);
  // The sliders span the build plate; typed values may still go beyond it.
  const placementRows = placementProperties(shape, onUpdate, {
    halfWidth: workspace.width / 2,
    halfDepth: workspace.depth / 2,
    maxElevation: Math.max(workspace.width, workspace.depth),
  });
  const isSketchRevolve = shape.sketchOperation === "revolve" || Boolean(shape.sketchRevolve);
  const inspectorRef = useRef<HTMLElement>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [placementOpen, setPlacementOpen] = useState(true);
  const [taperOpen, setTaperOpen] = useState(false);
  const [gearTeethOpen, setGearTeethOpen] = useState(true);
  const [gearHelixOpen, setGearHelixOpen] = useState(true);
  const [colorOpen, setColorOpen] = useState(false);
  const [draftAngle, setDraftAngle] = useState(String(shape.draftPrismAngle ?? 5));
  const prismRetained = retainedPrismDraftAvailable(shape);
  const prismDrafted = prismRetained && shape.draftPrismAngle !== undefined;
  // An undo, or a change made elsewhere, replaces the angle the shape keeps.
  useEffect(() => {
    if (shape.draftPrismAngle !== undefined) setDraftAngle(String(shape.draftPrismAngle));
  }, [shape.draftPrismAngle]);
  const [drafting, setDrafting] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const customColorInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => onInteractionActiveChange?.(false), [onInteractionActiveChange]);
  useEffect(() => {
    const input = customColorInputRef.current;
    if (!colorOpen || !input) {
      return;
    }

    // React's color-input onChange follows the native input event and fires for
    // every movement in the picker. Commit only the native change event, which
    // fires after the user finishes choosing, so dragging stays responsive.
    const commitCustomColor = () => {
      onUpdate({ color: input.value, appearance: { ...shape.appearance, baseColor: input.value }, hole: false });
    };
    input.addEventListener("change", commitCustomColor);
    return () => input.removeEventListener("change", commitCustomColor);
  }, [colorOpen, onUpdate]);
  useLayoutEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0, left: 0 });
  }, [isSketchRevolve, shape.id]);

  return (
    <aside ref={inspectorRef} className={`shape-inspector ${isSketchRevolve ? "sketch-revolve-inspector" : ""} ${shape.kind === "gear" ? "gear-inspector" : ""} ${minimized ? "minimized" : ""}`} aria-label={t("panels.inspector.label", { name: shapeDisplayName(t, shape.name) })} onPointerDown={(event) => event.stopPropagation()}>
      <div className="shape-inspector-header">
        <button
          className="inspector-header-icon"
          aria-label={minimized ? t("panels.inspector.expand") : t("panels.inspector.minimize")}
          aria-expanded={!minimized}
          onClick={() => setMinimized((current) => !current)}
        >
          {minimized ? <ChevronDown size={26} strokeWidth={2.8} /> : <ChevronUp size={26} strokeWidth={2.8} />}
        </button>
        <span className="inspector-header-glyph" aria-hidden="true"><Box size={18} strokeWidth={2.2} /></span>
        <strong>{shapeDisplayName(t, shape.name)}</strong>
        <div className="inspector-header-actions">
          <button className={locked ? "inspector-header-icon active" : "inspector-header-icon"} aria-label={locked ? t("panels.inspector.unlock") : t("panels.inspector.lock")} onClick={() => onUpdate({ locked: !locked })}>
            {locked ? <LockKeyhole size={31} strokeWidth={2.4} /> : <LockKeyholeOpen size={31} strokeWidth={2.4} />}
          </button>
          <button className={shape.hidden ? "inspector-header-icon active" : "inspector-header-icon"} aria-label={shape.hidden ? t("panels.inspector.show") : t("panels.inspector.hide")} onClick={() => onUpdate({ hidden: !shape.hidden })}>
            <ToolbarHideSelectedIcon />
          </button>
        </div>
      </div>

      {!minimized ? (
        <>
      <div className="shape-state-card" role="group" aria-label={t("panels.inspector.mode")}>
        <button
          className={!shape.hole ? "active solid-choice" : "solid-choice"}
          onClick={() => {
            const wasHole = Boolean(shape.hole);
            onUpdate({ hole: false, color: solidColor });
            setColorOpen((open) => (wasHole ? false : !open));
          }}
          disabled={locked}
          aria-pressed={!shape.hole}
          aria-expanded={colorOpen}
        >
          <span className="large-solid-swatch" style={{ "--swatch": solidColor } as CSSProperties} />
          <span>{t("panels.inspector.solid")}</span>
        </button>
        <button
          className={shape.hole ? "active hole-choice" : "hole-choice"}
          onClick={() => {
            onUpdate({ hole: true });
            setColorOpen(false);
          }}
          disabled={locked}
          aria-pressed={shape.hole}
        >
          <span className="large-hole-swatch" />
          <span>{t("panels.inspector.hole")}</span>
        </button>
      </div>

      {colorOpen ? (
        <div className="color-card" aria-label={t("panels.inspector.color.label")}>
          <div className="color-card-header">
            <span>{t("panels.inspector.color.title")}</span>
            <span className="color-value">{solidColor.toUpperCase()}</span>
          </div>
          <div className="color-grid">
            {SOLID_COLORS.map((color) => (
              <button
                key={color}
                className={solidColor.toLowerCase() === color.toLowerCase() && !shape.hole ? "selected" : ""}
                type="button"
                style={{ "--shape-swatch": color } as CSSProperties}
                title={color.toUpperCase()}
                aria-label={t("panels.inspector.color.set", { color })}
                disabled={locked}
                onClick={() => {
                  onUpdate({ color, appearance: { ...shape.appearance, baseColor: color }, hole: false });
                  setColorOpen(false);
                }}
              />
            ))}
            <label className={locked ? "custom-color disabled" : "custom-color"} title={t("panels.inspector.color.customTitle")}>
              <input
                key={`${shape.id}-${solidColor}`}
                ref={customColorInputRef}
                type="color"
                defaultValue={solidColor}
                disabled={locked}
                onFocus={() => onInteractionActiveChange?.(true)}
                onBlur={() => onInteractionActiveChange?.(false)}
              />
              <span>{t("panels.inspector.color.custom")}</span>
            </label>
          </div>
          <div className="surface-appearance-controls">
            <label className="surface-appearance-title" htmlFor={`surface-appearance-${shape.id}`}>
              {t("panels.appearance.title")}
            </label>
            <p>{t("panels.appearance.hint")}</p>
            <select
              id={`surface-appearance-${shape.id}`}
              aria-label={t("panels.appearance.title")}
              value={shape.appearance?.presetId ?? ""}
              disabled={locked}
              onChange={(event) => {
                const preset = shapeAppearancePreset(event.currentTarget.value);
                if (!preset) {
                  onUpdate({ color: surfaceAppearance.baseColor, appearance: {
                    baseColor: surfaceAppearance.baseColor,
                    roughness: surfaceAppearance.roughness,
                    metalness: surfaceAppearance.metalness,
                    sheen: surfaceAppearance.sheen,
                  } });
                  return;
                }
                onUpdate({ color: preset.baseColor, appearance: { presetId: preset.id }, hole: false });
              }}
            >
              <option value="">{t("panels.appearance.custom")}</option>
              {shape.appearance?.presetId && !shapeAppearancePreset(shape.appearance.presetId) ? <option value={shape.appearance.presetId}>{shape.appearance.presetId}</option> : null}
              {SHAPE_APPEARANCE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{t(APPEARANCE_PRESET_LABELS[preset.id])}</option>)}
            </select>
            {([
              { property: "roughness", label: t("panels.appearance.roughness") },
              { property: "metalness", label: t("panels.appearance.metalness") },
              { property: "sheen", label: t("panels.appearance.sheen") },
            ] as const).map(({ property, label }) => (
              <label className="surface-appearance-range" key={property}>
                <span>{label}</span>
                <span>{surfaceAppearance[property].toFixed(2)}</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={surfaceAppearance[property]}
                  disabled={locked}
                  aria-label={label}
                  onChange={(event) => onUpdate({ appearance: { ...shape.appearance, [property]: Number(event.currentTarget.value) } })}
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {shapeHasExactFaces(shape) || onEnableFaceEditing ? (
        <ShapeFaceTools
          key={shape.id}
          shape={shape}
          locked={locked}
          fallbackColor={solidColor}
          onUpdateFaceColors={(faceColors) => onUpdate({ faceColors })}
          onEnableFaceEditing={onEnableFaceEditing}
          onApplyDraftFace={onApplyDraftFace}
          onHighlightFace={onHighlightFace}
          onFacePickingChange={onFacePickingChange}
          pickedFace={pickedFace}
        />
      ) : null}

      {shape.faceDraft && onUpdateRetainedFaceDraft && retainedFaceDraftEditable(shape) ? (
        <RetainedFaceDraftCard
          key={`${shape.id}-face-draft`}
          shape={shape as WorkplaneShape & { faceDraft: NonNullable<WorkplaneShape["faceDraft"]> }}
          locked={locked}
          onUpdate={onUpdateRetainedFaceDraft}
          onInteractionActiveChange={onInteractionActiveChange}
        />
      ) : null}

      {shape.sketchProfile && onEditSketch ? (
        <button className="edit-sketch-button" type="button" disabled={locked} onClick={onEditSketch}>
          {t("panels.inspector.editSketch")}
        </button>
      ) : null}

      {draftControl.available && onApplyDraftPrism ? (
        <section className="property-card draft-prism-card" aria-label={t("panels.inspector.draftPrism.title")}>
          <div className="property-card-header"><span>{t("panels.inspector.draftPrism.title")}</span></div>
          <div className="property-list">
            <p>{t(shape.faceDraft ? "panels.inspector.draftPrism.faceDraftRetained"
              : prismRetained ? "panels.inspector.draftPrism.hintRetained" : "panels.inspector.draftPrism.hint")}</p>
            <label>
              <span>{t("panels.inspector.draftPrism.angle")}</span>
              <input
                type="number"
                min="-44.9"
                max="44.9"
                step="0.1"
                value={draftAngle}
                disabled={locked || drafting}
                onChange={(event) => setDraftAngle(event.currentTarget.value)}
                onFocus={() => onInteractionActiveChange?.(true)}
                onBlur={() => onInteractionActiveChange?.(false)}
              />
            </label>
            <button
              className="inspector-action-button"
              type="button"
              disabled={locked || drafting || !draftPrismRequestForShape(shape, Number(draftAngle))
                || prismDrafted && Number(draftAngle) === shape.draftPrismAngle
                || Boolean(shape.faceDraft)}
              onClick={async () => {
                const angle = Number(draftAngle);
                if (!isDraftPrismAngle(angle)) return;
                setDrafting(true);
                try {
                  await onApplyDraftPrism(angle);
                } finally {
                  setDrafting(false);
                }
              }}
            >
              <span>{t(drafting ? "panels.inspector.draftPrism.applying" : prismDrafted ? "panels.inspector.draftPrism.update" : "panels.inspector.draftPrism.apply")}</span>
            </button>
          </div>
        </section>
      ) : null}

      {onApplyShell && !shape.hole && !shape.imagePlate ? (
        <ShapeShellCard
          key={`${shape.id}-shell`}
          shape={shape}
          locked={locked}
          workspace={workspace}
          pickedFace={pickedFace}
          onApply={onApplyShell}
          onInteractionActiveChange={onInteractionActiveChange}
        />
      ) : null}

      {canSeparateParts && onSeparateParts ? (
        <button className="inspector-action-button" type="button" disabled={locked} onClick={onSeparateParts}>
          <Split size={17} strokeWidth={2.5} />
          <span>{t("panels.inspector.separateParts")}</span>
        </button>
      ) : null}

      <div className={`property-card ${propertiesOpen ? "" : "collapsed"}`}>
        <button
          className="property-card-header"
          type="button"
          aria-expanded={propertiesOpen}
          aria-controls={`properties-${shape.id}`}
          onClick={() => setPropertiesOpen((open) => !open)}
        >
          <span>{t("panels.inspector.section.properties")}</span>
          <ChevronUp className={propertiesOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
        </button>
        {propertiesOpen ? (
          <div className="property-list" id={`properties-${shape.id}`}>
            {gearType ? (
              <GearTypeSelector
                value={gearType}
                disabled={locked}
                onChange={(gearType) => onUpdate({ gearType })}
              />
            ) : null}
            <ShapePropertyRows properties={primaryProperties} workspace={workspace} disabled={locked} onInteractionActiveChange={onInteractionActiveChange} />
          </div>
        ) : null}
      </div>
      <div className={`property-card ${materialOpen ? "" : "collapsed"}`}>
        <button
          className="property-card-header"
          type="button"
          aria-expanded={materialOpen}
          aria-controls={`material-${shape.id}`}
          onClick={() => setMaterialOpen((open) => !open)}
        >
          <span>{t("panels.material.title")}</span>
          <ChevronUp className={materialOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
        </button>
        {materialOpen ? (
          <div className="property-list" id={`material-${shape.id}`}>
            <MaterialProperties
              shape={shape}
              workspace={workspace}
              volumeMm3={volumeMm3}
              disabled={locked}
              onUpdate={onUpdate}
              onMaterialPriceChange={onMaterialPriceChange}
              onInteractionActiveChange={onInteractionActiveChange}
            />
          </div>
        ) : null}
      </div>
      {shape.kind !== "gear" ? (
        <div className={`property-card ${taperOpen ? "" : "collapsed"}`}>
          <button
            className="property-card-header"
            type="button"
            aria-expanded={taperOpen}
            aria-controls={`taper-${shape.id}`}
            onClick={() => setTaperOpen((open) => !open)}
          >
            <span>{t("panels.inspector.section.taper")}</span>
            <ChevronUp className={taperOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
          </button>
          {taperOpen ? (
            <div className="property-list" id={`taper-${shape.id}`}>
              <ShapePropertyRows properties={taperProperties} workspace={workspace} disabled={locked} onInteractionActiveChange={onInteractionActiveChange} />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={`property-card ${placementOpen ? "" : "collapsed"}`}>
        <button
          className="property-card-header"
          type="button"
          aria-expanded={placementOpen}
          aria-controls={`placement-${shape.id}`}
          onClick={() => setPlacementOpen((open) => !open)}
        >
          <span>{t("panels.inspector.placement")}</span>
          <ChevronUp className={placementOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
        </button>
        {placementOpen ? (
          <div className="property-list" id={`placement-${shape.id}`}>
            <ShapePropertyRows properties={placementRows} workspace={workspace} disabled={locked} onInteractionActiveChange={onInteractionActiveChange} />
          </div>
        ) : null}
      </div>
      {shape.kind === "gear" ? (
        <div className={`property-card ${gearTeethOpen ? "" : "collapsed"}`}>
          <button
            className="property-card-header"
            type="button"
            aria-expanded={gearTeethOpen}
            aria-controls={`gear-teeth-${shape.id}`}
            onClick={() => setGearTeethOpen((open) => !open)}
          >
            <span>{t("panels.inspector.section.teeth")}</span>
            <ChevronUp className={gearTeethOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
          </button>
          {gearTeethOpen ? (
            <div className="property-list" id={`gear-teeth-${shape.id}`}>
              <ShapePropertyRows properties={gearTeethProperties} workspace={workspace} disabled={locked} onInteractionActiveChange={onInteractionActiveChange} />
            </div>
          ) : null}
        </div>
      ) : null}
      {gearType === "helical" ? (
        <div className={`property-card ${gearHelixOpen ? "" : "collapsed"}`}>
          <button
            className="property-card-header"
            type="button"
            aria-expanded={gearHelixOpen}
            aria-controls={`gear-helix-${shape.id}`}
            onClick={() => setGearHelixOpen((open) => !open)}
          >
            <span>{t("panels.inspector.section.helix")}</span>
            <ChevronUp className={gearHelixOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
          </button>
          {gearHelixOpen ? (
            <div className="property-list" id={`gear-helix-${shape.id}`}>
              <ShapePropertyRows properties={gearHelixProperties} workspace={workspace} disabled={locked} onInteractionActiveChange={onInteractionActiveChange} />
            </div>
          ) : null}
        </div>
      ) : null}
        </>
      ) : null}
    </aside>
  );
}

function ShapePropertyRows({
  properties,
  workspace,
  disabled,
  onInteractionActiveChange,
}: {
  properties: ShapePropertyConfig[];
  workspace: WorkplaneWorkspaceSettings;
  disabled?: boolean;
  onInteractionActiveChange?: (active: boolean) => void;
}) {
  const t = useTranslations();
  return properties.map((property) => {
    const label = t(`panels.property.${property.id}`);
    if (property.type === "text") {
      return <TextProperty key={property.id} {...property} label={label} disabled={disabled} onInteractionActiveChange={onInteractionActiveChange} />;
    }
    if (property.type === "select") {
      return <SelectProperty key={property.id} {...property} label={label} disabled={disabled} />;
    }
    return <RangeProperty key={property.id} {...property} label={label} workspace={workspace} disabled={disabled} onInteractionActiveChange={onInteractionActiveChange} />;
  });
}

export function SnapGridControl({
  snap,
  snapOpen,
  onSnapChange,
  onSnapOpenChange,
}: {
  snap: GridSize;
  snapOpen: boolean;
  onSnapChange: Dispatch<SetStateAction<GridSize>>;
  onSnapOpenChange: Dispatch<SetStateAction<boolean>>;
}) {
  const t = useTranslations();
  return (
    <div className="snap-row">
      <span>{t("panels.snapGrid.label")}</span>
      <button className="snap-select" onClick={() => onSnapOpenChange((value) => !value)}>
        {snapGridLabel(t, snap)}
        <ChevronDown size={12} fill="currentColor" />
      </button>
      {snapOpen ? (
        <div className="snap-menu">
          {GRID_SIZES.map((size) => (
            <button
              key={size}
              className={size === snap ? "selected" : ""}
              onClick={() => {
                onSnapChange(size);
                onSnapOpenChange(false);
              }}
            >
              {snapGridLabel(t, size)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RangeProperty({
  id,
  label,
  value,
  min,
  max,
  step = 0.01,
  workspace,
  disabled,
  onChange,
  onInteractionActiveChange,
}: RangePropertyConfig & { label: string; workspace: WorkplaneWorkspaceSettings; disabled?: boolean; onInteractionActiveChange?: (active: boolean) => void }) {
  const t = useTranslations();
  const allowsAboveSliderMax = ABOVE_SLIDER_MAX_PROPERTIES.includes(id);
  const isLength = propertyUsesLengthUnit(id);
  const accuracy = workspace.accuracy;
  const actualValue = Math.max(min, Number.isFinite(value) ? value : min);
  const controlValue = isLength ? millimetersToDisplay(actualValue, workspace) : actualValue;
  const controlMin = isLength ? millimetersToDisplay(min, workspace) : min;
  const controlMax = isLength ? millimetersToDisplay(max, workspace) : max;
  const controlStep = isLength ? displayStepFromMillimeters(step, workspace) : step;
  const sliderValue = clamp(controlValue, controlMin, controlMax);
  const position = ((sliderValue - controlMin) / Math.max(Number.EPSILON, controlMax - controlMin)) * 100;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatPropertyNumber(controlValue, accuracy, controlStep));
  const unit = isLength ? unitLabel(t, lengthDisplayUnit(workspace).label) : null;
  const toModelValue = (nextValue: number) => isLength ? displayToMillimeters(nextValue, workspace) : nextValue;
  const commitDraft = () => {
    const next = parseMeasurementInput(draft);
    const finiteNext = Number.isFinite(next) ? next : controlValue;
    const nextModelValue = toModelValue(finiteNext);
    onChange(allowsAboveSliderMax ? Math.max(min, nextModelValue) : clamp(nextModelValue, min, max));
    setEditing(false);
    onInteractionActiveChange?.(false);
  };
  const handleSliderChange = (nextValue: number) => {
    const next = clamp(Number.isFinite(nextValue) ? nextValue : controlMin, controlMin, controlMax);
    onChange(clamp(toModelValue(next), min, max));
    setDraft(formatPropertyNumber(next, accuracy, controlStep));
  };
  return (
    <label className="range-property" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span className="range-property-header">
        <span className="range-property-name">{label}</span>
        <span className="range-value-control">
          <input
            type="text"
            value={editing ? draft : formatPropertyNumber(controlValue, accuracy, controlStep)}
            disabled={disabled}
            inputMode="decimal"
            onFocus={() => {
              onInteractionActiveChange?.(true);
              setDraft(formatPropertyNumber(controlValue, accuracy, controlStep));
              setEditing(true);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setDraft(formatPropertyNumber(controlValue, accuracy, controlStep));
                setEditing(false);
              }
            }}
          />
          {unit ? <span className="range-value-unit">{unit}</span> : null}
        </span>
      </span>
      <div className="range-control">
        <input
          type="range"
          min={controlMin}
          max={controlMax}
          step={controlStep}
          value={sliderValue}
          disabled={disabled}
          onFocus={() => onInteractionActiveChange?.(true)}
          onBlur={() => onInteractionActiveChange?.(false)}
          onPointerDown={() => onInteractionActiveChange?.(true)}
          onPointerUp={() => onInteractionActiveChange?.(false)}
          onPointerCancel={() => onInteractionActiveChange?.(false)}
          onChange={(event) => handleSliderChange(Number(event.currentTarget.value))}
        />
      </div>
    </label>
  );
}

function TextProperty({ label, value, disabled, onChange, onInteractionActiveChange }: TextPropertyConfig & { label: string; disabled?: boolean; onInteractionActiveChange?: (active: boolean) => void }) {
  return (
    <label className="text-property">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        maxLength={24}
        spellCheck={false}
        onFocus={() => onInteractionActiveChange?.(true)}
        onBlur={() => onInteractionActiveChange?.(false)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function SelectProperty({ label, value, options, optionLabel, disabled, onChange }: SelectPropertyConfig & { label: string; disabled?: boolean }) {
  const t = useTranslations();
  return (
    <label className="select-property">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(t, option)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Material chooser plus the weight and cost it implies.
 *
 * All of the arithmetic is in lib/materialPresets; this only renders it. A
 * hole has no weight of its own and says so, and a shape whose volume has not
 * been measured shows the material without numbers rather than a wrong zero.
 */
function MaterialProperties({
  shape,
  workspace,
  volumeMm3,
  disabled,
  onUpdate,
  onMaterialPriceChange,
  onInteractionActiveChange,
}: {
  shape: WorkplaneShape;
  workspace: WorkplaneWorkspaceSettings;
  volumeMm3?: number;
  disabled?: boolean;
  onUpdate: ShapeInspectorUpdate;
  onMaterialPriceChange?: (materialId: MaterialId, pricePerKg: number) => void;
  onInteractionActiveChange?: (active: boolean) => void;
}) {
  const t = useTranslations();
  const preset = materialPreset(shape.material);
  const prices = workspace.materialPricesPerKg;
  const pricePerKg = preset ? materialPricePerKg(preset.id, prices) : 0;
  const estimate = volumeMm3 === undefined ? undefined : shapeMaterialEstimate(shape, volumeMm3, prices);
  const [priceDraft, setPriceDraft] = useState<string | null>(null);
  const commitPrice = () => {
    if (priceDraft !== null && preset && onMaterialPriceChange) {
      const parsed = Number.parseFloat(priceDraft.replace(",", "."));
      if (Number.isFinite(parsed) && parsed >= 0) onMaterialPriceChange(preset.id, parsed);
    }
    setPriceDraft(null);
    onInteractionActiveChange?.(false);
  };

  return (
    <>
      <label className="select-property">
        <span>{t("panels.material.label")}</span>
        <select
          value={shape.material ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const next = event.currentTarget.value;
            onUpdate({ material: next === "" ? undefined : next });
          }}
        >
          <option value="">{t("panels.material.none")}</option>
          {shape.material && !preset ? <option value={shape.material}>{shape.material}</option> : null}
          {MATERIAL_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {materialLabel(t, option.id)}
            </option>
          ))}
        </select>
      </label>
      {preset ? (
        <label className="select-property material-price-property">
          <span>{t("panels.material.pricePerKg")}</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label={t("panels.material.pricePerKgLabel")}
            value={priceDraft ?? formatMaterialNumber(pricePerKg, 2)}
            disabled={disabled || !onMaterialPriceChange}
            onFocus={() => {
              onInteractionActiveChange?.(true);
              setPriceDraft(formatMaterialNumber(pricePerKg, 2));
            }}
            onChange={(event) => setPriceDraft(event.currentTarget.value)}
            onBlur={commitPrice}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              else if (event.key === "Escape") setPriceDraft(null);
            }}
          />
        </label>
      ) : null}
      {preset && shape.hole ? <p className="material-readout-hint">{t("panels.material.holeHint")}</p> : null}
      {estimate ? (
        <>
          <p className="material-readout-hint">{t(materialVolumePrecisionMessage("tessellated"))}</p>
          <dl className="material-readout">
            <div>
              <dt>{t("panels.material.volume")}</dt>
              <dd>{t("panels.material.cubicCentimeters", { volume: formatMaterialNumber(estimate.volumeCm3, 2) })}</dd>
            </div>
            <div>
              <dt>{t("panels.material.weight")}</dt>
              <dd>{t("panels.material.grams", { grams: formatMaterialNumber(estimate.grams, 2) })}</dd>
            </div>
            <div>
              <dt>{t("panels.material.cost")}</dt>
              <dd>{formatMaterialNumber(estimate.cost, 2)}</dd>
            </div>
            <div>
              <dt>{t("panels.material.title")}</dt>
              <dd>{t("panels.material.density", { density: formatMaterialNumber(estimate.density, 2) })}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </>
  );
}

function GearTypePreview({ type }: { type: GearType }) {
  return <img src={`assets/sketchforge/gear-types/${type}.png`} alt="" aria-hidden="true" />;
}

function GearTypeSelector({ value, disabled, onChange }: { value: GearType; disabled?: boolean; onChange: (value: GearType) => void }) {
  const t = useTranslations();
  return (
    <div className="gear-type-property" role="group" aria-label={t("panels.gearType.label")}>
      <span>{t("panels.inspector.gearType")}</span>
      <div className="gear-type-options">
        {GEAR_TYPE_OPTIONS.map((option) => (
          <button
            key={option}
            className={value === option ? "selected" : ""}
            type="button"
            disabled={disabled}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
          >
            <GearTypePreview type={option} />
            <span>{t(`panels.gearType.${option}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
