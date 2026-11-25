/**
 * The seam of the project sync module: everything it reads or writes outside memory.
 *
 * `browserAdapters.ts` implements these over IndexedDB, `localStorage` and fetch;
 * `memoryAdapters.ts` implements them in memory for tests.
 */
import type { ProjectConfigurationState, EditorHistoryEntry } from "@/lib/engine/editorHistory";
import type { SkfRestoredProject } from "@/lib/engine/skfProject";
import type { ProjectShapeCacheEntry, ProjectShapeSaveContext } from "@/lib/projectShapeCache";
import type { ServerProjectListing, ServerProjectRecord } from "@/lib/serverProjectStore";
import type { ProjectAsset, ProjectParameter, WorkplaneShape } from "@/types/sketchforge";

/** A `localStorage`-like store. `setItem` may throw when storage is full, as `localStorage` does. */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** `localStorage`, plus the `storage` events other tabs of this browser raise. */
export type PreferenceStore = KeyValueStore & {
  subscribe(listener: (key: string | null, newValue: string | null) => void): () => void;
};

/**
 * One project as browser storage returns it. A packed record carries `skfPackage`;
 * a pre-`.skf` record carries its shapes, already hydrated from their resources.
 */
export type BrowserProjectRecord = {
  id: string;
  revision: number;
  updatedAt: number;
  skfPackage?: Uint8Array;
  shapes?: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  assets?: ProjectAsset[];
  parameters?: ProjectParameter[];
  configuration?: ProjectConfigurationState;
};

/** IndexedDB. Read errors keep their DOMException names, which say whether a retry can help. */
export type BrowserProjectStore = {
  /** Throws `StoredProjectUnreadableError` for a pre-`.skf` record missing resources. */
  read(projectId: string): Promise<BrowserProjectRecord | null>;
  /** The stored bytes unparsed, for repair; a pre-`.skf` record comes back as JSON. */
  readCopy(projectId: string): Promise<{ bytes: Uint8Array; format: "skf" | "json" } | null>;
  /** Stores the package unless the stored record has a newer revision. */
  write(projectId: string, revision: number, skfPackage: Uint8Array): Promise<void>;
  remove(projectId: string): Promise<void>;
};

/** The dashboard's `/api/projects` route. Errors are the store's typed errors (409, 410, busy retry inside). */
export type ServerProjectApi = {
  probe(): Promise<ServerProjectListing & { error?: Record<string, unknown> }>;
  fetchPackage(projectId: string): Promise<{ bytes: Uint8Array | null; revision: number | undefined }>;
  savePackage(projectId: string, bytes: Uint8Array, revision: number, baseRevision?: number): Promise<ServerProjectRecord | null>;
  saveMetadata(projectId: string, metadata: unknown, baseMetadataRevision?: number): Promise<ServerProjectRecord | null>;
  remove(projectId: string): Promise<void>;
};

/** Packs and parses `.skf` packages. Tests may use a cheaper format. */
export type ProjectCodec = {
  parse(bytes: Uint8Array): Promise<SkfRestoredProject>;
  pack(projectId: string, entry: ProjectShapeCacheEntry, context: ProjectShapeSaveContext): Promise<Uint8Array>;
};

export type Scheduler = {
  now(): number;
  /** Runs `task` when the page is idle, so autosave does not compete with editing. */
  whenIdle(task: () => void): void;
};

export type ProjectSyncAdapters = {
  browser: BrowserProjectStore;
  preferences: PreferenceStore;
  /** Absent in the static build, which has no server to ask. */
  server: ServerProjectApi | null;
  codec: ProjectCodec;
  scheduler: Scheduler;
  /** Translates the module's own error messages. */
  message(key: ProjectSyncMessageKey, params?: Record<string, string | number>): string;
};

export type ProjectSyncMessageKey =
  | "dashboard.storage.unreadableWriteRefused"
  | "dashboard.storage.deletedWriteRefused";
