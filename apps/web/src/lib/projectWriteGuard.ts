/**
 * Holds back writes to projects whose stored copy could not be read (#622).
 * An empty stand-in would otherwise autosave over the bytes a repair needs.
 */
export type ProjectWriteGuard = {
  /** Returns the in-session copy to keep; `undefined` marks the project unreadable. */
  loadFailed<T>(projectId: string, inSession: T | undefined): T | undefined;
  /** Allows writes again, after a good read or a confirmed replacement. */
  release(projectId: string): void;
  canWrite(projectId: string): boolean;
};

export function createProjectWriteGuard(): ProjectWriteGuard {
  const unreadable = new Set<string>();
  return {
    loadFailed: (projectId, inSession) => {
      if (inSession === undefined) unreadable.add(projectId);
      return inSession;
    },
    release: (projectId) => {
      unreadable.delete(projectId);
    },
    canWrite: (projectId) => !unreadable.has(projectId),
  };
}
