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
  let visibleNotice: AutosaveNotice | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
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
        visibleNotice = { projectId, projectName, state: "pending" };
        onChange(visibleNotice);
      }, delayMs));
    },
    failed: (projectId: string, projectName: string, message: string) => {
      clearTimer(projectId);
      visibleNotice = { projectId, projectName, state: "failed", message };
      onChange(visibleNotice);
    },
    saved: (projectId: string) => {
      clearTimer(projectId);
      if (visibleNotice?.projectId !== projectId) return;
      visibleNotice = null;
      onChange(null);
    },
  };
}
