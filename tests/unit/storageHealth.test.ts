import { describe, expect, it, vi } from "vitest";
import {
  STORAGE_PERSIST_REQUESTED_KEY,
  STORAGE_QUOTA_WARNING_RATIO,
  readStorageStatus,
  requestPersistentStorageOnce,
  storageNearQuota,
  storageUsageFraction,
} from "@/lib/storageHealth";

function memoryPreferences(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("persistent storage request", () => {
  it("asks the browser once per profile and remembers that it asked", async () => {
    const persist = vi.fn(async () => false);
    const storage = { persist, persisted: async () => false };
    const preferences = memoryPreferences();

    expect(await requestPersistentStorageOnce(storage, preferences)).toBe("best-effort");
    expect(await requestPersistentStorageOnce(storage, preferences)).toBe("best-effort");

    expect(persist).toHaveBeenCalledTimes(1);
    expect(preferences.values.get(STORAGE_PERSIST_REQUESTED_KEY)).toBeTruthy();
  });

  it("reports a granted request as persisted", async () => {
    const storage = { persist: async () => true, persisted: async () => false };
    expect(await requestPersistentStorageOnce(storage, memoryPreferences())).toBe("persisted");
  });

  it("does not ask again when the profile is already persisted", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorageOnce({ persist, persisted: async () => true }, memoryPreferences())).toBe("persisted");
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not ask when a previous session already asked", async () => {
    const persist = vi.fn(async () => true);
    const preferences = memoryPreferences({ [STORAGE_PERSIST_REQUESTED_KEY]: "1" });
    expect(await requestPersistentStorageOnce({ persist, persisted: async () => false }, preferences)).toBe("best-effort");
    expect(persist).not.toHaveBeenCalled();
  });

  it("reports browsers without the Storage API as unsupported, and survives a failing request", async () => {
    expect(await requestPersistentStorageOnce(undefined, memoryPreferences())).toBe("unsupported");
    expect(await requestPersistentStorageOnce({}, memoryPreferences())).toBe("unsupported");
    const rejecting = { persist: async () => { throw new Error("denied"); }, persisted: async () => false };
    expect(await requestPersistentStorageOnce(rejecting, memoryPreferences())).toBe("best-effort");
    const blockedPreferences = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(await requestPersistentStorageOnce({ persist: async () => true, persisted: async () => false }, blockedPreferences)).toBe("persisted");
  });
});

describe("storage status", () => {
  it("reads persistence and the usage estimate together", async () => {
    const status = await readStorageStatus({
      persisted: async () => true,
      estimate: async () => ({ usage: 400, quota: 1000 }),
    });
    expect(status).toEqual({ persistence: "persisted", usage: 400, quota: 1000 });
  });

  it("leaves unknown values null instead of guessing", async () => {
    expect(await readStorageStatus(undefined)).toEqual({ persistence: "unsupported", usage: null, quota: null });
    expect(await readStorageStatus({ persisted: async () => false, estimate: async () => { throw new Error("no"); } }))
      .toEqual({ persistence: "best-effort", usage: null, quota: null });
  });
});

describe("quota warning threshold", () => {
  it("warns at 80 percent of the quota and not below it", () => {
    expect(STORAGE_QUOTA_WARNING_RATIO).toBe(0.8);
    expect(storageNearQuota({ usage: 799, quota: 1000 })).toBe(false);
    expect(storageNearQuota({ usage: 800, quota: 1000 })).toBe(true);
    expect(storageNearQuota({ usage: 950, quota: 1000 })).toBe(true);
  });

  it("never warns when usage or quota is unknown or the quota is zero", () => {
    expect(storageNearQuota({ usage: null, quota: 1000 })).toBe(false);
    expect(storageNearQuota({ usage: 900, quota: null })).toBe(false);
    expect(storageNearQuota({ usage: 0, quota: 0 })).toBe(false);
  });

  it("reports the used fraction for display", () => {
    expect(storageUsageFraction({ usage: 250, quota: 1000 })).toBe(0.25);
    expect(storageUsageFraction({ usage: 2000, quota: 1000 })).toBe(1);
    expect(storageUsageFraction({ usage: null, quota: 1000 })).toBeNull();
  });
});
