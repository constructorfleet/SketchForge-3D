/**
 * Project id to the revision the server held when this browser fell back to its own storage (#672).
 * A move compares the browser's copies with these, never with another client's clock.
 */
export const SERVER_SYNCED_REVISIONS_STORAGE_KEY = "sketchForge.projects.serverSyncedRevisions";

type RevisionStorage = Pick<Storage, "getItem" | "setItem">;

/** Returns only finite revisions; anything else reads as unsynced, so the browser copy is kept. */
export function readServerSyncedRevisions(storage: Pick<Storage, "getItem">): Record<string, number> {
  const revisions: Record<string, number> = Object.create(null);
  try {
    const parsed = JSON.parse(storage.getItem(SERVER_SYNCED_REVISIONS_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return revisions;
    for (const [id, revision] of Object.entries(parsed)) {
      if (typeof revision === "number" && Number.isFinite(revision)) revisions[id] = revision;
    }
  } catch {
    // Unreadable reads as nothing synced.
  }
  return revisions;
}

export function writeServerSyncedRevisions(storage: RevisionStorage, projects: ReadonlyArray<{ id: string; revision?: number }>) {
  storage.setItem(SERVER_SYNCED_REVISIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(
    projects.flatMap((project) => (typeof project.revision === "number" ? [[project.id, project.revision]] : [])),
  )));
}
