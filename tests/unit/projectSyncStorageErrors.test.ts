import { describe, expect, it } from "vitest";
import {
  StoredProjectMissingError,
  StoredProjectUnreadableError,
  cacheWithEditorChange,
  indexedDbReadIsPermanent,
  mergeNewerServerProjects,
  projectLoadFailureCause,
  projectLoadFailureKind,
} from "@/lib/projectSync/storageErrors";

// Issue #622: a late editor snapshot must not put a refused project back in the cache.
describe("applying an editor snapshot to the cache", () => {
  const refusing = (...ids: string[]) => ({ canWrite: (projectId: string) => !ids.includes(projectId) });

  it("leaves the cache alone for a project whose writes are refused", () => {
    const current = { other: { revision: 1 } };
    expect(cacheWithEditorChange(current, "broken", { revision: 9 }, refusing("broken"))).toBe(current);
    expect(cacheWithEditorChange(current, "fine", { revision: 9 }, refusing("broken"))).toEqual({ other: { revision: 1 }, fine: { revision: 9 } });
  });

  it("keeps a newer cached entry over an older editor snapshot", () => {
    const current = { project: { revision: 5 } };
    expect(cacheWithEditorChange(current, "project", { revision: 4 }, refusing())).toBe(current);
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

  it("takes a project the caller calls newer even at the same revision, such as one renamed elsewhere", () => {
    const merged = mergeNewerServerProjects(local, [{ id: "a", name: "A renamed", revision: 10 }], (_mine, theirs) => theirs.name === "A renamed");
    expect(merged.projects[0]).toEqual({ id: "a", name: "A renamed", revision: 10 });
    expect(merged.changedIds).toEqual(["a"]);
  });

  it("returns the same list when nothing is newer", () => {
    const merged = mergeNewerServerProjects(local, [{ id: "a", name: "A", revision: 10 }]);
    expect(merged.projects).toBe(local);
    expect(merged.changedIds).toEqual([]);
  });
});
