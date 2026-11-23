/**
 * Holds back writes to projects whose stored copy could not be read (#622).
 * An empty or stale stand-in would otherwise autosave over the bytes a repair needs.
 */
export type ProjectWriteGuard = {
  /**
   * Returns the in-session copy if it is at least as new as the unreadable stored one.
   * Otherwise returns `undefined` and refuses writes to the project.
   */
  loadFailed<T extends { revision: number }>(projectId: string, inSession: T | undefined, storedRevision: number): T | undefined;
  /** Allows writes again, after a good read or a confirmed replacement. */
  release(projectId: string): void;
  canWrite(projectId: string): boolean;
};

export function createProjectWriteGuard(): ProjectWriteGuard {
  const unreadable = new Set<string>();
  return {
    loadFailed: (projectId, inSession, storedRevision) => {
      if (inSession && inSession.revision >= storedRevision) return inSession;
      unreadable.add(projectId);
      return undefined;
    },
    release: (projectId) => {
      unreadable.delete(projectId);
    },
    canWrite: (projectId) => !unreadable.has(projectId),
  };
}
