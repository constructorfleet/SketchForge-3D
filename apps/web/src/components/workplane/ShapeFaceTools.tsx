"use client";

import { ChevronLeft, ChevronRight, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations, type MessageKey } from "@/i18n";
import { updateFaceColor } from "@/lib/faceColorEditor";
import { DRAFT_FACE_PULL_AXES, applyDraftFaceSelection, draftFaceRequestForShape, type DraftFacePullAxis } from "@/lib/draftFaceEditor";
import { faceColorsWith, shapeFaceCount, shapeFaceKey, shapeHasExactFaces } from "@/lib/shapeFaces";
import type { WorkplaneShape } from "@/types/sketchforge";

const PULL_AXIS_LABELS: Record<DraftFacePullAxis, MessageKey> = {
  x: "panels.inspector.faces.direction.x",
  "-x": "panels.inspector.faces.direction.negX",
  y: "panels.inspector.faces.direction.y",
  "-y": "panels.inspector.faces.direction.negY",
  z: "panels.inspector.faces.direction.z",
  "-z": "panels.inspector.faces.direction.negZ",
};

/**
 * The inspector's face colour and face draft tools.
 *
 * Both act on one face, chosen once here and highlighted in the viewport while
 * the pointer or focus is in the card. While the card is open the face can also
 * be picked in the viewport, which hands it back through `pickedFace`; the
 * stepper stays as the keyboard way to choose one. A shape without exact faces gets an
 * explicit "Enable face editing" action instead of the tools simply not being
 * there.
 */
export function ShapeFaceTools({
  shape,
  locked,
  fallbackColor,
  onUpdateFaceColors,
  onEnableFaceEditing,
  onApplyDraftFace,
  onHighlightFace,
  onFacePickingChange,
  pickedFace,
}: {
  shape: WorkplaneShape;
  locked: boolean;
  fallbackColor: string;
  onUpdateFaceColors: (faceColors: Record<string, string>) => void;
  onEnableFaceEditing?: () => Promise<void> | void;
  onApplyDraftFace?: (faceIndex: number, angle: number, pullDirection: DraftFacePullAxis) => Promise<void> | void;
  onHighlightFace?: (faceIndex: number | null) => void;
  /** Told which shape's faces can be picked in the viewport right now, or null for none. */
  onFacePickingChange?: (shapeId: string | null) => void;
  /** The face last picked in the viewport; a new `serial` chooses it again. */
  pickedFace?: { shapeId: string; faceIndex: number; serial: number } | null;
}) {
  const t = useTranslations();
  const exact = shapeHasExactFaces(shape);
  const [open, setOpen] = useState(true);
  const [faceIndex, setFaceIndex] = useState(0);
  const [faceInput, setFaceInput] = useState("1");
  const [active, setActive] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [pullAxis, setPullAxis] = useState<DraftFacePullAxis>("y");
  const [angle, setAngle] = useState("5");
  const [drafting, setDrafting] = useState(false);
  const faceCount = shapeFaceCount(shape);
  const lastFace = faceCount ? faceCount - 1 : Number.POSITIVE_INFINITY;
  const faceKey = shapeFaceKey(shape, faceIndex);
  const faceColor = shape.faceColors?.[faceKey] ?? shape.faceColors?.[String(faceIndex)];
  const canDraft = Boolean(exact && shape.cadBrepFrame && onApplyDraftFace);
  const draftReady = canDraft && Boolean(draftFaceRequestForShape(shape, faceIndex, Number(angle), pullAxis));

  // Faces are numbered from 1 for people; the stored index starts at 0.
  const chooseFace = (index: number) => {
    const next = Math.max(0, Math.min(lastFace, Math.round(index)));
    setFaceIndex(next);
    setFaceInput(String(next + 1));
  };

  // A draft or undo can leave fewer faces than the one chosen.
  useEffect(() => {
    if (faceCount && faceIndex > faceCount - 1) {
      setFaceIndex(faceCount - 1);
      setFaceInput(String(faceCount));
    }
  }, [faceCount, faceIndex]);
  useEffect(() => {
    onHighlightFace?.(exact && open && active ? faceIndex : null);
  }, [active, exact, faceIndex, onHighlightFace, open]);
  useEffect(() => () => onHighlightFace?.(null), [onHighlightFace]);
  const pickable = exact && open && !locked;
  useEffect(() => {
    onFacePickingChange?.(pickable ? shape.id : null);
  }, [onFacePickingChange, pickable, shape.id]);
  useEffect(() => () => onFacePickingChange?.(null), [onFacePickingChange]);
  // Only a new pick moves the stepper, so stepping away from a picked face
  // sticks, and a pick made before this panel opened is not replayed.
  const pickSerial = pickedFace?.shapeId === shape.id ? pickedFace.serial : null;
  const pickedIndex = pickedFace?.faceIndex ?? 0;
  const seenPick = useRef(pickSerial);
  useEffect(() => {
    if (pickSerial === seenPick.current) return;
    seenPick.current = pickSerial;
    if (pickSerial === null) return;
    const next = Math.max(0, Math.min(lastFace, pickedIndex));
    setFaceIndex(next);
    setFaceInput(String(next + 1));
  }, [lastFace, pickSerial, pickedIndex]);
  const faceId = shape.faceIds?.[faceIndex];

  const coloredFaces = Object.entries(shape.faceColors ?? {})
    .map(([key, color]) => {
      const byId = shape.faceIds?.indexOf(key) ?? -1;
      const index = byId >= 0 ? byId : Number.isInteger(Number(key)) ? Number(key) : -1;
      return { key, color, index };
    })
    .sort((a, b) => (a.index < 0 ? Infinity : a.index) - (b.index < 0 ? Infinity : b.index));

  return (
    <section
      className={`property-card face-tools-card ${open ? "" : "collapsed"}`}
      aria-label={t("panels.inspector.faces.title")}
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false);
      }}
    >
      <button
        className="property-card-header"
        type="button"
        aria-expanded={open}
        aria-controls={`faces-${shape.id}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{t("panels.inspector.faces.title")}</span>
        <ChevronUp className={open ? "" : "collapsed"} size={25} strokeWidth={2.8} />
      </button>
      {open ? (
        <div className="property-list" id={`faces-${shape.id}`}>
          {!exact ? (
            <>
              <p className="face-tools-note">{t("panels.inspector.faces.enableHint")}</p>
              <button
                className="inspector-action-button"
                type="button"
                disabled={locked || enabling || !onEnableFaceEditing}
                onClick={async () => {
                  if (!onEnableFaceEditing) return;
                  setEnabling(true);
                  try { await onEnableFaceEditing(); } finally { setEnabling(false); }
                }}
              >
                <span>{t(enabling ? "panels.inspector.faces.enabling" : "panels.inspector.faces.enable")}</span>
              </button>
            </>
          ) : (
            <>
              <div className="face-picker">
                <span id={`face-picker-label-${shape.id}`}>{t("panels.inspector.faces.face")}</span>
                <div className="face-stepper">
                  <button type="button" aria-label={t("panels.inspector.faces.previous")} disabled={locked || faceIndex <= 0} onClick={() => chooseFace(faceIndex - 1)}>
                    <ChevronLeft size={16} strokeWidth={2.6} />
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={faceCount || undefined}
                    step={1}
                    aria-labelledby={`face-picker-label-${shape.id}`}
                    value={faceInput}
                    disabled={locked}
                    onChange={(event) => {
                      setFaceInput(event.currentTarget.value);
                      const value = Number(event.currentTarget.value);
                      if (Number.isInteger(value) && value >= 1 && value - 1 <= lastFace) setFaceIndex(value - 1);
                    }}
                    onBlur={() => setFaceInput(String(faceIndex + 1))}
                  />
                  <button type="button" aria-label={t("panels.inspector.faces.next")} disabled={locked || faceIndex >= lastFace} onClick={() => chooseFace(faceIndex + 1)}>
                    <ChevronRight size={16} strokeWidth={2.6} />
                  </button>
                </div>
                {faceCount ? <span className="face-count">{t("panels.inspector.faces.of", { count: faceCount })}</span> : null}
              </div>
              {faceId ? <p className="face-id">{t("panels.inspector.faces.faceId", { id: faceId })}</p> : null}
              <p className="face-tools-note">{t("panels.inspector.faces.highlightHint")}</p>

              <div className="face-color-control">
                <label className={locked ? "custom-color disabled" : "custom-color"}>
                  <input
                    type="color"
                    aria-label={t("panels.inspector.faces.colorFor", { face: faceIndex + 1 })}
                    disabled={locked}
                    value={faceColor ?? fallbackColor}
                    onChange={(event) => onUpdateFaceColors(faceColorsWith(shape, faceIndex, event.currentTarget.value))}
                  />
                  <span>{faceColor ? faceColor.toUpperCase() : t("panels.inspector.faces.chooseColor")}</span>
                </label>
                {faceColor ? (
                  <button type="button" className="face-color-clear" disabled={locked} onClick={() => onUpdateFaceColors(faceColorsWith(shape, faceIndex, null))}>
                    {t("panels.inspector.faces.clearColor")}
                  </button>
                ) : null}
              </div>

              {coloredFaces.length ? (
                <ul className="face-color-list" aria-label={t("panels.inspector.faces.coloredFaces")}>
                  {coloredFaces.map(({ key, color, index }) => (
                    <li key={key} className={index === faceIndex ? "selected" : undefined}>
                      <button type="button" className="face-color-select" disabled={locked || index < 0} onClick={() => chooseFace(index)}>
                        <span className="face-color-swatch" style={{ background: color }} aria-hidden="true" />
                        <span>{index >= 0 ? t("panels.inspector.faces.faceNumber", { face: index + 1 }) : key}</span>
                        <span className="color-value">{color.toUpperCase()}</span>
                      </button>
                      <button type="button" className="face-color-remove" disabled={locked} aria-label={t("panels.inspector.faces.remove", { face: index >= 0 ? index + 1 : key })} onClick={() => onUpdateFaceColors(updateFaceColor(shape.faceColors, key, null))}>
                        <X size={14} strokeWidth={2.6} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="face-tools-note">{t("panels.inspector.faces.noColors")}</p>
              )}

              {canDraft ? (
                <div className="face-draft" role="group" aria-label={t("panels.inspector.faces.draftTitle")}>
                  <span className="face-draft-title">{t("panels.inspector.faces.draftTitle")}</span>
                  <p className="face-tools-note">{t("panels.inspector.faces.draftHint")}</p>
                  <label className="select-property">
                    <span>{t("panels.inspector.faces.direction.label")}</span>
                    <select value={pullAxis} disabled={locked || drafting} onChange={(event) => setPullAxis(event.currentTarget.value as DraftFacePullAxis)}>
                      {DRAFT_FACE_PULL_AXES.map((axis) => <option key={axis} value={axis}>{t(PULL_AXIS_LABELS[axis])}</option>)}
                    </select>
                  </label>
                  <label className="select-property">
                    <span>{t("panels.inspector.faces.angle")}</span>
                    <input
                      className="face-draft-angle"
                      type="number"
                      min="-44.9"
                      max="44.9"
                      step="0.5"
                      value={angle}
                      disabled={locked || drafting}
                      onChange={(event) => setAngle(event.currentTarget.value)}
                    />
                  </label>
                  <button
                    className="inspector-action-button"
                    type="button"
                    disabled={locked || drafting || !draftReady}
                    onClick={async () => {
                      if (!onApplyDraftFace) return;
                      setDrafting(true);
                      try { await applyDraftFaceSelection(shape, faceIndex, Number(angle), pullAxis, onApplyDraftFace); }
                      finally { setDrafting(false); }
                    }}
                  >
                    <span>{t(drafting ? "panels.inspector.faces.drafting" : "panels.inspector.faces.applyDraft")}</span>
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
