"use client";

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "@/i18n";
import { applyExpressionCompletion, expressionCompletionAt, type ExpressionCompletion } from "@/lib/expressionFields";
import { formatParameterValue, parameterNameOptions, parameterUnitLabel, type ParameterMessage } from "@/lib/projectParameterEdits";
import type { ProjectParameter } from "@/types/sketchforge";

const MAX_OPTIONS = 8;

/** Resolves to the refusal, or null once the entry is applied. */
export type ExpressionCommit = (text: string) => ParameterMessage | null | Promise<ParameterMessage | null>;

/**
 * Edits a number that can follow a parameter expression. A combobox: parameter names
 * autocomplete at the caret. Shows `value` at rest and `expression` while focused.
 */
export function ExpressionInput({
  value,
  expression,
  parameters,
  label,
  disabled,
  className,
  inputClassName,
  suffix,
  onFocus,
  onBlur,
  onDraftChange,
  onCommit,
}: {
  value: string;
  expression?: string;
  parameters: readonly ProjectParameter[];
  label: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  suffix?: ReactNode;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Reports each keystroke, for callers that act on a draft before it is committed. */
  onDraftChange?: (text: string) => void;
  onCommit: ExpressionCommit;
}) {
  const t = useTranslations();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<ParameterMessage | null>(null);
  const [completion, setCompletion] = useState<ExpressionCompletion | null>(null);
  const [active, setActive] = useState(0);
  // Escape reverts; the blur that follows must not commit.
  const skipCommitRef = useRef(false);
  const startTextRef = useRef("");
  // Focus swaps the value for the expression, which drops the selection; select it again so typing replaces it.
  useLayoutEffect(() => {
    if (editing && document.activeElement === inputRef.current) inputRef.current?.select();
  }, [editing]);
  // Placed in the commit that writes the completed text, before the next keystroke can land.
  const pendingCaretRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    inputRef.current?.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
    pendingCaretRef.current = null;
  });
  const bound = expression !== undefined;
  const options = completion ? parameterNameOptions(parameters, completion.query).slice(0, MAX_OPTIONS) : [];
  // A name typed out in full needs no suggestion.
  const complete = options.length === 1 && options[0]!.name === completion?.query;
  const open = editing && options.length > 0 && !complete;
  const listId = `${id}-options`;
  const errorId = `${id}-error`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const updateCompletion = (text: string, caret: number | null) => {
    setCompletion(caret === null ? null : expressionCompletionAt(text, caret));
    setActive(0);
  };

  const accept = (name: string) => {
    if (!completion) return;
    const next = applyExpressionCompletion(draft, completion, name);
    setDraft(next.text);
    onDraftChange?.(next.text);
    setCompletion(null);
    pendingCaretRef.current = next.caret;
  };

  const commit = async () => {
    setCompletion(null);
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      setEditing(false);
      onBlur?.();
      return;
    }
    const text = draft;
    setEditing(false);
    if (text.trim() === startTextRef.current.trim()) {
      setError(null);
      onBlur?.();
      return;
    }
    // `onCommit` runs before `onBlur`, so a literal edit and its unbind share the focus interaction.
    const pending = onCommit(text);
    onBlur?.();
    const refusal = await pending;
    setError(refusal);
    if (refusal) setDraft(text);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActive((current) => (current + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      return;
    }
    if (open && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      accept(options[active]!.name);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        setCompletion(null);
        return;
      }
      skipCommitRef.current = true;
      setError(null);
      event.currentTarget.blur();
    }
  };

  // A refused entry stays visible so it can be corrected.
  const shown = editing || error ? draft : value;
  const description = bound ? t("editor.expressionField.boundTo", { expression: expression! }) : undefined;
  const text = (message: ParameterMessage) => t(message.key, message.values);

  return (
    <span className={["expression-input", bound ? "is-bound" : "", error ? "is-invalid" : "", editing ? "is-editing" : "", className ?? ""].filter(Boolean).join(" ")}>
      <span className="expression-input-control">
        {bound ? <span className="expression-input-badge" aria-hidden="true">ƒx</span> : null}
        <input
          ref={inputRef}
          className={inputClassName}
          type="text"
          inputMode="text"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? optionId(active) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-description={description}
          title={description}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={shown}
          onFocus={() => {
            onFocus?.();
            const start = error ? draft : expression ?? value;
            startTextRef.current = error ? expression ?? value : start;
            setDraft(start);
            setEditing(true);
          }}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            onDraftChange?.(event.currentTarget.value);
            updateCompletion(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onBlur={() => void commit()}
          onKeyDown={keyDown}
        />
        {suffix}
      </span>
      <ul className="expression-input-options" id={listId} role="listbox" aria-label={t("editor.expressionField.suggestions")} hidden={!open}>
        {open ? options.map((option, index) => (
          <li
            key={option.name}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            className={index === active ? "is-active" : undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              accept(option.name);
            }}
          >
            <span className="expression-input-option-name">{option.name}</span>
            <span className="expression-input-option-value">{`${formatParameterValue(option.value)} ${parameterUnitLabel(option.dimension)}`.trim()}</span>
          </li>
        )) : null}
      </ul>
      {error ? <span className="expression-input-error" id={errorId} role="alert">{text(error)}</span> : null}
    </span>
  );
}
