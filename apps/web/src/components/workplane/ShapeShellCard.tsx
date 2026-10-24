"use client";

import { ChevronUp } from "lucide-react";
import { useState } from "react";
import { unitLabel, useTranslations, type MessageKey } from "@/i18n";
import { displayToMillimeters, lengthDisplayUnit, millimetersToDisplay, parseMeasurementInput } from "@/lib/measurementUnits";
import { shapeFaceCount, shapeHasExactFaces } from "@/lib/shapeFaces";
import { SHELL_FACE_DIRECTIONS, parseShellFaceNumbers, type ShellFaceDirection, type ShellOpenFace } from "@/lib/shellEditor";
import type { WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

const DIRECTION_LABELS: Record<ShellFaceDirection, MessageKey> = {
  top: "panels.inspector.shell.direction.top",
  bottom: "panels.inspector.shell.direction.bottom",
  left: "panels.inspector.shell.direction.left",
  right: "panels.inspector.shell.direction.right",
  front: "panels.inspector.shell.direction.front",
  back: "panels.inspector.shell.direction.back",
};

/** The wall a new shell starts at, in mm: two perimeters of a common 0.4 mm nozzle and then some. */
const DEFAULT_WALL_MM = 2;

/** A length for reading, without the trailing zeros a fixed format leaves: 2, 1.6, 0.079. */
function compactNumber(value: number) {
  return String(Number(value.toFixed(3)));
}

/**
 * The inspector's shell card: hollow the shape to a wall, optionally leaving
 * faces open (#379).
 *
 * Faces are left open by side -- the REST API's `top`, `bottom` and so on -- or,
 * on a shape with exact faces, by the numbers the Faces card shows; a face
 * picked in the viewport while that card is open can be added with one press.
 * The thickness is typed in the workspace's length unit and sent in mm.
 */
export function ShapeShellCard({
  shape,
  locked,
  workspace,
  pickedFace,
  onApply,
  onInteractionActiveChange,
}: {
  shape: WorkplaneShape;
  locked: boolean;
  workspace: Pick<WorkplaneWorkspaceSettings, "units" | "scale">;
  pickedFace?: { shapeId: string; faceIndex: number; serial: number } | null;
  onApply: (thickness: number, openFaces: ShellOpenFace[]) => Promise<void> | void;
  onInteractionActiveChange?: (active: boolean) => void;
}) {
  const t = useTranslations();
  const unit = unitLabel(t, lengthDisplayUnit(workspace).label);
  const [open, setOpen] = useState(false);
  const [thickness, setThickness] = useState(() => compactNumber(millimetersToDisplay(DEFAULT_WALL_MM, workspace)));
  const [sides, setSides] = useState<ShellFaceDirection[]>([]);
  const [faceNumbers, setFaceNumbers] = useState("");
  const [busy, setBusy] = useState(false);
  const numbered = shapeHasExactFaces(shape);
  const faceCount = shapeFaceCount(shape);
  const parsedThickness = parseMeasurementInput(thickness);
  const thicknessMm = displayToMillimeters(parsedThickness, workspace);
  const faceIndexes = numbered && faceCount ? parseShellFaceNumbers(faceNumbers, faceCount) : [];
  const ready = !locked && !busy && Number.isFinite(thicknessMm) && thicknessMm > 0 && faceIndexes !== null;
  const picked = numbered && pickedFace?.shapeId === shape.id && pickedFace.faceIndex < faceCount ? pickedFace.faceIndex : null;

  const toggleSide = (side: ShellFaceDirection) => setSides((current) => current.includes(side)
    ? current.filter((entry) => entry !== side)
    : SHELL_FACE_DIRECTIONS.filter((entry) => entry === side || current.includes(entry)));

  return (
    <section className={`property-card shell-card ${open ? "" : "collapsed"}`} aria-label={t("panels.inspector.shell.title")}>
      <button
        className="property-card-header"
        type="button"
        aria-expanded={open}
        aria-controls={`shell-${shape.id}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{t("panels.inspector.shell.title")}</span>
        <ChevronUp className={open ? "" : "collapsed"} size={25} strokeWidth={2.8} />
      </button>
      {open ? (
        <div className="property-list" id={`shell-${shape.id}`}>
          {shape.shell ? (
            <p className="face-tools-note shell-current">
              {t("panels.inspector.shell.hollowed", {
                thickness: compactNumber(millimetersToDisplay(shape.shell.thickness, workspace)),
                unit,
              })}
            </p>
          ) : null}
          <p className="face-tools-note">{t("panels.inspector.shell.hint")}</p>
          <label className="select-property">
            <span>{t("panels.inspector.shell.thickness")} ({unit})</span>
            <input
              className="face-draft-angle"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.1"
              value={thickness}
              disabled={locked || busy}
              onChange={(event) => setThickness(event.currentTarget.value)}
              onFocus={() => onInteractionActiveChange?.(true)}
              onBlur={() => onInteractionActiveChange?.(false)}
            />
          </label>
          <fieldset className="shell-open-faces" disabled={locked || busy}>
            <legend>{t("panels.inspector.shell.openFaces")}</legend>
            <div className="shell-open-sides">
              {SHELL_FACE_DIRECTIONS.map((side) => (
                <label key={side}>
                  <input type="checkbox" checked={sides.includes(side)} onChange={() => toggleSide(side)} />
                  <span>{t(DIRECTION_LABELS[side])}</span>
                </label>
              ))}
            </div>
            <p className="face-tools-note">{t("panels.inspector.shell.directionsHint")}</p>
            {numbered && faceCount ? (
              <>
                <label className="select-property">
                  <span>{t("panels.inspector.shell.faceNumbers")}</span>
                  <input
                    className="face-draft-angle"
                    type="text"
                    inputMode="numeric"
                    value={faceNumbers}
                    aria-invalid={faceIndexes === null}
                    aria-describedby={`shell-faces-hint-${shape.id}`}
                    onChange={(event) => setFaceNumbers(event.currentTarget.value)}
                    onFocus={() => onInteractionActiveChange?.(true)}
                    onBlur={() => onInteractionActiveChange?.(false)}
                  />
                </label>
                <p className="face-tools-note" id={`shell-faces-hint-${shape.id}`}>
                  {faceIndexes === null
                    ? t("panels.inspector.shell.faceNumbersInvalid", { count: faceCount })
                    : t("panels.inspector.shell.faceNumbersHint")}
                </p>
                {picked !== null && !(faceIndexes ?? []).includes(picked) ? (
                  <button
                    className="face-color-clear"
                    type="button"
                    onClick={() => setFaceNumbers((current) => [current.trim(), String(picked + 1)].filter(Boolean).join(", "))}
                  >
                    {t("panels.inspector.shell.addPicked", { face: picked + 1 })}
                  </button>
                ) : null}
              </>
            ) : null}
          </fieldset>
          <button
            className="inspector-action-button"
            type="button"
            disabled={!ready}
            onClick={async () => {
              if (!ready || faceIndexes === null) return;
              setBusy(true);
              try {
                await onApply(thicknessMm, [...sides, ...faceIndexes]);
              } finally {
                setBusy(false);
              }
            }}
          >
            <span>{t(busy ? "panels.inspector.shell.applying" : "panels.inspector.shell.apply")}</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
