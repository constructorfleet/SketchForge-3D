import { describe, expect, it } from "vitest";
import { createProjectWriteGuard } from "@/lib/projectWriteGuard";

// Issue #622: a project whose stored package fails to load must not be overwritten.
describe("project write guard", () => {
  it("keeps no stand-in copy and refuses writes when a project with nothing in session fails to load", () => {
    const guard = createProjectWriteGuard();
    expect(guard.loadFailed("broken", undefined, 5)).toBeUndefined();
    expect(guard.canWrite("broken")).toBe(false);
    expect(guard.canWrite("other")).toBe(true);
  });

  it("keeps a session copy at least as new as the stored one and still lets it save", () => {
    const guard = createProjectWriteGuard();
    const inSession = { revision: 4, shapes: ["box"] };
    expect(guard.loadFailed("loaded", inSession, 4)).toBe(inSession);
    expect(guard.canWrite("loaded")).toBe(true);
  });

  it("drops a session copy older than the unreadable stored one, so it cannot overwrite a newer package", () => {
    const guard = createProjectWriteGuard();
    expect(guard.loadFailed("newer-elsewhere", { revision: 100 }, 200)).toBeUndefined();
    expect(guard.canWrite("newer-elsewhere")).toBe(false);
  });

  it("allows writes again once released", () => {
    const guard = createProjectWriteGuard();
    guard.loadFailed("broken", undefined, 1);
    expect(guard.canWrite("broken")).toBe(false);
    guard.release("broken");
    expect(guard.canWrite("broken")).toBe(true);
  });
});
