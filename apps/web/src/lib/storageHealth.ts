/**
 * Browser storage durability (issue #333).
 *
 * Projects kept in IndexedDB are "best-effort" storage by default: the browser
 * may evict them under storage pressure. `navigator.storage.persist()` asks it
 * not to. Some browsers prompt the person, so the request is made once per
 * profile and remembered, not on every load.
 */

/** localStorage key that records the persistence request was already made in this profile. */
export const STORAGE_PERSIST_REQUESTED_KEY = "sketchForge.storagePersistRequested";

/** The dashboard warns once usage reaches this fraction of the browser's quota. */
export const STORAGE_QUOTA_WARNING_RATIO = 0.8;

export type StoragePersistence = "persisted" | "best-effort" | "unsupported";

export type StorageUsage = { usage: number | null; quota: number | null };

export type StorageStatus = StorageUsage & { persistence: StoragePersistence };

/** The parts of `StorageManager` this module uses; every member is optional because support varies. */
export type StorageManagerLike = {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
};

export type PreferenceStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

async function isPersisted(storage: StorageManagerLike) {
  try {
    return (await storage.persisted?.()) === true;
  } catch {
    return false;
  }
}

function readPreference(preferences: PreferenceStore | null | undefined, key: string) {
  try {
    return preferences?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writePreference(preferences: PreferenceStore | null | undefined, key: string, value: string) {
  try {
    preferences?.setItem(key, value);
  } catch {
    // Blocked site data: the request is simply made again next session.
  }
}

/**
 * Requests persistent storage unless the profile is already persisted or the
 * request was made before. Returns the persistence state afterwards.
 */
export async function requestPersistentStorageOnce(
  storage: StorageManagerLike | null | undefined,
  preferences: PreferenceStore | null | undefined,
): Promise<StoragePersistence> {
  if (!storage?.persist) return "unsupported";
  if (await isPersisted(storage)) return "persisted";
  if (readPreference(preferences, STORAGE_PERSIST_REQUESTED_KEY)) return "best-effort";
  writePreference(preferences, STORAGE_PERSIST_REQUESTED_KEY, String(Date.now()));
  try {
    return (await storage.persist()) ? "persisted" : "best-effort";
  } catch {
    return "best-effort";
  }
}

/** Reads persistence and the usage estimate. Values the browser does not report stay null. */
export async function readStorageStatus(storage: StorageManagerLike | null | undefined): Promise<StorageStatus> {
  if (!storage) return { persistence: "unsupported", usage: null, quota: null };
  const persistence: StoragePersistence = storage.persisted ? ((await isPersisted(storage)) ? "persisted" : "best-effort") : "unsupported";
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const estimate = await storage.estimate?.();
    usage = Number.isFinite(estimate?.usage) ? (estimate?.usage ?? null) : null;
    quota = Number.isFinite(estimate?.quota) ? (estimate?.quota ?? null) : null;
  } catch {
    // An estimate is advisory; leave it unknown.
  }
  return { persistence, usage, quota };
}

/** Used share of the quota in [0, 1], or null when either number is unknown. */
export function storageUsageFraction({ usage, quota }: StorageUsage): number | null {
  if (usage === null || quota === null || !(quota > 0) || !(usage >= 0)) return null;
  return Math.min(1, usage / quota);
}

/** True once usage reaches the warning threshold of a known, non-zero quota. */
export function storageNearQuota(status: StorageUsage, threshold = STORAGE_QUOTA_WARNING_RATIO): boolean {
  const fraction = storageUsageFraction(status);
  return fraction !== null && fraction >= threshold;
}

/** The browser's StorageManager, when the page runs where one exists. */
export function browserStorageManager(): StorageManagerLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.storage ?? undefined;
}
