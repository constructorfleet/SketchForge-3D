export const EDITOR_SHORTCUTS = {
  lockSelection: { key: "l", shiftKey: true },
  hideSelection: { key: "h", shiftKey: true },
  showHidden: { key: "h", shiftKey: true, altKey: true },
  shortcutHelp: { key: "?" },
} as const;

/** OS and browser combinations that must never be claimed by editor shortcuts. */
export const RESERVED_EDITOR_SHORTCUTS = [
  { key: "h", metaKey: true }, // macOS Hide Application
  { key: "l", metaKey: true }, // browser location bar / macOS services
  { key: "l", ctrlKey: true }, // browser location bar
] as const;

export type EditorShortcutEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">;

export function matchesEditorShortcut(event: EditorShortcutEvent, shortcut: { key: string; shiftKey?: boolean; altKey?: boolean }): boolean {
  return event.key.toLowerCase() === shortcut.key.toLowerCase()
    && (shortcut.shiftKey === undefined || Boolean(event.shiftKey) === shortcut.shiftKey)
    && (shortcut.altKey === undefined || Boolean(event.altKey) === shortcut.altKey)
    && !event.metaKey
    && !event.ctrlKey;
}
