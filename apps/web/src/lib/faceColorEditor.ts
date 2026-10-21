/** Return the positional CAD face color map after an inspector edit. */
export function updateFaceColor(
  current: Record<number, string> | undefined,
  index: number,
  color: string | null,
): Record<number, string> {
  if (!Number.isInteger(index) || index < 0) return current ?? {};
  const next = { ...(current ?? {}) };
  if (color === null) delete next[index];
  else next[index] = color;
  return next;
}
