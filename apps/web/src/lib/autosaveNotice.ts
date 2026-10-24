export type AutosaveNotice = {
  projectId: string;
  projectName: string;
  state: "pending" | "failed";
  message?: string;
};

export function createAutosaveNoticeController(
  onChange: (notice: AutosaveNotice | null) => void,
  delayMs = 5_000,
) {
  const notices = new Map<string, AutosaveNotice>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const publish = () => {
    const visibleNotice = [...notices.values()].find((notice) => notice.state === "failed")
      ?? [...notices.values()].at(-1)
      ?? null;
    onChange(visibleNotice);
  };
  const clearTimer = (projectId: string) => {
    const timer = timers.get(projectId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(projectId);
  };
  return {
    pending: (projectId: string, projectName: string) => {
      clearTimer(projectId);
      timers.set(projectId, setTimeout(() => {
        timers.delete(projectId);
        // A later edit cannot replace an unresolved failure. Keep it visible
        // until the same project's save succeeds.
        if (notices.get(projectId)?.state === "failed") return;
        notices.set(projectId, { projectId, projectName, state: "pending" });
        publish();
      }, delayMs));
    },
    failed: (projectId: string, projectName: string, message: string) => {
      clearTimer(projectId);
      notices.set(projectId, { projectId, projectName, state: "failed", message });
      publish();
    },
    saved: (projectId: string) => {
      clearTimer(projectId);
      if (!notices.delete(projectId)) return;
      publish();
    },
  };
}
