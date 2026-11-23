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

function readIds(storage: TombstoneStorage): string[] {
  try {
    const parsed = JSON.parse(storage.getItem(PROJECT_TOMBSTONES_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeIds(storage: TombstoneStorage, ids: string[]) {
  try {
    storage.setItem(PROJECT_TOMBSTONES_STORAGE_KEY, JSON.stringify(ids.slice(-PROJECT_TOMBSTONE_LIMIT)));
  } catch {
    // Full storage: this tab's own delete mark still holds.
  }
}

export function readProjectTombstones(storage: TombstoneStorage): Set<string> {
  return new Set(readIds(storage));
}

export function addProjectTombstone(storage: TombstoneStorage, projectId: string) {
  writeIds(storage, [...readIds(storage).filter((id) => id !== projectId), projectId]);
}

export function removeProjectTombstones(storage: TombstoneStorage, projectIds: Iterable<string>) {
  const lifted = new Set(projectIds);
  const ids = readIds(storage);
  if (ids.some((id) => lifted.has(id))) writeIds(storage, ids.filter((id) => !lifted.has(id)));
}

export function withoutDeletedProjects<T extends { id: string }>(projects: T[], tombstones: ReadonlySet<string>): T[] {
  return tombstones.size ? projects.filter((project) => !tombstones.has(project.id)) : projects;
}
