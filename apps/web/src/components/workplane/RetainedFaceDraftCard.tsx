"use client";

import { useEffect, useState } from "react";
import { useTranslations, type MessageKey } from "@/i18n";
import { DRAFT_FACE_PULL_AXES, isDraftFaceAngle, type DraftFacePullAxis } from "@/lib/draftFaceEditor";
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
 * The face draft a sketch extrusion keeps, with its direction and angle
 * editable (#384).
 *
 * Shown only for a retained draft. Updating it redrafts the undrafted
 * extrusion from its sketch, so the face it acts on stays the one first chosen
 * however many times it is changed.
 */
export function RetainedFaceDraftCard({
  shape,
  locked,
  onUpdate,
  onInteractionActiveChange,
}: {
  shape: WorkplaneShape & { faceDraft: NonNullable<WorkplaneShape["faceDraft"]> };
  locked: boolean;
  onUpdate: (angle: number, pullDirection: DraftFacePullAxis) => Promise<void> | void;
  onInteractionActiveChange?: (active: boolean) => void;
}) {
  const t = useTranslations();
  const draft = shape.faceDraft;
  const [pullAxis, setPullAxis] = useState<DraftFacePullAxis>(draft.pullDirection);
  const [angle, setAngle] = useState(String(draft.angle));
  const [updating, setUpdating] = useState(false);
  // An undo, or a change made elsewhere, replaces the record under the card.
  useEffect(() => {
    setPullAxis(draft.pullDirection);
    setAngle(String(draft.angle));
  }, [draft.angle, draft.pullDirection]);

  const faceNumber = (shape.faceDraftSourceFaceIds?.indexOf(draft.sourceFaceId) ?? -1) + 1;
  const value = Number(angle);
  const changed = pullAxis !== draft.pullDirection || value !== draft.angle;

  return (
    <section className="property-card retained-face-draft-card" aria-label={t("panels.inspector.faceDraft.title")}>
      <div className="property-card-header"><span>{t("panels.inspector.faceDraft.title")}</span></div>
      <div className="property-list">
        <p className="face-tools-note">{t("panels.inspector.faceDraft.hint")}</p>
        {faceNumber > 0 ? <p className="face-tools-note">{t("panels.inspector.faceDraft.face", { face: faceNumber })}</p> : null}
        <label className="select-property">
          <span>{t("panels.inspector.faces.direction.label")}</span>
          <select value={pullAxis} disabled={locked || updating} onChange={(event) => setPullAxis(event.currentTarget.value as DraftFacePullAxis)}>
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
            disabled={locked || updating}
            onChange={(event) => setAngle(event.currentTarget.value)}
            onFocus={() => onInteractionActiveChange?.(true)}
            onBlur={() => onInteractionActiveChange?.(false)}
          />
        </label>
        <button
          className="inspector-action-button"
          type="button"
          disabled={locked || updating || !changed || !isDraftFaceAngle(value)}
          onClick={async () => {
            setUpdating(true);
            try { await onUpdate(value, pullAxis); } finally { setUpdating(false); }
          }}
        >
          <span>{t(updating ? "panels.inspector.faceDraft.updating" : "panels.inspector.faceDraft.update")}</span>
        </button>
      </div>
    </section>
  );
}
