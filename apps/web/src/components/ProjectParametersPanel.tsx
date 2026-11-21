"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useTranslations } from "@/i18n";
import {
  parameterDeleteWarning,
  configurationIssueMessages,
  parameterRows,
  parameterStateKey,
  type ParameterDeleteWarning,
  type ParameterEdit,
  type ParameterMessage,
} from "@/lib/projectParameterEdits";
import type { ProjectConfiguration, ProjectParameter, ProjectParameterDimension, WorkplaneShape } from "@/types/sketchforge";

const DIMENSIONS: readonly ProjectParameterDimension[] = ["length", "angle", "unitless"];

type Field = "name" | "expression" | "dimension" | "override";
type DraftField = "name" | "expression" | "override";
type ConfigurationState = { configurations: readonly ProjectConfiguration[]; activeConfiguration: string | null };
const NO_CONFIGURATION: ConfigurationState = { configurations: [], activeConfiguration: null };
type RowError = { field: Field; message: ParameterMessage };

/** Resolves to the refusal, or null once the edit is committed. */
export type ParameterEditHandler = (edit: ParameterEdit) => Promise<ParameterMessage | null>;

export function ProjectParametersPanel({
  parameters,
  configuration = NO_CONFIGURATION,
  shapes,
  busy,
  onEdit,
  onClose,
}: {
  parameters: readonly ProjectParameter[];
  /** Configurations (#618): the picker, the override column and the delete warning read them. */
  configuration?: ConfigurationState;
  shapes: readonly WorkplaneShape[];
  busy: boolean;
  onEdit: ParameterEditHandler;
  onClose: () => void;
}) {
  const t = useTranslations();
  const dialogRef = useDialogFocus<HTMLDivElement>({ onEscape: onClose });
  const idPrefix = useId();
  const { configurations, activeConfiguration } = configuration;
  // Which configuration the override column edits; apart from which is active (#618).
  const [editingChoice, setEditingChoice] = useState<string | null>(activeConfiguration);
  const editing = editingChoice !== null && configurations.some((entry) => entry.name === editingChoice) ? editingChoice : null;
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<DraftField, string>>>>({});
  const [errors, setErrors] = useState<Record<string, RowError>>({});
  const [pendingDelete, setPendingDelete] = useState<{ name: string; warning: ParameterDeleteWarning } | null>(null);
  const [newName, setNewName] = useState("");
  const [newExpression, setNewExpression] = useState("");
  const [newDimension, setNewDimension] = useState<ProjectParameterDimension>("length");
  const [addError, setAddError] = useState<ParameterMessage | null>(null);
  // Escape reverts a draft; the blur that follows must not commit it.
  const skipBlurCommitRef = useRef(false);
  const rows = parameterRows(parameters, configurations, editing);
  const columns = editing ? 6 : 5;
  // Undo, redo or a commit replaces the table; drafts and errors about the old one are stale.
  const tableKey = parameterStateKey(parameters, configuration);
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
  const text = (message: ParameterMessage) => {
    const body = t(message.key, message.values);
    return message.configuration ? t("editor.parameters.configurations.inConfiguration", { configuration: message.configuration, message: body }) : body;
  };

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

  const commitDraft = (rowName: string, field: DraftField) => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    const draft = drafts[rowName]?.[field];
    const row = parameters.find((parameter) => parameter.name === rowName);
    if (field === "override") {
      const current = rows.find((entry) => entry.name === rowName)?.override;
      if (draft === undefined || !row || !editing || draft.trim() === (current ?? "")) return;
      // An empty override falls back to the base expression.
      void submit(rowName, "override", draft.trim()
        ? { kind: "setOverride", configuration: editing, name: rowName, expression: draft }
        : { kind: "clearOverride", configuration: editing, name: rowName });
      return;
    }
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
    const warning = parameterDeleteWarning({ parameters: [...parameters], shapes: [...shapes], configurations: [...configurations] }, name);
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
        <ConfigurationPicker
          configuration={configuration}
          parameters={parameters}
          editing={editing}
          stateKey={tableKey}
          busy={busy}
          onEditingChange={setEditingChoice}
          onEdit={onEdit}
          text={text}
        />
        {rows.length === 0 ? <p className="parameters-panel-empty">{t("editor.parameters.empty")}</p> : (
          <table className="parameters-table" aria-label={t("editor.parameters.tableLabel")}>
            <thead>
              <tr>
                <th scope="col">{t("editor.parameters.name")}</th>
                <th scope="col">{t("editor.parameters.expression")}</th>
                {editing ? <th scope="col">{t("editor.parameters.configurations.override", { name: editing })}</th> : null}
                {/* Values are always the active configuration's; say so while another is being edited. */}
                <th scope="col">
                  {editing && editing !== activeConfiguration
                    ? t("editor.parameters.configurations.valueIn", { name: activeConfiguration ?? t("editor.parameters.configurations.base") })
                    : t("editor.parameters.value")}
                </th>
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
                    {editing ? (
                      <td>
                        <input
                          className="parameters-input parameters-expression-input parameters-override-input"
                          aria-label={t("editor.parameters.configurations.overrideOf", { parameter: row.name, name: editing })}
                          aria-invalid={invalid("override") || undefined}
                          aria-describedby={invalid("override") ? describedBy : undefined}
                          placeholder={t("editor.parameters.configurations.overridePlaceholder")}
                          value={draft.override ?? row.override ?? ""}
                          spellCheck={false}
                          autoComplete="off"
                          disabled={busy}
                          onChange={(event) => { const override = event.target.value; setDrafts((current) => ({ ...current, [row.name]: { ...current[row.name], override } })); }}
                          onBlur={() => commitDraft(row.name, "override")}
                          onKeyDown={draftKeys(row.name)}
                        />
                      </td>
                    ) : null}
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
                      <td colSpan={columns}>
                        <p id={errorId(index)} className="parameters-error" role={editError ? "alert" : undefined}>{text(message)}</p>
                      </td>
                    </tr>
                  ) : null,
                  warning ? (
                    <tr key={`warning-${index}`} className="parameters-row-note">
                      <td colSpan={columns}>
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

type PickerField = "editing" | "rename" | "add";

/**
 * Chooses which configuration to edit, apart from which is active, so a configuration
 * whose activation is refused, or one stale since load, can still be fixed (#618).
 */
function ConfigurationPicker({
  configuration,
  parameters,
  editing,
  stateKey,
  busy,
  onEditingChange,
  onEdit,
  text,
}: {
  configuration: ConfigurationState;
  parameters: readonly ProjectParameter[];
  editing: string | null;
  stateKey: string;
  busy: boolean;
  onEditingChange: (name: string | null) => void;
  onEdit: ParameterEditHandler;
  text: (message: ParameterMessage) => string;
}) {
  const t = useTranslations();
  const id = useId();
  const { configurations, activeConfiguration } = configuration;
  const [newName, setNewName] = useState("");
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [error, setError] = useState<{ field: PickerField; message: ParameterMessage } | null>(null);
  // Undo, redo or a commit replaces the state, so a draft or error about the old one is stale.
  const [seenKey, setSeenKey] = useState(stateKey);
  if (seenKey !== stateKey) {
    setSeenKey(stateKey);
    setRenameDraft(null);
    setError(null);
  }
  const issues = configurationIssueMessages({ parameters: [...parameters], shapes: [], configurations, activeConfiguration }, editing);
  const run = async (field: PickerField, edit: ParameterEdit) => {
    const refusal = await onEdit(edit);
    setError(refusal ? { field, message: refusal } : null);
    return !refusal;
  };
  const commitRename = async () => {
    if (renameDraft === null || !editing) return;
    const next = renameDraft.trim();
    if (!next || next === editing) {
      setRenameDraft(null);
      return;
    }
    if (await run("rename", { kind: "renameConfiguration", configuration: editing, newName: next })) {
      setRenameDraft(null);
      onEditingChange(next);
    }
  };
  const errorId = `${id}-configuration-error`;
  const invalid = (field: PickerField) => (error?.field === field ? { "aria-invalid": true, "aria-describedby": errorId } : {});
  return (
    <section className="parameters-configurations" aria-labelledby={`${id}-heading`}>
      <strong id={`${id}-heading`}>{t("editor.parameters.configurations.heading")}</strong>
      <p className="parameters-configuration-status" role="status">
        {activeConfiguration
          ? t("editor.parameters.configurations.activeStatus", { name: activeConfiguration })
          : t("editor.parameters.configurations.activeBase")}
      </p>
      <div className="parameters-configuration-row">
        <label className="parameters-configuration-field">
          <span>{t("editor.parameters.configurations.editing")}</span>
          <select
            className="parameters-input"
            value={editing ?? ""}
            {...invalid("editing")}
            onChange={(event) => {
              // Choosing only selects what to edit; activation is the button below.
              onEditingChange(event.target.value || null);
              setRenameDraft(null);
              setError(null);
            }}
          >
            <option value="">{t("editor.parameters.configurations.base")}</option>
            {configurations.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name === activeConfiguration ? t("editor.parameters.configurations.activeOption", { name: entry.name }) : entry.name}
              </option>
            ))}
          </select>
        </label>
        {editing ? (
          <>
            <label className="parameters-configuration-field">
              <span>{t("editor.parameters.name")}</span>
              <input
                className="parameters-input"
                aria-label={t("editor.parameters.configurations.renameLabel", { name: editing })}
                {...invalid("rename")}
                value={renameDraft ?? editing}
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape" && renameDraft !== null) {
                    event.preventDefault();
                    setRenameDraft(null);
                    setError(null);
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="parameters-activate-button"
              aria-label={t("editor.parameters.configurations.activateLabel", { name: editing })}
              disabled={busy || editing === activeConfiguration}
              onClick={() => void run("editing", { kind: "activateConfiguration", configuration: editing })}
            >
              {t("editor.parameters.configurations.activate")}
            </button>
            <button
              type="button"
              className="parameters-delete"
              aria-label={t("editor.parameters.configurations.delete", { name: editing })}
              title={t("editor.parameters.configurations.delete", { name: editing })}
              disabled={busy}
              onClick={async () => {
                if (await run("editing", { kind: "deleteConfiguration", configuration: editing })) onEditingChange(null);
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </>
        ) : null}
        {activeConfiguration ? (
          <button
            type="button"
            className="parameters-activate-button"
            disabled={busy}
            onClick={() => void run("editing", { kind: "activateConfiguration", configuration: null })}
          >
            {t("editor.parameters.configurations.useBase")}
          </button>
        ) : null}
      </div>
      {issues.length ? (
        <div className="parameters-configuration-issues">
          <p>{t("editor.parameters.configurations.issues", { name: editing ?? "" })}</p>
          <ul>
            {issues.map((issue) => (
              <li key={issue.parameter}>
                <span>{t("editor.parameters.configurations.issueItem", { parameter: issue.parameter, message: text(issue.message) })}</span>
                {/* An override of a parameter that no longer exists has no row to clear it from. */}
                <button
                  type="button"
                  className="parameters-activate-button"
                  disabled={busy || !editing}
                  onClick={() => editing && void run("editing", { kind: "clearOverride", configuration: editing, name: issue.parameter })}
                >
                  {t("editor.parameters.configurations.clearIssue", { parameter: issue.parameter })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        className="parameters-configuration-row"
        onSubmit={async (event) => {
          event.preventDefault();
          const name = newName.trim();
          if (name && await run("add", { kind: "addConfiguration", configuration: name })) {
            setNewName("");
            onEditingChange(name);
          }
        }}
      >
        <input
          className="parameters-input"
          aria-label={t("editor.parameters.configurations.newName")}
          {...invalid("add")}
          placeholder={t("editor.parameters.configurations.newName")}
          value={newName}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setNewName(event.target.value)}
        />
        <button type="submit" className="parameters-add-button" disabled={busy || !newName.trim()}>
          <Plus size={15} aria-hidden="true" />
          <span>{t("editor.parameters.configurations.create")}</span>
        </button>
      </form>
      {error ? <p id={errorId} className="parameters-error" role="alert">{text(error.message)}</p> : null}
      <p className="parameters-panel-intro">{t("editor.parameters.configurations.hint")}</p>
    </section>
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
  const blocked = warning.parameters.length > 0 || warning.configurations.length > 0;
  return (
    <div className="parameters-delete-warning" role="alert">
      <strong>{t("editor.parameters.inUse", { name })}</strong>
      {warning.parameters.length ? <p>{t("editor.parameters.usedByParameters", { names: warning.parameters.join(", ") })}</p> : null}
      {warning.configurations.length ? <p>{t("editor.parameters.usedByConfigurations", { names: warning.configurations.join(", ") })}</p> : null}
      {warning.shapes.length ? (
        <>
          <p>{t("editor.parameters.usedByShapes")}</p>
          <ul>
            {warning.shapes.map((shape) => (
              <li key={shape.shapeId}>{t("editor.parameters.shapeFields", {
                shape: shape.name,
                fields: [...shape.fields, ...shape.constraints.map((id) => t("editor.parameters.constraintLabel", { id }))].join(", "),
              })}</li>
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
