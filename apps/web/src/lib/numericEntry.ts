/**
 * A value being typed during a gesture, as a number once it is one.
 *
 * "-", "." and "-." are states a value passes through while it is typed, and
 * none of them is a number yet. Treating them as 0 would snap the shape to
 * zero the moment a minus sign is pressed, so they read as "nothing yet" and
 * the gesture keeps following the pointer until a real value exists.
 */
export function typedEntryValue(entry: string | null): number | null {
  if (entry === null || entry === "" || entry === "-" || entry === "." || entry === "-.") return null;
  const parsed = Number(entry);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The next buffer after a character is typed, or null when it is not accepted. */
export function appendTypedCharacter(entry: string | null, key: string): string | null {
  const current = entry ?? "";
  if (key >= "0" && key <= "9") return current + key;
  if (key === "." && !current.includes(".")) return current + ".";
  // A minus only means anything at the front; mid-number it is not a sign.
  if (key === "-" && current === "") return "-";
  return null;
}

/** The buffer after a backspace: null once nothing is left to delete. */
export function backspaceTypedEntry(entry: string | null): string | null {
  if (entry === null || entry.length <= 1) return null;
  return entry.slice(0, -1);
}
