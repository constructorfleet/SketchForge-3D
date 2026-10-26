import { describe, expect, it, vi } from "vitest";
import { handleUpdateAvailable } from "../../apps/desktop/updateNotifications.cjs";

describe("desktop update notifications", () => {
  it("notifies when a background check finds an update", () => {
    const showNotice = vi.fn();
    const clearManualCheck = vi.fn();

    handleUpdateAvailable(
      { version: "1.2.3" },
      { manualUpdateCheck: false, clearManualCheck, showNotice },
    );

    expect(showNotice).toHaveBeenCalledWith({ version: "1.2.3" });
    expect(clearManualCheck).not.toHaveBeenCalled();
  });

  it("clears the manual-check flag before notifying", () => {
    const calls: string[] = [];

    handleUpdateAvailable(
      { version: "1.2.3" },
      {
        manualUpdateCheck: true,
        clearManualCheck: () => calls.push("clear"),
        showNotice: () => calls.push("notify"),
      },
    );

    expect(calls).toEqual(["clear", "notify"]);
  });
});
