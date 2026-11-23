/** Merges metadata three ways: fields this client changed since `synced` win, the rest come from `server`. */
export function mergeMetadataFields(
  synced: Record<string, unknown> | undefined,
  local: Record<string, unknown>,
  server: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...server };
  for (const [key, value] of Object.entries(local)) {
    const changedHere = !synced || JSON.stringify(synced[key]) !== JSON.stringify(value);
    if (changedHere || !(key in server)) merged[key] = value;
  }
  return merged;
}
