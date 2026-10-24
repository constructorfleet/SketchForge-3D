/**
 * Decides when the editor's window-level keyboard shortcuts must stand aside.
 *
 * The types are structural so the guard can be exercised without a DOM: an
 * `HTMLElement` and a `Document` both satisfy them.
 */
export type ShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

export type ShortcutDocument = {
  querySelector(selector: string): unknown;
};

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as ShortcutTarget;
  return element.isContentEditable === true || (typeof element.tagName === "string" && TYPING_TAGS.has(element.tagName.toUpperCase()));
}

/**
 * Anything that makes the editor underneath unreachable: an open modal dialog
 * (`aria-modal="true"`, unless it is `hidden`) or a subtree made `inert`
 * behind one. Focus can sit on a plain button inside a modal, so the typing
 * check alone does not keep a Backspace there from deleting the selection.
 */
export const MODAL_BLOCKING_SELECTOR = '[aria-modal="true"]:not([hidden]), [inert]';

export function isModalBlocking(doc: ShortcutDocument | undefined): boolean {
  return Boolean(doc?.querySelector(MODAL_BLOCKING_SELECTOR));
}

/**
 * True when a window-level editor shortcut must not act on this keydown:
 * the key is being typed into a field, or a modal owns the keyboard.
 */
export function shouldIgnoreGlobalShortcut(
  event: { target: unknown },
  doc: ShortcutDocument | undefined = typeof document === "undefined" ? undefined : document,
): boolean {
  return isTypingTarget(event.target) || isModalBlocking(doc);
}
