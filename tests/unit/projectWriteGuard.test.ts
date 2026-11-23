import { describe, expect, it, vi } from "vitest";
import {
  StoredProjectUnreadableError,
  cacheWithEditorChange,
  createProjectWriteGuard,
  guardProjectWrites,
  projectLoadFailureCause,
  projectLoadFailureKind,
} from "@/lib/projectWriteGuard";

// Issue #622: a project whose stored package fails to load must not be overwritten.
describe("project write guard", () => {
  it("refuses writes to a blocked project until it is released", () => {
    const guard = createProjectWriteGuard();
    guard.block("broken");
    expect(guard.canWrite("broken")).toBe(false);
    expect(guard.canWrite("other")).toBe(true);
    guard.release("broken");
    expect(guard.canWrite("broken")).toBe(true);
  });

  it("refuses a guarded write to a blocked project without calling the write", async () => {
    const guard = createProjectWriteGuard();
    const write = vi.fn(async (_projectId: string, bytes: number) => bytes);
    const save = guardProjectWrites(guard, write, () => new Error("refused"));
    guard.block("broken");
    await expect(save("broken", 1)).rejects.toThrow("refused");
    expect(write).not.toHaveBeenCalled();
    await expect(save("other", 2)).resolves.toBe(2);
    guard.release("broken");
    await expect(save("broken", 3)).resolves.toBe(3);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("does not let a late editor snapshot put a blocked project back in the cache", () => {
    const guard = createProjectWriteGuard();
    const current = { other: { revision: 1 } };
    guard.block("broken");
    expect(cacheWithEditorChange(current, "broken", { revision: 9 }, guard)).toBe(current);
    expect(cacheWithEditorChange(current, "fine", { revision: 9 }, guard)).toEqual({ other: { revision: 1 }, fine: { revision: 9 } });
  });

  it("keeps a newer cached entry over an older editor snapshot", () => {
    const guard = createProjectWriteGuard();
    const current = { project: { revision: 5 } };
    expect(cacheWithEditorChange(current, "project", { revision: 4 }, guard)).toBe(current);
  });
});

describe("project load failure kind", () => {
  it("calls a failure inside the stored copy unreadable and anything else unavailable", () => {
    const parse = new Error("unknown shape kind");
    expect(projectLoadFailureKind(new StoredProjectUnreadableError(parse))).toBe("unreadable");
    expect(projectLoadFailureKind(new TypeError("Failed to fetch"))).toBe("unavailable");
    expect(projectLoadFailureKind(new Error("Could not load projects from the server"))).toBe("unavailable");
  });

  it("shows the parse error itself, not the marker", () => {
    const parse = new Error("unknown shape kind");
    expect(projectLoadFailureCause(new StoredProjectUnreadableError(parse))).toBe(parse);
    const network = new TypeError("Failed to fetch");
    expect(projectLoadFailureCause(network)).toBe(network);
  });
});
