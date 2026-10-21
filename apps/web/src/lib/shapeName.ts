/** Return a changed, trimmed shape name, or null when the edit should be ignored. */
export function normalizeRenamedShapeName(currentName: string, proposedName: string): string | null {
  const normalized = proposedName.trim();
  return normalized && normalized !== currentName ? normalized : null;
}
