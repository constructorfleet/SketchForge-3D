import { describe, expect, it } from "vitest";
import { createProjectWriteGuard } from "@/lib/projectWriteGuard";

// Issue #622: a project whose stored package fails to load must not be overwritten.
describe("project write guard", () => {
  it("keeps no stand-in copy and refuses writes when a project with nothing in session fails to load", () => {
    const guard = createProjectWriteGuard();
    expect(guard.loadFailed("broken", undefined)).toBeUndefined();
    expect(guard.canWrite("broken")).toBe(false);
    expect(guard.canWrite("other")).toBe(true);
  });

  it("keeps a copy already read this session and still lets it save", () => {
    const guard = createProjectWriteGuard();
    const inSession = { revision: 4, shapes: ["box"] };
    expect(guard.loadFailed("loaded", inSession)).toBe(inSession);
    expect(guard.canWrite("loaded")).toBe(true);
  });

  it("allows writes again once released", () => {
    const guard = createProjectWriteGuard();
    guard.loadFailed("broken", undefined);
    expect(guard.canWrite("broken")).toBe(false);
    guard.release("broken");
    expect(guard.canWrite("broken")).toBe(true);
  });
});
