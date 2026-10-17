"use client";

import { ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Layers, LockKeyhole, LockKeyholeOpen, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslations } from "@/i18n";
import { sceneRows, sceneSummary } from "@/lib/sceneTree";
import { shapeDisplayName } from "@/lib/shapeDisplayNames";
import type { WorkplaneShape } from "@/types/sketchforge";

export type SceneInspectorProps = {
  shapes: WorkplaneShape[];
  selectedIds: string[];
  onSelectRow: (id: string, additive: boolean) => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
  onToggleLocked: (id: string, locked: boolean) => void;
  onDelete: (id: string) => void;
  onGroup: () => void;
  onUngroup: () => void;
  canGroup: boolean;
  canUngroup: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
};

export function SceneInspector({
  shapes,
  selectedIds,
  onSelectRow,
  onToggleHidden,
  onToggleLocked,
  onDelete,
  onGroup,
  onUngroup,
  canGroup,
  canUngroup,
  collapsed,
  onCollapsedChange,
}: SceneInspectorProps) {
  const t = useTranslations();
  const [filter, setFilter] = useState("");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo(
    () => sceneRows(shapes, { expandedIds, filter }),
    [shapes, expandedIds, filter],
  );
  const summary = useMemo(() => sceneSummary(shapes), [shapes]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <aside className={`scene-inspector ${collapsed ? "collapsed" : ""}`} aria-label={t("panels.scene.title")} onPointerDown={(event) => event.stopPropagation()}>
      <header className="shape-inspector-header">
        <button
          type="button"
          className="inspector-header-icon"
          aria-label={collapsed ? t("panels.scene.expand") : t("panels.scene.collapse")}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronDown size={26} strokeWidth={2.8} /> : <ChevronUp size={26} strokeWidth={2.8} />}
        </button>
        <span className="inspector-header-glyph" aria-hidden="true"><Layers size={18} strokeWidth={2.2} /></span>
        <strong>{t("panels.scene.title")}</strong>
      </header>

      {collapsed ? null : (
      <div className="scene-inspector-body">

      <p className="scene-inspector-summary">
        {t("panels.scene.summary", { count: summary.total, hidden: summary.hidden })}
      </p>

      <div className="scene-inspector-actions">
        <button type="button" disabled={!canGroup} onClick={onGroup}>{t("editor.toolbar.group")}</button>
        <button type="button" disabled={!canUngroup} onClick={onUngroup}>{t("editor.toolbar.ungroup")}</button>
      </div>

      <label className="scene-inspector-search">
        <Search size={15} strokeWidth={2.2} aria-hidden="true" />
        <input
          type="search"
          value={filter}
          placeholder={t("panels.scene.searchPlaceholder")}
          aria-label={t("panels.scene.searchLabel")}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>

      {rows.length === 0 ? (
        <p className="scene-inspector-empty">
          {summary.total === 0 ? t("panels.scene.empty") : t("panels.scene.noMatches")}
        </p>
      ) : (
        <ul className="scene-inspector-list">
          {rows.map((row) => {
            const isSelected = row.actionable && selected.has(row.id);
            const name = shapeDisplayName(t, row.name);
            return (
              <li
                key={`${row.id}-${row.depth}`}
                className={`scene-row ${isSelected ? "selected" : ""} ${row.actionable ? "" : "nested"} ${row.hidden ? "hidden-shape" : ""}`}
                style={{ paddingLeft: `${6 + row.depth * 14}px` }}
              >
                {row.childCount > 0 ? (
                  <button
                    type="button"
                    className="scene-row-expand"
                    aria-label={t(expandedIds.has(row.id) ? "panels.scene.collapseGroup" : "panels.scene.expandGroup", { name })}
                    aria-expanded={expandedIds.has(row.id)}
                    onClick={() => toggleExpanded(row.id)}
                  >
                    {expandedIds.has(row.id)
                      ? <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" />
                      : <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />}
                  </button>
                ) : <span className="scene-row-expand-spacer" aria-hidden="true" />}

                <span className="scene-row-swatch" style={{ background: row.color }} aria-hidden="true" />

                {row.actionable ? (
                  <button
                    type="button"
                    className="scene-row-name"
                    aria-pressed={isSelected}
                    onClick={(event) => onSelectRow(row.id, event.shiftKey || event.metaKey || event.ctrlKey)}
                  >
                    <span className="scene-row-label">{name}</span>
                    {row.childCount > 0 ? <span className="scene-row-count">{row.childCount}</span> : null}
                    {row.hole ? <span className="scene-row-tag">{t("panels.scene.hole")}</span> : null}
                  </button>
                ) : (
                  <span className="scene-row-name static">
                    <span className="scene-row-label">{name}</span>
                    {row.childCount > 0 ? <span className="scene-row-count">{row.childCount}</span> : null}
                  </span>
                )}

                {row.actionable ? (
                  <span className="scene-row-controls">
                    <button
                      type="button"
                      className={row.hidden ? "active" : ""}
                      aria-label={t(row.hidden ? "panels.scene.show" : "panels.scene.hide", { name })}
                      aria-pressed={row.hidden}
                      onClick={() => onToggleHidden(row.id, !row.hidden)}
                    >
                      {row.hidden
                        ? <EyeOff size={15} strokeWidth={2.2} aria-hidden="true" />
                        : <Eye size={15} strokeWidth={2.2} aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className={row.locked ? "active" : ""}
                      aria-label={t(row.locked ? "panels.scene.unlock" : "panels.scene.lock", { name })}
                      aria-pressed={row.locked}
                      onClick={() => onToggleLocked(row.id, !row.locked)}
                    >
                      {row.locked
                        ? <LockKeyhole size={15} strokeWidth={2.2} aria-hidden="true" />
                        : <LockKeyholeOpen size={15} strokeWidth={2.2} aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className="scene-row-delete"
                      aria-label={t("panels.scene.delete", { name })}
                      disabled={row.locked}
                      onClick={() => onDelete(row.id)}
                    >
                      <Trash2 size={15} strokeWidth={2.2} aria-hidden="true" />
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      </div>
      )}
    </aside>
  );
}
