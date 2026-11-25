/**
 * In-memory adapters for the project sync module, for tests.
 *
 * The server applies the engine's own write policy with the dashboard route's options,
 * so refusals match the real route. Not imported by the app: the policy reads files.
 */
import { LocalizedError } from "@/i18n/LocalizedError";
import { importSkfProject } from "@/lib/engine/skfProject";
import { planProjectWrite } from "@/lib/engine/projectWritePolicy";
import { projectSkfPackage } from "@/lib/projectShapeCache";
import {
  ServerMetadataConflictError,
  ServerProjectConflictError,
  ServerProjectDeletedError,
  serverMetadataRevision,
  serverProjectRevision,
  type ServerProjectRecord,
} from "@/lib/serverProjectStore";
import type { BrowserProjectRecord, BrowserProjectStore, KeyValueStore, PreferenceStore, ProjectSyncAdapters, ServerProjectApi } from "./adapters";

/** One browser: an IndexedDB and a `localStorage` its tabs share. */
export function createMemoryBrowser() {
  const records = new Map<string, BrowserProjectRecord>();
  const values = new Map<string, string>();
  const tabs = new Set<(key: string, newValue: string | null) => void>();
  /** Fails every read with this error, to stand in for a broken database. */
  let readError: unknown = null;

  const store: BrowserProjectStore = {
    async read(projectId) {
      if (readError) throw readError;
      const record = records.get(projectId);
      return record ? { ...record } : null;
    },
    async readCopy(projectId) {
      const record = records.get(projectId);
      if (!record) return null;
      return record.skfPackage
        ? { bytes: record.skfPackage, format: "skf" }
        : { bytes: new TextEncoder().encode(JSON.stringify({ record })), format: "json" };
    },
    async write(projectId, revision, skfPackage) {
      const existing = records.get(projectId);
      if (existing && existing.revision > revision) return;
      records.set(projectId, { id: projectId, revision, skfPackage, updatedAt: revision });
    },
    async remove(projectId) {
      records.delete(projectId);
    },
  };

  /** A tab's view of `localStorage`: its own writes raise `storage` events in the other tabs only. */
  function tab(): PreferenceStore {
    const own = new Set<(key: string | null, newValue: string | null) => void>();
    const notify = (key: string, newValue: string | null) => {
      for (const listener of tabs) listener(key, newValue);
    };
    const self = (key: string, newValue: string | null) => {
      // Storage events do not fire in the tab that made the change.
      if (writing) return;
      for (const listener of own) listener(key, newValue);
    };
    let writing = false;
    tabs.add(self);
    const set = (key: string, value: string | null) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
      writing = true;
      try {
        notify(key, value);
      } finally {
        writing = false;
      }
    };
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => set(key, value),
      removeItem: (key) => set(key, null),
      subscribe(listener) {
        own.add(listener);
        return () => own.delete(listener);
      },
    };
  }

  return {
    store,
    tab,
    records,
    storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } satisfies KeyValueStore,
    failReads(error: unknown) {
      readError = error;
    },
  };
}

type StoredServerProject = { metadata: Record<string, unknown> | null; packageBytes: Uint8Array | null; updatedAt: number };

/** One server project directory, refusing writes as the dashboard route does. */
export function createMemoryServer({ now = () => Date.now() }: { now?: () => number } = {}) {
  const projects = new Map<string, StoredServerProject>();
  const tombstones = new Map<string, { deletedAt: number; revision: number; metadataRevision: number }>();
  let enabled = true;
  /** Answers every package read with this error, as an unreachable server would. */
  let fetchError: unknown = null;

  function record(projectId: string, stored: StoredServerProject): ServerProjectRecord | null {
    return stored.metadata
      ? { projectId, updatedAt: stored.updatedAt, packageBytes: stored.packageBytes?.byteLength ?? 0, metadata: stored.metadata }
      : null;
  }

  function writeProject(projectId: string, metadata: Record<string, unknown> | null, packageWrite: { bytes: Uint8Array; revision: number } | null, baseRevision?: number, baseMetadataRevision?: number) {
    const stored = projects.get(projectId) ?? { metadata: null, packageBytes: null, updatedAt: now() };
    const plan = planProjectWrite(
      { metadata: stored.metadata, tombstone: tombstones.get(projectId) ?? null, packageExists: Boolean(stored.packageBytes) },
      {
        metadata,
        package: packageWrite ? { revision: packageWrite.revision } : null,
        refuseDeleted: true,
        refuseOlderClock: true,
        baseRevision,
        baseMetadataRevision,
        revisionRule: { kind: "package" },
      },
    );
    if (!plan.accepted) {
      const { refusal } = plan;
      if (refusal.reason === "newerRevision") throw new ServerProjectConflictError(refusal.storedRevision);
      if (refusal.reason === "newerMetadata") throw new ServerMetadataConflictError();
      if (refusal.reason === "deleted") throw new ServerProjectDeletedError(refusal.deletedRevision);
      throw new LocalizedError("errors.projects.changedBeforeSave");
    }
    const next = {
      metadata: plan.next.metadata ?? stored.metadata,
      packageBytes: plan.next.writesPackage && packageWrite ? packageWrite.bytes : stored.packageBytes,
      updatedAt: now(),
    };
    projects.set(projectId, next);
    return plan.next.reported ? record(projectId, { ...next, metadata: plan.next.reported }) : null;
  }

  const api: ServerProjectApi = {
    async probe() {
      if (!enabled) return { enabled: false, projects: [] };
      return {
        enabled: true,
        projects: [...projects].flatMap(([projectId, stored]) => {
          const listed = record(projectId, stored);
          return listed ? [listed] : [];
        }),
      };
    },
    async fetchPackage(projectId) {
      if (fetchError) throw fetchError;
      const stored = projects.get(projectId);
      // The route reads the sidecar first, so the label is never newer than the bytes.
      const revision = stored?.metadata ? serverProjectRevision(stored.metadata) : undefined;
      return { bytes: stored?.packageBytes ?? null, revision };
    },
    async savePackage(projectId, bytes, revision, baseRevision) {
      return writeProject(projectId, null, { bytes, revision }, baseRevision);
    },
    async saveMetadata(projectId, metadata, baseMetadataRevision) {
      return writeProject(projectId, metadata as Record<string, unknown>, null, undefined, baseMetadataRevision);
    },
    async remove(projectId) {
      const stored = projects.get(projectId);
      if (!stored) return;
      tombstones.set(projectId, {
        deletedAt: now(),
        revision: serverProjectRevision(stored.metadata),
        metadataRevision: serverMetadataRevision(stored.metadata),
      });
      projects.delete(projectId);
    },
  };

  return {
    api,
    projects,
    tombstones,
    disable() {
      enabled = false;
    },
    failFetches(error: unknown) {
      fetchError = error;
    },
  };
}

/** Adapters for one tab. Idle work runs on the next macrotask; `now` is injectable. */
export function memoryProjectSyncAdapters({
  browser,
  preferences,
  server,
  now = () => Date.now(),
}: {
  browser: BrowserProjectStore;
  preferences: PreferenceStore;
  server: ServerProjectApi | null;
  now?: () => number;
}): ProjectSyncAdapters {
  return {
    browser,
    preferences,
    server,
    codec: { parse: (bytes) => importSkfProject(bytes), pack: projectSkfPackage },
    scheduler: { now, whenIdle: (task) => setTimeout(task, 0) },
    message: (key) => key,
  };
}
