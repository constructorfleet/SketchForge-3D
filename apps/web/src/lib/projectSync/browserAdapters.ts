/** The project sync module's adapters over IndexedDB, `localStorage` and the `/api/projects` route. */
import type { EditorHistoryEntry, ProjectConfigurationState } from "@/lib/engine/editorHistory";
import { importSkfProject } from "@/lib/engine/skfProject";
import { translate } from "@/i18n";
import { hydrateProjectShapeState, type ImportedMeshResource } from "@/lib/projectShapePersistence";
import { projectSkfPackage } from "@/lib/projectShapeCache";
import { StoredProjectUnreadableError } from "./storageErrors";
import {
  deleteServerProject,
  fetchServerProjectPackage,
  probeServerProjects,
  saveServerProjectMetadata,
  saveServerProjectPackage,
} from "@/lib/serverProjectStore";
import { storedRecordJson } from "@/lib/storedProjectCopy";
import type { ProjectAsset, ProjectParameter, WorkplaneShape } from "@/types/sketchforge";
import type { BrowserProjectRecord, BrowserProjectStore, PreferenceStore, ProjectSyncAdapters, ServerProjectApi } from "./adapters";

const PROJECT_SHAPES_DB_NAME = "sketchForge.projectShapes";
const PROJECT_SHAPES_STORE_NAME = "projectShapes";
const PROJECT_SHAPE_RESOURCES_STORE_NAME = "projectShapeResources";

type ProjectShapeRecord = {
  id: string;
  revision: number;
  skfPackage?: Uint8Array;
  shapes?: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  assets?: ProjectAsset[];
  parameters?: ProjectParameter[];
  configuration?: ProjectConfigurationState;
  meshResourceIds?: string[];
  assetResourceIds?: string[];
  updatedAt: number;
};

type ProjectShapeResourceRecord =
  | { id: string; projectId: string; resourceId: string; kind: "mesh"; mesh: ImportedMeshResource }
  | { id: string; projectId: string; resourceId: string; kind: "asset"; asset: ProjectAsset };

function openProjectShapesDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error(translate("dashboard.storage.unavailable")));
      return;
    }

    const request = window.indexedDB.open(PROJECT_SHAPES_DB_NAME, 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_SHAPES_STORE_NAME)) {
        database.createObjectStore(PROJECT_SHAPES_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PROJECT_SHAPE_RESOURCES_STORE_NAME)) {
        database.createObjectStore(PROJECT_SHAPE_RESOURCES_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error(translate("dashboard.storage.openFailed")));
    request.onsuccess = () => resolve(request.result);
  });
}

function projectResourceRecordId(projectId: string, kind: ProjectShapeResourceRecord["kind"], resourceId: string) {
  return `${projectId}:${kind}:${resourceId}`;
}

function readProjectShapeRecord(database: IDBDatabase, projectId: string) {
  return new Promise<ProjectShapeRecord | null>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_SHAPES_STORE_NAME, "readonly");
    const request = transaction.objectStore(PROJECT_SHAPES_STORE_NAME).get(projectId);
    request.onerror = () => reject(request.error ?? new Error(translate("dashboard.storage.loadFailed")));
    request.onsuccess = () => resolve((request.result as ProjectShapeRecord | undefined) ?? null);
    transaction.onerror = () => reject(transaction.error ?? new Error(translate("dashboard.storage.loadFailed")));
  });
}

function readAvailableProjectResources(database: IDBDatabase, projectId: string, record: ProjectShapeRecord) {
  return new Promise<ProjectShapeResourceRecord[]>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_SHAPE_RESOURCES_STORE_NAME, "readonly");
    const store = transaction.objectStore(PROJECT_SHAPE_RESOURCES_STORE_NAME);
    const found: ProjectShapeResourceRecord[] = [];
    [
      ...(record.meshResourceIds ?? []).map((resourceId) => projectResourceRecordId(projectId, "mesh", resourceId)),
      ...(record.assetResourceIds ?? []).map((resourceId) => projectResourceRecordId(projectId, "asset", resourceId)),
    ].forEach((id) => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) found.push(request.result as ProjectShapeResourceRecord);
      };
    });
    transaction.oncomplete = () => resolve(found);
    transaction.onerror = () => reject(transaction.error ?? new Error(translate("dashboard.storage.resourcesLoadFailed")));
  });
}

async function readBrowserRecord(projectId: string): Promise<BrowserProjectRecord | null> {
  const database = await openProjectShapesDb();
  const record = await readProjectShapeRecord(database, projectId);
  if (!record) {
    database.close();
    return null;
  }
  const meshResourceIds = record.meshResourceIds ?? [];
  const assetResourceIds = record.assetResourceIds ?? [];
  if (record.skfPackage || (meshResourceIds.length === 0 && assetResourceIds.length === 0)) {
    database.close();
    return { ...record, shapes: record.skfPackage ? record.shapes : record.shapes ?? [] };
  }

  const resourceRecords = await new Promise<ProjectShapeResourceRecord[]>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_SHAPE_RESOURCES_STORE_NAME, "readonly");
    const store = transaction.objectStore(PROJECT_SHAPE_RESOURCES_STORE_NAME);
    const records: ProjectShapeResourceRecord[] = [];
    const requests = [
      ...meshResourceIds.map((resourceId) => store.get(projectResourceRecordId(projectId, "mesh", resourceId))),
      ...assetResourceIds.map((resourceId) => store.get(projectResourceRecordId(projectId, "asset", resourceId))),
    ];
    requests.forEach((request) => {
      request.onsuccess = () => {
        if (request.result) records.push(request.result as ProjectShapeResourceRecord);
      };
      request.onerror = () => {
        transaction.abort();
      };
    });
    transaction.oncomplete = () => resolve(records);
    transaction.onerror = () => reject(transaction.error ?? new Error(translate("dashboard.storage.resourcesLoadFailed")));
    transaction.onabort = () => reject(transaction.error ?? new Error(translate("dashboard.storage.resourcesLoadFailed")));
  });
  database.close();

  const meshResources = new Map<string, ImportedMeshResource>();
  const assets: ProjectAsset[] = [];
  resourceRecords.forEach((resource) => {
    if (resource.kind === "mesh") meshResources.set(resource.resourceId, resource.mesh);
    else assets.push(resource.asset);
  });
  if (meshResources.size !== meshResourceIds.length || assets.length !== assetResourceIds.length) {
    throw new StoredProjectUnreadableError(new Error(translate("dashboard.storage.resourcesIncomplete")));
  }
  let hydrated: ReturnType<typeof hydrateProjectShapeState>;
  try {
    hydrated = hydrateProjectShapeState(record.shapes ?? [], record.history, meshResources);
  } catch (error) {
    throw new StoredProjectUnreadableError(error);
  }
  return { ...record, shapes: hydrated.shapes, history: hydrated.history, assets };
}

export const indexedDbProjectStore: BrowserProjectStore = {
  read: readBrowserRecord,
  async readCopy(projectId) {
    const database = await openProjectShapesDb();
    try {
      const record = await readProjectShapeRecord(database, projectId);
      if (!record) return null;
      if (record.skfPackage) return { bytes: new Uint8Array(record.skfPackage), format: "skf" };
      const resources = await readAvailableProjectResources(database, projectId, record);
      return { bytes: new TextEncoder().encode(storedRecordJson({ record, resources })), format: "json" };
    } finally {
      database.close();
    }
  },
  async write(projectId, revision, skfPackage) {
    const database = await openProjectShapesDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PROJECT_SHAPES_STORE_NAME, "readwrite");
      const store = transaction.objectStore(PROJECT_SHAPES_STORE_NAME);
      const existingRequest = store.get(projectId);
      existingRequest.onerror = () => {
        transaction.abort();
      };
      existingRequest.onsuccess = () => {
        const existing = existingRequest.result as ProjectShapeRecord | undefined;
        if (existing && existing.revision > revision) {
          return;
        }
        store.put({ id: projectId, revision, skfPackage, updatedAt: Date.now() } satisfies ProjectShapeRecord);
      };
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error(translate("dashboard.storage.saveFailed")));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error(translate("dashboard.storage.saveFailed")));
      };
    });
  },
  async remove(projectId) {
    const database = await openProjectShapesDb();
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PROJECT_SHAPES_STORE_NAME, "readwrite");
      transaction.objectStore(PROJECT_SHAPES_STORE_NAME).delete(projectId);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error(translate("dashboard.storage.deleteFailed")));
      };
    });
  },
};

/** `window.localStorage` and its `storage` events. */
export function localStoragePreferences(): PreferenceStore {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
    subscribe(listener) {
      const onStorage = (event: StorageEvent) => listener(event.key, event.newValue);
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  };
}

export const fetchServerProjectApi: ServerProjectApi = {
  probe: () => probeServerProjects(),
  fetchPackage: fetchServerProjectPackage,
  savePackage: saveServerProjectPackage,
  saveMetadata: saveServerProjectMetadata,
  remove: deleteServerProject,
};

/** The adapters the dashboard runs with. */
export function browserProjectSyncAdapters({ staticExport }: { staticExport: boolean }): ProjectSyncAdapters {
  return {
    browser: indexedDbProjectStore,
    preferences: localStoragePreferences(),
    server: staticExport ? null : fetchServerProjectApi,
    codec: { parse: (bytes) => importSkfProject(bytes), pack: projectSkfPackage },
    scheduler: {
      now: () => Date.now(),
      whenIdle(task) {
        if ("requestIdleCallback" in window) {
          window.requestIdleCallback(task, { timeout: 1200 });
          return;
        }
        globalThis.setTimeout(task, 32);
      },
    },
    message: (key, params) => translate(key, params),
  };
}
