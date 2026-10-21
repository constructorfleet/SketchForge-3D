/** Return the CAD face color map after an inspector edit, keyed by ID when available. */
export function updateFaceColor(
  current: Record<string, string> | undefined,
  face: number | string,
  color: string | null,
): Record<string, string> {
  if (typeof face === "number" && (!Number.isInteger(face) || face < 0)) return current ?? {};
  if (typeof face === "string" && !face) return current ?? {};
  const key = String(face);
  const next = { ...(current ?? {}) };
  if (color === null) delete next[key];
  else next[key] = color;
  return next;
}
