/**
 * Just the parts of a button this helper reads and writes.
 *
 * Declared structurally rather than picked off HTMLButtonElement: a real button
 * satisfies it, and a test can supply a plain object without pulling in a DOM.
 */
export type TooltipButton = {
  title: string;
  textContent: string | null;
  getAttribute: (name: string) => string | null;
};

export function buttonTooltipFromLabel(button: TooltipButton): string | null {
  const label = button.getAttribute("aria-label") ?? button.textContent?.trim();
  return label ? label.replace(/\s+/g, " ") : null;
}

export function createButtonTooltipSync() {
  const written = new WeakMap<TooltipButton, string>();

  return function syncButtonTooltips(buttons: Iterable<TooltipButton>) {
    for (const button of buttons) {
      const current = button.title;
      // A title authored in the markup wins: only tooltips this helper wrote are refreshed.
      if (current && written.get(button) !== current) continue;
      const next = buttonTooltipFromLabel(button);
      if (!next || next === current) continue;
      button.title = next;
      written.set(button, next);
    }
  };
}
