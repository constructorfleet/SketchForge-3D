import { describe, expect, it } from "vitest";
import {
  SERVER_SYNCED_REVISIONS_STORAGE_KEY,
  readServerSyncedRevisions,
  writeServerSyncedRevisions,
} from "@/lib/projectSync/syncedRevisions";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[SERVER_SYNCED_REVISIONS_STORAGE_KEY, initial]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

// Issue #672: a missing or bad revision must keep the browser copy, never drop it.
describe("server synced revisions", () => {
  it("reads the revisions written for restored projects", () => {
    const storage = memoryStorage();
    writeServerSyncedRevisions(storage, [{ id: "project-1", revision: 10 }, { id: "project-2" }]);
    expect(readServerSyncedRevisions(storage)).toEqual({ "project-1": 10 });
  });

  it("ignores values that are not finite numbers", () => {
    const storage = memoryStorage(JSON.stringify({ a: 5, b: "7", c: null, d: { revision: 3 }, e: Number.MAX_VALUE * 0 }));
    const revisions = readServerSyncedRevisions(storage);
    expect(revisions).toEqual({ a: 5, e: 0 });
    expect(revisions.b).toBeUndefined();
  });

  it("reads nothing from a missing, unparsable or non-object record", () => {
    for (const raw of [undefined, "not json", "[1,2]", "42", "null"]) {
      expect(readServerSyncedRevisions(memoryStorage(raw)), String(raw)).toEqual({});
    }
  });

  it("does not read inherited names as synced revisions", () => {
    expect(readServerSyncedRevisions(memoryStorage("{}")).constructor).toBeUndefined();
  });
});
