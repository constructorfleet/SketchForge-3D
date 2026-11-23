import { describe, expect, it } from "vitest";
import {
  PROJECT_TOMBSTONES_STORAGE_KEY,
  PROJECT_TOMBSTONE_LIMIT,
  addProjectTombstone,
  readProjectTombstones,
  removeProjectTombstones,
  withoutDeletedProjects,
} from "@/lib/projectTombstones";

// Issue #670: every tab of this browser shares the projects deleted here.
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    raw: () => values.get(PROJECT_TOMBSTONES_STORAGE_KEY),
  };
}

describe("project tombstones", () => {
  it("records a deleted project for every tab and filters it out of a list", () => {
    const storage = memoryStorage();
    addProjectTombstone(storage, "p1");
    expect([...readProjectTombstones(storage)]).toEqual(["p1"]);
    expect(withoutDeletedProjects([{ id: "p1" }, { id: "p2" }], readProjectTombstones(storage))).toEqual([{ id: "p2" }]);
  });

  it("lifts a tombstone when the project genuinely returns", () => {
    const storage = memoryStorage();
    addProjectTombstone(storage, "p1");
    addProjectTombstone(storage, "p2");
    removeProjectTombstones(storage, ["p1"]);
    expect([...readProjectTombstones(storage)]).toEqual(["p2"]);
  });

  it("keeps only the newest tombstones", () => {
    const storage = memoryStorage();
    for (let index = 0; index <= PROJECT_TOMBSTONE_LIMIT; index += 1) addProjectTombstone(storage, `p${index}`);
    const kept = readProjectTombstones(storage);
    expect(kept.size).toBe(PROJECT_TOMBSTONE_LIMIT);
    expect(kept.has("p0")).toBe(false);
    expect(kept.has(`p${PROJECT_TOMBSTONE_LIMIT}`)).toBe(true);
  });

  it("reads an unreadable or foreign value as no tombstones", () => {
    expect(readProjectTombstones(memoryStorage({ [PROJECT_TOMBSTONES_STORAGE_KEY]: "{not json" })).size).toBe(0);
    expect(readProjectTombstones(memoryStorage({ [PROJECT_TOMBSTONES_STORAGE_KEY]: JSON.stringify({ id: 1 }) })).size).toBe(0);
    expect(readProjectTombstones(memoryStorage({ [PROJECT_TOMBSTONES_STORAGE_KEY]: JSON.stringify(["p1", 2]) }))).toEqual(new Set(["p1"]));
  });

  it("survives storage that refuses writes", () => {
    const storage = { ...memoryStorage(), setItem: () => { throw new Error("full"); } };
    expect(() => addProjectTombstone(storage, "p1")).not.toThrow();
  });
});
