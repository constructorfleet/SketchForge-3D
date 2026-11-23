import { describe, expect, it, vi } from "vitest";
import {
  StoredProjectMissingError,
  StoredProjectUnreadableError,
  cacheWithEditorChange,
  createProjectWriteGuard,
  guardProjectWrites,
  indexedDbReadIsPermanent,
  mergeNewerServerProjects,
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

  it("calls a database a newer release upgraded storageNewer, since nothing here can read or replace it", () => {
    const version = Object.assign(new Error("The requested version (3) is less than the existing version (99)."), { name: "VersionError" });
    expect(projectLoadFailureKind(new StoredProjectUnreadableError(version))).toBe("storageNewer");
    const data = Object.assign(new Error("bad value"), { name: "DataError" });
    expect(projectLoadFailureKind(new StoredProjectUnreadableError(data))).toBe("unreadable");
  });

  it("shows the parse error itself, not the marker", () => {
    const parse = new Error("unknown shape kind");
    expect(projectLoadFailureCause(new StoredProjectUnreadableError(parse))).toBe(parse);
    const network = new TypeError("Failed to fetch");
    expect(projectLoadFailureCause(network)).toBe(network);
  });
});

describe("IndexedDB read errors", () => {
  const named = (name: string, message = "") => Object.assign(new Error(message), { name });

  it("calls errors a retry cannot fix permanent", () => {
    expect(indexedDbReadIsPermanent(named("VersionError"))).toBe(true);
    expect(indexedDbReadIsPermanent(named("DataError"))).toBe(true);
    expect(indexedDbReadIsPermanent(named("NotReadableError"))).toBe(true);
    expect(indexedDbReadIsPermanent(named("DataCloneError"))).toBe(true);
    expect(indexedDbReadIsPermanent(named("UnknownError", "Failed to read large IndexedDB value"))).toBe(true);
  });

  it("leaves passing failures to a retry", () => {
    expect(indexedDbReadIsPermanent(named("AbortError"))).toBe(false);
    expect(indexedDbReadIsPermanent(named("InvalidStateError"))).toBe(false);
    expect(indexedDbReadIsPermanent(named("TimeoutError"))).toBe(false);
    expect(indexedDbReadIsPermanent(named("UnknownError", "Internal error opening backing store"))).toBe(false);
    expect(indexedDbReadIsPermanent(new TypeError("Failed to fetch"))).toBe(false);
    expect(indexedDbReadIsPermanent(undefined)).toBe(false);
  });
});

// Issue #650: server storage shared by several clients.
describe("missing server package", () => {
  it("calls a project whose metadata exists but whose package does not missing", () => {
    expect(projectLoadFailureKind(new StoredProjectMissingError())).toBe("missing");
  });
});

describe("merging a newer server listing", () => {
  const local = [
    { id: "a", name: "A", revision: 10 },
    { id: "b", name: "B", revision: 20 },
  ];

  it("takes the server's copy of a project only when its revision is newer", () => {
    const merged = mergeNewerServerProjects(local, [
      { id: "a", name: "A renamed", revision: 15 },
      { id: "b", name: "B older", revision: 5 },
    ]);
    expect(merged.projects).toEqual([{ id: "a", name: "A renamed", revision: 15 }, { id: "b", name: "B", revision: 20 }]);
    expect(merged.changedIds).toEqual(["a"]);
  });

  it("adds projects another client created", () => {
    const merged = mergeNewerServerProjects(local, [{ id: "c", name: "C", revision: 1 }]);
    expect(merged.projects.map((project) => project.id)).toEqual(["a", "b", "c"]);
    expect(merged.changedIds).toEqual(["c"]);
  });

  it("returns the same list when nothing is newer", () => {
    const merged = mergeNewerServerProjects(local, [{ id: "a", name: "A", revision: 10 }]);
    expect(merged.projects).toBe(local);
    expect(merged.changedIds).toEqual([]);
  });
});
