import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutosaveNoticeController } from "@/lib/autosaveNotice";

describe("createAutosaveNoticeController", () => {
  afterEach(() => vi.useRealTimers());

  it("surfaces a save that remains pending after a bounded delay", () => {
    vi.useFakeTimers();
    const notices: unknown[] = [];
    const controller = createAutosaveNoticeController((notice) => notices.push(notice), 4_000);

    controller.pending("project-1", "Part");
    vi.advanceTimersByTime(3_999);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notices).toEqual([{ projectId: "project-1", projectName: "Part", state: "pending" }]);
  });

  it("keeps an error visible until a later successful save", () => {
    const notices: unknown[] = [];
    const controller = createAutosaveNoticeController((notice) => notices.push(notice));

    controller.failed("project-1", "Part", "quota exceeded");
    controller.saved("project-1");

    expect(notices).toEqual([
      { projectId: "project-1", projectName: "Part", state: "failed", message: "quota exceeded" },
      null,
    ]);
  });

  it("does not clear another project's failure when a save succeeds", () => {
    const notices: unknown[] = [];
    const controller = createAutosaveNoticeController((notice) => notices.push(notice));

    controller.failed("project-1", "Part", "quota exceeded");
    controller.saved("project-2");

    expect(notices).toHaveLength(1);
  });
});
