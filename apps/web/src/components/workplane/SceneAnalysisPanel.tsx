"use client";

import { useMemo, useState } from "react";
import { errorText, useLocale, useTranslations } from "@/i18n";
import {
  interferenceTargets,
  sceneAnalysisRefusalText,
  wallThicknessTarget,
  type SceneAnalysisRunner,
  type SceneInterferenceOutcome,
  type SceneWallThicknessOutcome,
} from "@/lib/sceneAnalysis";
import { shapeDisplayName } from "@/lib/shapeDisplayNames";
import type { WorkplaneShape } from "@/types/sketchforge";

export type SceneAnalysisPanelProps = {
  shapes: WorkplaneShape[];
  selectedIds: string[];
  runner: SceneAnalysisRunner;
  /** Selects the shapes of a reported pair. Selection is not an edit, so this adds no history. */
  onSelectShapes: (ids: string[]) => void;
};

type Result =
  | { kind: "interference"; checked: WorkplaneShape[]; outcome: SceneInterferenceOutcome }
  | { kind: "thickness"; checked: WorkplaneShape[]; outcome: SceneWallThicknessOutcome }
  | { kind: "failed"; message: string };

function pairKey(ids: readonly string[]) {
  return [...ids].sort().join("\n");
}

/**
 * Interference and wall-thickness checks over the scene (#380).
 *
 * Read-only by construction: it holds its own result state, and the only thing
 * it can do to the editor is select the two shapes of a pair. A result goes
 * stale as soon as any shape it measured is edited, and says so rather than
 * describing geometry that is no longer there.
 */
export function SceneAnalysisPanel({ shapes, selectedIds, runner, onSelectShapes }: SceneAnalysisPanelProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const volumeFormat = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }), [locale]);
  const lengthFormat = useMemo(() => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 3 }), [locale]);
  const targets = useMemo(() => interferenceTargets(shapes, selectedIds), [shapes, selectedIds]);
  const thicknessShape = useMemo(() => wallThicknessTarget(shapes, selectedIds), [shapes, selectedIds]);
  const selectionScoped = targets.length >= 2 && targets.every((shape) => selectedIds.includes(shape.id));
  const selectionKey = pairKey(selectedIds);
  const nameOf = (id: string, fallback: string) => shapeDisplayName(t, shapes.find((shape) => shape.id === id)?.name ?? fallback);

  // Shapes are replaced, never mutated, so a measured shape that is no longer
  // in the scene by identity has been edited or deleted since.
  const stale = result !== null && result.kind !== "failed" && result.checked.some((checked) => !shapes.includes(checked));

  const run = async (work: () => Promise<Result>) => {
    setBusy(true);
    try {
      setResult(await work());
    } catch (error) {
      setResult({ kind: "failed", message: errorText(t, error, "panels.analysis.failed") });
    } finally {
      setBusy(false);
    }
  };

  const checkInterference = () => {
    const checked = targets;
    void run(async () => ({ kind: "interference", checked, outcome: await runner.interference(checked) }));
  };

  const checkThickness = () => {
    const shape = thicknessShape;
    if (!shape) return;
    void run(async () => ({ kind: "thickness", checked: [shape], outcome: await runner.wallThickness(shape) }));
  };

  let summary = "";
  let refused = false;
  if (busy) summary = t("panels.analysis.running");
  else if (result?.kind === "failed") {
    summary = result.message;
    refused = true;
  } else if (result && !result.outcome.ok) {
    summary = sceneAnalysisRefusalText(t, result.outcome.refusal);
    refused = true;
  } else if (result?.kind === "interference" && result.outcome.ok) {
    const { pairs, shapesChecked } = result.outcome.value;
    summary = pairs.length === 0
      ? t("panels.analysis.noCollisions", { count: shapesChecked })
      : t("panels.analysis.collisions", { pairs: pairs.length, count: shapesChecked });
  } else if (result?.kind === "thickness" && result.outcome.ok) {
    const shape = result.checked[0]!;
    const minimum = result.outcome.value.minimum;
    summary = minimum === null
      ? t("panels.analysis.thicknessNone", { name: nameOf(shape.id, shape.name) })
      : t("panels.analysis.thicknessResult", { name: nameOf(shape.id, shape.name), value: lengthFormat.format(minimum) });
  }

  const report = !busy && result && result.kind !== "failed" && result.outcome.ok ? result : null;

  return (
    <section className="scene-analysis" aria-label={t("panels.analysis.title")} aria-busy={busy}>
      <h3 className="scene-analysis-title">{t("panels.analysis.title")}</h3>
      <div className="scene-inspector-actions">
        <button type="button" disabled={busy || targets.length < 2} onClick={checkInterference}>{t("panels.analysis.checkInterference")}</button>
        <button type="button" disabled={busy || !thicknessShape} onClick={checkThickness}>{t("panels.analysis.wallThickness")}</button>
      </div>
      <p className="scene-analysis-note">
        {selectionScoped
          ? t("panels.analysis.scopeSelection", { count: targets.length })
          : t("panels.analysis.scopeScene", { count: targets.length })}
        {thicknessShape ? null : ` ${t("panels.analysis.thicknessHint")}`}
      </p>

      <p className={`scene-analysis-summary ${refused ? "refused" : ""}`} role="status" aria-live="polite">{summary}</p>
      {!busy && stale ? <p className="scene-analysis-stale">{t("panels.analysis.stale")}</p> : null}

      {report?.kind === "interference" && report.outcome.ok ? (
        <>
          {report.outcome.value.pairs.length > 0 ? (
            <ul className="scene-analysis-pairs" aria-label={t("panels.analysis.pairsLabel")}>
              {report.outcome.value.pairs.map((pair) => (
                <li key={pairKey([pair.a.id, pair.b.id])}>
                  <button
                    type="button"
                    aria-pressed={pairKey([pair.a.id, pair.b.id]) === selectionKey}
                    onClick={() => onSelectShapes([pair.a.id, pair.b.id])}
                  >
                    <span className="scene-analysis-pair-names">{t("panels.analysis.pair", { a: nameOf(pair.a.id, pair.a.name), b: nameOf(pair.b.id, pair.b.name) })}</span>
                    <span className="scene-analysis-pair-detail">
                      {pair.overlapVolume > 0
                        ? t("panels.analysis.overlap", { volume: volumeFormat.format(pair.overlapVolume) })
                        : t("panels.analysis.touching")}
                      {pair.precision === "tessellated" ? ` · ${t("panels.analysis.tessellated")}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="scene-analysis-method">{t("panels.analysis.interferenceMethod")}</p>
        </>
      ) : null}

      {report?.kind === "thickness" && report.outcome.ok ? (
        <p className="scene-analysis-method">
          {t("panels.analysis.thicknessMethod", { samples: report.outcome.value.samplesPerFace, faces: report.outcome.value.facesChecked })}
        </p>
      ) : null}
      <p className="scene-analysis-method">{t("panels.analysis.readOnly")}</p>
    </section>
  );
}
