"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useTranslations } from "@/i18n";
import {
  parameterDeleteWarning,
  parameterRows,
  parameterTableKey,
  type ParameterDeleteWarning,
  type ParameterEdit,
  type ParameterMessage,
} from "@/lib/projectParameterEdits";
import type { ProjectParameter, ProjectParameterDimension, WorkplaneShape } from "@/types/sketchforge";

const DIMENSIONS: readonly ProjectParameterDimension[] = ["length", "angle", "unitless"];

type Field = "name" | "expression" | "dimension";
type RowError = { field: Field; message: ParameterMessage };

/** Resolves to the refusal, or null once the edit is committed. */
export type ParameterEditHandler = (edit: ParameterEdit) => Promise<ParameterMessage | null>;

export function ProjectParametersPanel({
  parameters,
  shapes,
  busy,
  onEdit,
  onClose,
}: {
  parameters: readonly ProjectParameter[];
  shapes: readonly WorkplaneShape[];
  busy: boolean;
  onEdit: ParameterEditHandler;
  onClose: () => void;
}) {
  const t = useTranslations();
  const dialogRef = useDialogFocus<HTMLDivElement>({ onEscape: onClose });
  const idPrefix = useId();
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<"name" | "expression", string>>>>({});
  const [errors, setErrors] = useState<Record<string, RowError>>({});
  const [pendingDelete, setPendingDelete] = useState<{ name: string; warning: ParameterDeleteWarning } | null>(null);
  const [newName, setNewName] = useState("");
  const [newExpression, setNewExpression] = useState("");
  const [newDimension, setNewDimension] = useState<ProjectParameterDimension>("length");
  const [addError, setAddError] = useState<ParameterMessage | null>(null);
  // Escape reverts a draft; the blur that follows must not commit it.
  const skipBlurCommitRef = useRef(false);
  const rows = parameterRows(parameters);
  // Undo, redo or a commit replaces the table; drafts and errors about the old one are stale.
  const tableKey = parameterTableKey(parameters);
  const tableKeyRef = useRef(tableKey);
  tableKeyRef.current = tableKey;
  // Reset during render, so a stale error is never committed and announced.
  const [seenTableKey, setSeenTableKey] = useState(tableKey);
  if (seenTableKey !== tableKey) {
    setSeenTableKey(tableKey);
    setDrafts({});
    setErrors({});
    setPendingDelete(null);
  }
  const text = (message: ParameterMessage) => t(message.key, message.values);

  const clearRow = (name: string) => {
    setDrafts(({ [name]: _draft, ...rest }) => rest);
    setErrors(({ [name]: _error, ...rest }) => rest);
  };

  const submit = async (rowName: string, field: Field, edit: ParameterEdit) => {
    const startKey = tableKeyRef.current;
    const refusal = await onEdit(edit);
    // A refusal about a table that has since been replaced, for example by undo, no longer applies.
    if (refusal && tableKeyRef.current !== startKey) return;
    if (refusal) {
      setErrors((current) => ({ ...current, [rowName]: { field, message: refusal } }));
      return;
    }
    clearRow(rowName);
    if (edit.kind === "rename") clearRow(edit.newName);
  };

  const commitDraft = (rowName: string, field: "name" | "expression") => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    const draft = drafts[rowName]?.[field];
    const row = parameters.find((parameter) => parameter.name === rowName);
    if (draft === undefined || !row || draft === row[field]) return;
    void submit(rowName, field, field === "name"
      ? { kind: "rename", name: rowName, newName: draft.trim() }
      : { kind: "update", name: rowName, expression: draft });
  };

  const draftKeys = (rowName: string) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape" && drafts[rowName]) {
      event.preventDefault();
      skipBlurCommitRef.current = true;
      clearRow(rowName);
      event.currentTarget.blur();
    }
  };

  const requestDelete = (name: string) => {
    const warning = parameterDeleteWarning({ parameters: [...parameters], shapes: [...shapes] }, name);
    if (!warning) {
      void submit(name, "name", { kind: "delete", name });
      return;
    }
    setPendingDelete({ name, warning });
  };

  const addParameter = async () => {
    const refusal = await onEdit({ kind: "add", name: newName.trim(), expression: newExpression, dimension: newDimension });
    setAddError(refusal);
    if (refusal) return;
    setNewName("");
    setNewExpression("");
  };

  const errorId = (index: number) => `${idPrefix}-error-${index}`;

  return (
    <div
      ref={dialogRef}
      className="top-action-panel parameters-action-panel"
      role="dialog"
      aria-modal="true"
      aria-label={t("editor.parameters.title")}
      aria-busy={busy}
      tabIndex={-1}
    >
      <header>
        <div className="top-action-heading">
          <strong>{t("editor.parameters.title")}</strong>
        </div>
        <button type="button" aria-label={t("editor.panel.close", { title: t("editor.parameters.title") })} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="parameters-panel-body">
        <p className="parameters-panel-intro">{t("editor.parameters.intro")}</p>
        {rows.length === 0 ? <p className="parameters-panel-empty">{t("editor.parameters.empty")}</p> : (
          <table className="parameters-table" aria-label={t("editor.parameters.tableLabel")}>
            <thead>
              <tr>
                <th scope="col">{t("editor.parameters.name")}</th>
                <th scope="col">{t("editor.parameters.expression")}</th>
                <th scope="col">{t("editor.parameters.value")}</th>
                <th scope="col">{t("editor.parameters.dimension")}</th>
                <th scope="col" aria-label={t("editor.parameters.delete")} />
              </tr>
            </thead>
            <tbody>
              {/* Keyed by position, not name, so a rename keeps the row and its focus. */}
              {rows.map((row, index) => {
                const draft = drafts[row.name] ?? {};
                const editError = errors[row.name];
                const message = editError?.message ?? row.error;
                const invalid = (field: Field) => (editError ? editError.field === field : field === "expression" && Boolean(row.error));
                const describedBy = message ? errorId(index) : undefined;
                const warning = pendingDelete?.name === row.name ? pendingDelete.warning : null;
                return [
                  <tr key={`row-${index}`} className="parameters-row">
                    <td>
                      <input
                        className="parameters-input parameters-name-input"
                        aria-label={t("editor.parameters.nameOf", { name: row.name })}
                        aria-invalid={invalid("name") || undefined}
                        aria-describedby={invalid("name") ? describedBy : undefined}
                        value={draft.name ?? row.name}
                        spellCheck={false}
                        autoComplete="off"
                        disabled={busy}
                        onChange={(event) => { const name = event.target.value; setDrafts((current) => ({ ...current, [row.name]: { ...current[row.name], name } })); }}
                        onBlur={() => commitDraft(row.name, "name")}
                        onKeyDown={draftKeys(row.name)}
                      />
                    </td>
                    <td>
                      <input
                        className="parameters-input parameters-expression-input"
                        aria-label={t("editor.parameters.expressionOf", { name: row.name })}
                        aria-invalid={invalid("expression") || undefined}
                        aria-describedby={invalid("expression") ? describedBy : undefined}
                        value={draft.expression ?? row.expression}
                        spellCheck={false}
                        autoComplete="off"
                        disabled={busy}
                        onChange={(event) => { const expression = event.target.value; setDrafts((current) => ({ ...current, [row.name]: { ...current[row.name], expression } })); }}
                        onBlur={() => commitDraft(row.name, "expression")}
                        onKeyDown={draftKeys(row.name)}
                      />
                    </td>
                    <td className="parameters-value">
                      <output aria-label={`${row.name} = ${row.value} ${row.unit}`.trim()}>
                        {row.value}{row.unit ? <span className="parameters-unit">{row.unit === "°" ? row.unit : ` ${row.unit}`}</span> : null}
                      </output>
                    </td>
                    <td>
                      <select
                        className="parameters-input"
                        aria-label={t("editor.parameters.dimensionOf", { name: row.name })}
                        aria-invalid={invalid("dimension") || undefined}
                        aria-describedby={invalid("dimension") ? describedBy : undefined}
                        value={row.dimension}
                        disabled={busy}
                        onChange={(event) => void submit(row.name, "dimension", { kind: "update", name: row.name, dimension: event.target.value as ProjectParameterDimension })}
                      >
                        {DIMENSIONS.map((dimension) => <option key={dimension} value={dimension}>{t(`editor.parameters.dimensions.${dimension}`)}</option>)}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="parameters-delete"
                        aria-label={t("editor.parameters.deleteOf", { name: row.name })}
                        title={t("editor.parameters.deleteOf", { name: row.name })}
                        aria-expanded={warning ? true : undefined}
                        disabled={busy}
                        onClick={() => requestDelete(row.name)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>,
                  message ? (
                    <tr key={`error-${index}`} className="parameters-row-note">
                      <td colSpan={5}>
                        <p id={errorId(index)} className="parameters-error" role={editError ? "alert" : undefined}>{text(message)}</p>
                      </td>
                    </tr>
                  ) : null,
                  warning ? (
                    <tr key={`warning-${index}`} className="parameters-row-note">
                      <td colSpan={5}>
                        <DeleteWarning
                          name={row.name}
                          warning={warning}
                          busy={busy}
                          onCancel={() => setPendingDelete(null)}
                          onRelease={() => {
                            setPendingDelete(null);
                            void submit(row.name, "name", { kind: "delete", name: row.name, releaseShapes: true });
                          }}
                        />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        )}
        <form
          className="parameters-add"
          aria-label={t("editor.parameters.addHeading")}
          onSubmit={(event) => {
            event.preventDefault();
            void addParameter();
          }}
        >
          <strong>{t("editor.parameters.addHeading")}</strong>
          <div className="parameters-add-fields">
            <input
              data-dialog-initial-focus
              className="parameters-input"
              aria-label={t("editor.parameters.newName")}
              placeholder={t("editor.parameters.name")}
              aria-invalid={addError ? true : undefined}
              aria-describedby={addError ? `${idPrefix}-add-error` : undefined}
              value={newName}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setNewName(event.target.value)}
            />
            <input
              className="parameters-input"
              aria-label={t("editor.parameters.newExpression")}
              placeholder={t("editor.parameters.expression")}
              aria-invalid={addError ? true : undefined}
              aria-describedby={addError ? `${idPrefix}-add-error` : undefined}
              value={newExpression}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setNewExpression(event.target.value)}
            />
            <select
              className="parameters-input"
              aria-label={t("editor.parameters.newDimension")}
              value={newDimension}
              onChange={(event) => setNewDimension(event.target.value as ProjectParameterDimension)}
            >
              {DIMENSIONS.map((dimension) => <option key={dimension} value={dimension}>{t(`editor.parameters.dimensions.${dimension}`)}</option>)}
            </select>
            <button type="submit" className="parameters-add-button" disabled={busy || !newName.trim() || !newExpression.trim()}>
              <Plus size={15} aria-hidden="true" />
              <span>{t("editor.parameters.add")}</span>
            </button>
          </div>
          {addError ? <p id={`${idPrefix}-add-error`} className="parameters-error" role="alert">{text(addError)}</p> : null}
        </form>
        {busy ? <p className="parameters-panel-status" role="status">{t("editor.parameters.updating")}</p> : null}
      </div>
    </div>
  );
}

function DeleteWarning({
  name,
  warning,
  busy,
  onCancel,
  onRelease,
}: {
  name: string;
  warning: ParameterDeleteWarning;
  busy: boolean;
  onCancel: () => void;
  onRelease: () => void;
}) {
  const t = useTranslations();
  const blocked = warning.parameters.length > 0;
  return (
    <div className="parameters-delete-warning" role="alert">
      <strong>{t("editor.parameters.inUse", { name })}</strong>
      {warning.parameters.length ? <p>{t("editor.parameters.usedByParameters", { names: warning.parameters.join(", ") })}</p> : null}
      {warning.shapes.length ? (
        <>
          <p>{t("editor.parameters.usedByShapes")}</p>
          <ul>
            {warning.shapes.map((shape) => (
              <li key={shape.shapeId}>{t("editor.parameters.shapeFields", { shape: shape.name, fields: shape.fields.join(", ") })}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p>{t(blocked ? "editor.parameters.deleteBlocked" : "editor.parameters.releaseHint", { name })}</p>
      <div className="parameters-delete-actions">
        <button type="button" onClick={onCancel}>{t("editor.parameters.cancel")}</button>
        {blocked ? null : (
          <button type="button" className="parameters-delete-confirm" disabled={busy} onClick={onRelease}>
            {t("editor.parameters.releaseAndDelete")}
          </button>
        )}
      </div>
    </div>
  );
}
