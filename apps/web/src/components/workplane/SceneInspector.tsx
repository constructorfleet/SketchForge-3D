"use client";

import { Check, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Layers, LockKeyhole, LockKeyholeOpen, Pencil, Search, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "@/i18n";
import { sceneRows, sceneSummary } from "@/lib/sceneTree";
import { normalizeRenamedShapeName } from "@/lib/shapeName";
import { shapeDisplayName } from "@/lib/shapeDisplayNames";
import type { WorkplaneShape } from "@/types/sketchforge";

export type SceneInspectorProps = {
  shapes: WorkplaneShape[];
  selectedIds: string[];
  onSelectRow: (id: string, additive: boolean) => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
  onToggleLocked: (id: string, locked: boolean) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onGroup: () => void;
  onUngroup: () => void;
  canGroup: boolean;
  canUngroup: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Scene-wide checks shown under the group actions (#380). */
  analysis?: ReactNode;
};

export function SceneInspector({
  shapes,
  selectedIds,
  onSelectRow,
  onToggleHidden,
  onToggleLocked,
  onRename,
  onDelete,
  onGroup,
  onUngroup,
  canGroup,
  canUngroup,
  collapsed,
  onCollapsedChange,
  analysis,
}: SceneInspectorProps) {
  const t = useTranslations();
  const [filter, setFilter] = useState("");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

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

  const beginRename = (id: string, name: string) => {
    setEditingId(id);
    setDraftName(name);
  };

  const finishRename = (id: string, currentName: string) => {
    const nextName = normalizeRenamedShapeName(currentName, draftName);
    setEditingId(null);
    if (nextName) onRename(id, nextName);
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

      {analysis}

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

                {editingId === row.id ? (
                  <input
                    autoFocus
                    className="scene-row-rename-input"
                    aria-label={t("panels.scene.renameInput", { name })}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        finishRename(row.id, row.name);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingId(null);
                      }
                    }}
                  />
                ) : row.actionable ? (
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
                    {editingId === row.id ? (
                      <>
                        <button type="button" aria-label={t("panels.scene.saveName", { name })} onClick={() => finishRename(row.id, row.name)}>
                          <Check size={15} strokeWidth={2.2} aria-hidden="true" />
                        </button>
                        <button type="button" aria-label={t("panels.scene.cancelRename", { name })} onClick={() => setEditingId(null)}>
                          <X size={15} strokeWidth={2.2} aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <>
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
                      aria-label={t("panels.scene.rename", { name })}
                      onClick={() => beginRename(row.id, row.name)}
                    >
                      <Pencil size={14} strokeWidth={2.2} aria-hidden="true" />
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
                      </>
                    )}
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
