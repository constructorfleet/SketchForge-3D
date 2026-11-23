/**
 * Projects deleted in this browser, shared by all its tabs (#670).
 *
 * A tab that has not caught up with a delete can write its older project list
 * back. Every list read from this browser is filtered against these ids, so the
 * deleted project does not return. Only a server listing lifts a tombstone.
 */
export const PROJECT_TOMBSTONES_STORAGE_KEY = "sketchForge.projects.deleted";

/** Project ids are random, so old tombstones only need to outlast a stale tab. */
export const PROJECT_TOMBSTONE_LIMIT = 500;

type TombstoneStorage = Pick<Storage, "getItem" | "setItem">;
type Tombstone = { id: string; at: number };

function readEntries(storage: TombstoneStorage): Tombstone[] {
  try {
    const parsed = JSON.parse(storage.getItem(PROJECT_TOMBSTONES_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): Tombstone[] => {
      // Bare ids predate timestamps; any later listing may lift them.
      if (typeof entry === "string") return [{ id: entry, at: 0 }];
      if (!entry || typeof entry !== "object") return [];
      const { id, at } = entry as { id?: unknown; at?: unknown };
      return typeof id === "string" ? [{ id, at: typeof at === "number" && Number.isFinite(at) ? at : 0 }] : [];
    });
  } catch {
    return [];
  }
}

function writeEntries(storage: TombstoneStorage, entries: Tombstone[]) {
  try {
    storage.setItem(PROJECT_TOMBSTONES_STORAGE_KEY, JSON.stringify(entries.slice(-PROJECT_TOMBSTONE_LIMIT)));
  } catch {
    // Full storage: this tab's own delete mark still holds.
  }
}

export function readProjectTombstones(storage: TombstoneStorage): Set<string> {
  return new Set(readEntries(storage).map((entry) => entry.id));
}

export function addProjectTombstone(storage: TombstoneStorage, projectId: string, at = Date.now()) {
  writeEntries(storage, [...readEntries(storage).filter((entry) => entry.id !== projectId), { id: projectId, at }]);
}

/**
 * Lifts tombstones for projects a server listing holds again. Only a listing
 * requested after the delete counts: one fetched while the delete was in flight still lists it.
 */
export function removeProjectTombstones(storage: TombstoneStorage, projectIds: Iterable<string>, listingRequestedAt: number) {
  const listed = new Set(projectIds);
  const entries = readEntries(storage);
  const kept = entries.filter((entry) => !listed.has(entry.id) || entry.at >= listingRequestedAt);
  if (kept.length !== entries.length) writeEntries(storage, kept);
}

export function withoutDeletedProjects<T extends { id: string }>(projects: T[], tombstones: ReadonlySet<string>): T[] {
  return tombstones.size ? projects.filter((project) => !tombstones.has(project.id)) : projects;
}
