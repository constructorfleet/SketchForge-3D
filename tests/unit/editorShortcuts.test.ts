import { describe, expect, it } from "vitest";
import { EDITOR_SHORTCUTS, RESERVED_EDITOR_SHORTCUTS, matchesEditorShortcut } from "@/lib/editorShortcuts";

describe("editor shortcuts", () => {
  it("uses bindings that avoid OS and browser reserved keys", () => {
    for (const shortcut of Object.values(EDITOR_SHORTCUTS)) {
      for (const reserved of RESERVED_EDITOR_SHORTCUTS) {
        expect(matchesEditorShortcut({ key: shortcut.key, shiftKey: "shiftKey" in shortcut ? shortcut.shiftKey : false, altKey: "altKey" in shortcut ? shortcut.altKey : false, metaKey: "metaKey" in reserved ? reserved.metaKey : false, ctrlKey: "ctrlKey" in reserved ? reserved.ctrlKey : false }, shortcut)).toBe(false);
      }
    }
  });

  it("matches the shifted selection bindings without modifiers", () => {
    expect(matchesEditorShortcut({ key: "L", shiftKey: true, altKey: false, metaKey: false, ctrlKey: false }, EDITOR_SHORTCUTS.lockSelection)).toBe(true);
    expect(matchesEditorShortcut({ key: "h", shiftKey: true, altKey: false, metaKey: false, ctrlKey: false }, EDITOR_SHORTCUTS.hideSelection)).toBe(true);
    expect(matchesEditorShortcut({ key: "h", shiftKey: true, altKey: true, metaKey: false, ctrlKey: false }, EDITOR_SHORTCUTS.showHidden)).toBe(true);
    expect(matchesEditorShortcut({ key: "l", shiftKey: true, altKey: false, metaKey: true, ctrlKey: false }, EDITOR_SHORTCUTS.lockSelection)).toBe(false);
  });
});
