/**
 * The project sync module (#678): every rule for storing dashboard projects and keeping
 * clients in step, behind adapters for IndexedDB, `localStorage` and the server.
 *
 * It owns the storage mode and the move to server storage, one sync status per
 * project, the revisions writes are based on, the package and metadata save
 * queues, and the delete records shared by this browser's tabs. The page calls
 * intent-level methods and renders what they return and emit.
 *
 * Its state lives as long as the instance. The dashboard makes one at module scope, so
 * the state lasts for the page's lifetime, as the module-level maps it replaced did.
 */
import { createCoalescingSaveQueue, type CoalescingSaveQueue } from "@/lib/saveQueue";
import { projectShapeCacheEntry, type ProjectShapeCacheEntry, type ProjectShapeSaveContext } from "@/lib/projectShapeCache";
import { reconcileLoadedProjectShapeCacheEntry } from "@/lib/projectShapePersistence";
import {
  PROJECT_TOMBSTONES_STORAGE_KEY,
  addProjectTombstone,
  readProjectTombstones,
  removeProjectTombstones,
  withoutDeletedProjects,
} from "./tombstones";
import {
  ProjectWriteRefusedError,
  StoredProjectMissingError,
  StoredProjectUnreadableError,
  indexedDbReadIsPermanent,
  mergeNewerServerProjects,
  projectLoadFailureKind,
  type ProjectLoadFailureKind,
} from "./storageErrors";
import { mergeMetadataFields } from "./metadataMerge";
import {
  ServerMetadataConflictError,
  ServerProjectConflictError,
  ServerProjectDeletedError,
  serverMetadataRevision,
  type ServerProjectRecord,
} from "@/lib/serverProjectStore";
import { SERVER_SYNCED_REVISIONS_STORAGE_KEY, readServerSyncedRevisions } from "./syncedRevisions";
import type { BrowserProjectRecord, ProjectSyncAdapters } from "./adapters";
import {
  MIGRATED_PROJECTS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  mergeProjectsForStorage,
  normalizeStoredProject,
  projectForStorage,
  projectShapeSaveContext,
  readProjects,
  readStoredProjects,
  restoreProjectsFromBeforeServerStorage,
  storedProjectIsUsable,
} from "./projectList";
import type { DashboardProject, ProjectSaveJob, ProjectStorageMode, ProjectSyncStatus, StoredDashboardProject } from "./types";

/** A project as storage holds it, parsed. `serverRevision` is the sidecar revision it was served at. */
export type LoadedProjectRecord = BrowserProjectRecord & {
  serverRevision?: number;
  /** The package's own time, possibly missing; Export all projects compares by it. */
  packageModifiedAt?: number;
};

export type ProjectSyncEvent =
  | { type: "status"; projectId: string; status: ProjectSyncStatus }
  /** An autosave landed. `waiting`: a newer one is queued behind it. */
  | { type: "saved"; projectId: string; job: ProjectSaveJob; waiting: boolean }
  | { type: "saveFailed"; projectId: string; job: ProjectSaveJob; error: unknown }
  /** Another client saved a newer copy. The kept copy is set. */
  | { type: "conflicted"; projectId: string; error: ServerProjectConflictError }
  /** Another client deleted it and the server refuses it. The kept copy is set when there is one. */
  | { type: "deletedElsewhere"; projectId: string }
  /** A list write merged in another client's changes; show `project`. */
  | { type: "metadataAdopted"; projectId: string; project: DashboardProject }
  | { type: "metadataFailed"; projectId: string; error: unknown };

export type OpenResult =
  | { kind: "loaded"; record: LoadedProjectRecord | null; entry: ProjectShapeCacheEntry; loadedRevision: number }
  | { kind: "failed"; failureKind: ProjectLoadFailureKind; error: unknown }
  /** `signal` aborted while the read was in flight; nothing changed. */
  | { kind: "canceled" };

export type StartOptions = {
  signal: AbortSignal;
  /** Server storage is off, and the browser list from before it was put back. */
  onRestored(projects: DashboardProject[]): void;
  /** Server storage took over. Called in the same tick as the switch. */
  onSwitched(projects: DashboardProject[]): void;
  /** After the switch, with the number of browser projects moved up. */
  onMigrated(migratedCount: number, projects: DashboardProject[]): void;
  onFailed(error: unknown): void;
};

export type ProjectSync = ReturnType<typeof createProjectSync>;

type MetadataSaveJob = { metadata: Record<string, unknown>; synced: Record<string, unknown> | undefined };
type BlockReason = Exclude<ProjectSyncStatus, "synced">;

export function createProjectSync(adapters: ProjectSyncAdapters) {
  const { browser, preferences, server, codec, scheduler } = adapters;
  const listeners = new Set<(event: ProjectSyncEvent) => void>();
  const emit = (event: ProjectSyncEvent) => listeners.forEach((listener) => listener(event));

  // Set once, after the probe and after browser-held projects moved up, so a save can
  // never land in the browser and be reported as stored on the server.
  let mode: ProjectStorageMode = "browser";

  // Per-project write state. `blockedAs` says why writes are held back; `deletedHere` refuses
  // them until the project is listed again (#665). Together they are one status.
  const blockedAs = new Map<string, BlockReason>();
  const deletedHere = new Set<string>();
  // The sidecar revision each server copy is based on (#650); no entry means an unconditional write.
  const baseRevisions = new Map<string, number>();
  // The sidecar revision each server project was last served at, readable or not.
  const servedRevisions = new Map<string, number>();
  // Server metadata as last synced, and its metadata revision (#656).
  const syncedMetadata = new Map<string, Record<string, unknown>>();
  const metadataRevisions = new Map<string, number>();
  // What the server holds for each project's list entry, so an unchanged list is not re-posted.
  const serverMetadataJson = new Map<string, string>();
  // Browser writes in flight, so the switch to the server can wait for them (#662).
  const pendingBrowserWrites = new Set<Promise<void>>();
  // Deleted while the browser held them; a migration removes their uploaded copies.
  const deletedInBrowser = new Set<string>();
  // The newest editor snapshot, and the copy a refused save keeps for Download or Save as new.
  const latestCopies = new Map<string, ProjectSaveJob>();
  const keptCopies = new Map<string, ProjectSaveJob>();
  const sequences = new Map<string, number>();
  let nextRevisionValue = 0;
  // The last list written, and the last one rewritten, so the list sync settles.
  let projectsJson = "";
  let projectsRewrite: string | null = null;
  let cachedCopyReader: (projectId: string) => ProjectSaveJob | undefined = () => undefined;

  const tombstones = () => readProjectTombstones(preferences);

  function status(projectId: string): ProjectSyncStatus {
    if (deletedHere.has(projectId)) return "deleted";
    return blockedAs.get(projectId) ?? "synced";
  }

  function setState(projectId: string, change: () => void) {
    const before = status(projectId);
    change();
    const after = status(projectId);
    if (after !== before) emit({ type: "status", projectId, status: after });
  }

  const block = (projectId: string, reason: BlockReason) => setState(projectId, () => blockedAs.set(projectId, reason));
  const release = (projectId: string) => setState(projectId, () => blockedAs.delete(projectId));
  const canWrite = (projectId: string) => status(projectId) === "synced";

  function rememberServerMetadata(projectId: string, metadata: unknown, synced: Record<string, unknown>) {
    metadataRevisions.set(projectId, serverMetadataRevision(metadata));
    syncedMetadata.set(projectId, synced);
  }

  function nextRevision(minimum = 0) {
    const revision = Math.max(scheduler.now(), nextRevisionValue + 1, minimum);
    nextRevisionValue = revision;
    return revision;
  }

  const raiseRevision = (revision: number) => {
    nextRevisionValue = Math.max(nextRevisionValue, revision);
  };

  // ---- Reading -------------------------------------------------------------------------

  async function parseStoredPackage(bytes: Uint8Array) {
    try {
      return await codec.parse(bytes);
    } catch (error) {
      throw new StoredProjectUnreadableError(error);
    }
  }

  async function readRecord(projectId: string): Promise<LoadedProjectRecord | null> {
    if (mode === "server" && server) {
      const served = await server.fetchPackage(projectId);
      // Kept even when the copy fails to load, so Start over replaces only what was seen.
      if (served.revision === undefined) servedRevisions.delete(projectId);
      else servedRevisions.set(projectId, served.revision);
      // The listing came from metadata sidecars, so this project has one. A missing or
      // symlinked package is not an empty project, and autosave must not replace it.
      if (!served.bytes) throw new StoredProjectMissingError();
      const packageBytes = served.bytes;
      const restored = await parseStoredPackage(packageBytes);
      return {
        id: projectId,
        serverRevision: served.revision,
        // Carried so the caller reads this as an already-packed record and does
        // not try to migrate it back up to the server it just came from.
        skfPackage: packageBytes,
        updatedAt: restored.modifiedAt || scheduler.now(),
        revision: restored.modifiedAt || scheduler.now(),
        packageModifiedAt: restored.modifiedAt,
        shapes: restored.shapes,
        history: restored.history,
        historyIndex: restored.historyIndex,
        assets: restored.assets,
        parameters: restored.parameters,
        configuration: { configurations: restored.configurations, activeConfiguration: restored.activeConfiguration },
      };
    }
    const record = await browser.read(projectId);
    if (!record?.skfPackage) return record;
    const restored = await parseStoredPackage(record.skfPackage);
    return {
      ...record,
      shapes: restored.shapes,
      history: restored.history,
      historyIndex: restored.historyIndex,
      assets: restored.assets,
      parameters: restored.parameters,
      configuration: { configurations: restored.configurations, activeConfiguration: restored.activeConfiguration },
    };
  }

  /** Reads and parses a project's stored copy. Records the served revision in server mode. */
  async function loadRecord(projectId: string) {
    try {
      return await readRecord(projectId);
    } catch (error) {
      // A newer schema or an undecodable value fails the same way on every retry.
      if (mode !== "server" && indexedDbReadIsPermanent(error)) throw new StoredProjectUnreadableError(error);
      throw error;
    }
  }

  // ---- Writing -------------------------------------------------------------------------

  async function writeUnguarded(projectId: string, entry: ProjectShapeCacheEntry, context: ProjectShapeSaveContext) {
    const skfPackage = await codec.pack(projectId, entry, context);
    if (mode === "server" && server) {
      try {
        await server.savePackage(projectId, skfPackage, entry.revision, baseRevisions.get(projectId));
      } catch (error) {
        // Later writes would be based on the same stale copy.
        if (error instanceof ServerProjectConflictError) block(projectId, "conflicted");
        throw error;
      }
      baseRevisions.set(projectId, entry.revision);
      return;
    }
    // Another tab deleted it; its write mark here may not have arrived yet (#670).
    if (tombstones().has(projectId)) throw new ProjectWriteRefusedError(adapters.message("dashboard.storage.deletedWriteRefused"));
    // Registered in the same tick as the storage check, before any await.
    let settle = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    pendingBrowserWrites.add(pending);
    try {
      await browser.write(projectId, entry.revision, skfPackage);
    } finally {
      pendingBrowserWrites.delete(pending);
      settle();
    }
  }

  /** Writes a project's package now, unless its status refuses writes. */
  async function write(projectId: string, entry: ProjectShapeCacheEntry, context: ProjectShapeSaveContext) {
    if (!canWrite(projectId)) throw new ProjectWriteRefusedError(adapters.message("dashboard.storage.unreadableWriteRefused"));
    return writeUnguarded(projectId, entry, context);
  }

  function writeWhenIdle(projectId: string, entry: ProjectShapeCacheEntry, context: ProjectShapeSaveContext) {
    return new Promise<void>((resolve, reject) => {
      scheduler.whenIdle(() => {
        void write(projectId, entry, context).then(resolve, reject);
      });
    });
  }

  function keepNewestCopy(projectId: string, copies: Array<ProjectSaveJob | undefined>) {
    const newest = copies.filter((copy): copy is ProjectSaveJob => Boolean(copy)).sort((a, b) => b.revision - a.revision)[0];
    if (newest) keptCopies.set(projectId, newest);
  }

  function markConflicted(projectId: string, job: ProjectSaveJob, error: ServerProjectConflictError) {
    block(projectId, "conflicted");
    // The refused save may not be the newest edit: one can be queued, or still being published.
    const latest = latestCopies.get(projectId);
    keptCopies.set(projectId, latest && latest.revision > job.revision ? latest : job);
    emit({ type: "conflicted", projectId, error });
  }

  // Another client deleted it; the server refuses every write to that id (#672).
  function markDeletedElsewhere(projectId: string, job?: ProjectSaveJob) {
    block(projectId, "deleted");
    keepNewestCopy(projectId, [job, latestCopies.get(projectId), cachedCopyReader(projectId)]);
    emit({ type: "deletedElsewhere", projectId });
  }

  const saveQueue: CoalescingSaveQueue<ProjectSaveJob> = createCoalescingSaveQueue<ProjectSaveJob>({
    run: (projectId, job) => writeWhenIdle(projectId, job.entry, job.context),
    onSaved: (projectId, job, outcome) => emit({ type: "saved", projectId, job, waiting: outcome.waiting }),
    onError: (projectId, job, error) => {
      if (error instanceof ServerProjectConflictError) {
        markConflicted(projectId, job, error);
        return;
      }
      // Already reported by the status that refused it.
      if (error instanceof ProjectWriteRefusedError) return;
      if (error instanceof ServerProjectDeletedError) {
        if (!tombstones().has(projectId)) markDeletedElsewhere(projectId, job);
        return;
      }
      emit({ type: "saveFailed", projectId, job, error });
    },
  });

  // One list write per project at a time, so each is based on the metadata revision the last returned.
  const postMetadata = async (projectId: string, job: MetadataSaveJob, current: Record<string, unknown> | undefined) => {
    const metadata = mergeMetadataFields(job.synced, job.metadata, current ?? job.synced ?? job.metadata);
    const record = await server!.saveMetadata(projectId, metadata, metadataRevisions.get(projectId));
    rememberServerMetadata(projectId, record?.metadata ?? metadata, metadata);
    return metadata;
  };
  const metadataQueue = createCoalescingSaveQueue<MetadataSaveJob>({
    run: async (projectId, job) => {
      // Deleted while this job waited (#672).
      if (tombstones().has(projectId)) return;
      let written: Record<string, unknown>;
      try {
        written = await postMetadata(projectId, job, syncedMetadata.get(projectId));
      } catch (error) {
        if (!(error instanceof ServerMetadataConflictError)) throw error;
        // Another client changed it since this list was read: keep both sides' changes.
        const listing = await server!.probe();
        const record = listing.projects.find((candidate) => candidate.projectId === projectId);
        if (!record) throw error;
        const current = projectForStorage(normalizeStoredProject(record.metadata as StoredDashboardProject, 0)) as unknown as Record<string, unknown>;
        rememberServerMetadata(projectId, record.metadata, current);
        written = await postMetadata(projectId, job, current);
      }
      if (JSON.stringify(written) === JSON.stringify(job.metadata)) return;
      // Show what was stored, and do not post it back.
      const adopted = normalizeStoredProject(written as StoredDashboardProject, 0);
      serverMetadataJson.set(projectId, JSON.stringify(projectForStorage(adopted)));
      emit({ type: "metadataAdopted", projectId, project: adopted });
    },
    onError: (projectId, _job, error) => {
      if (error instanceof ServerProjectDeletedError) {
        // Deleted in this browser: the refusal is the expected outcome.
        if (!tombstones().has(projectId)) markDeletedElsewhere(projectId);
        return;
      }
      serverMetadataJson.delete(projectId);
      emit({ type: "metadataFailed", projectId, error });
    },
  });

  function projectsFromServer(records: ServerProjectRecord[]) {
    const usable = records.filter((record) => storedProjectIsUsable(record.metadata as StoredDashboardProject));
    const projects = usable.map((record, index) => normalizeStoredProject(record.metadata as StoredDashboardProject, index));
    serverMetadataJson.clear();
    projects.forEach((project, index) => {
      const stored = projectForStorage(project);
      rememberServerMetadata(stored.id, usable[index].metadata, stored as unknown as Record<string, unknown>);
      serverMetadataJson.set(stored.id, JSON.stringify(stored));
    });
    return projects;
  }

  // ---- Start: the probe, and the move to server storage --------------------------------

  /**
   * Probes for server storage and, when it is on, moves browser-held projects up before
   * switching, so enabling the directory adopts them. A failure anywhere leaves the browser
   * in charge: half a list on the server is worse than none.
   */
  async function start(options: StartOptions) {
    const { signal } = options;
    if (!server) return;
    const probeRequestedAt = scheduler.now();
    const listing = await server.probe().catch(() => null);
    if (signal.aborted) return;
    if (!listing?.enabled) {
      const restored = restoreProjectsFromBeforeServerStorage(preferences);
      if (restored && restored.length > 0) options.onRestored(restored);
      return;
    }

    // The listing is driven by metadata sidecars, so a project counts as migrated once its
    // sidecar exists. Writing the package first means a half-migrated project is simply not
    // there yet and is tried again, rather than appearing with no geometry behind it.
    const migrated = new Map<string, { recordRevision: number; serverRevision: number }>();
    const migratedProjectIds = new Set<string>();
    const migratedEntries = new Map<string, DashboardProject>();
    // Browser copies newer than the one the server deleted: offered to keep after the switch.
    const deletedWithNewerCopy = new Map<string, { project: DashboardProject; record: LoadedProjectRecord }>();
    // Another client deleted it on the server, which refuses it for good (#672). Recording the
    // delete here drops it from every later pass and from the switched list.
    const deletedOnServer = (
      projectId: string,
      kept: { project: DashboardProject; record: LoadedProjectRecord | null },
      syncedRevision: number | undefined,
    ) => {
      // Edits this browser never sent would otherwise vanish with no way back. Revisions are
      // compared with this browser's own record, never the deleting client's clock.
      if (kept.record && (syncedRevision === undefined || kept.record.revision > syncedRevision)) {
        deletedWithNewerCopy.set(projectId, { project: kept.project, record: kept.record });
      }
      addProjectTombstone(preferences, projectId);
      deletedInBrowser.add(projectId);
      migratedProjectIds.delete(projectId);
      migrated.delete(projectId);
      baseRevisions.delete(projectId);
    };
    /** Returns false when the server refused the project as deleted. */
    const migrateProject = async (project: DashboardProject) => {
      migratedEntries.set(project.id, project);
      let record: LoadedProjectRecord | null = null;
      try {
        record = await loadRecord(project.id);
        if (record?.skfPackage) {
          const serverRevision = project.revision ?? record.revision;
          await server.savePackage(project.id, record.skfPackage, serverRevision);
          migrated.set(project.id, { recordRevision: record.revision, serverRevision });
          // Later saves are based on the uploaded copy, so they cannot overwrite a newer one (#650).
          baseRevisions.set(project.id, serverRevision);
        }
        await server.saveMetadata(project.id, projectForStorage(project));
        return true;
      } catch (error) {
        if (!(error instanceof ServerProjectDeletedError)) throw error;
        deletedOnServer(project.id, { project, record }, readServerSyncedRevisions(preferences)[project.id]);
        return false;
      }
    };

    let migratedCount = 0;
    const serverProjectIds = new Set(listing.projects.map((record) => record.projectId));
    // Re-reading the browser list between passes picks up a project created while an
    // earlier pass was still uploading, which the server list would otherwise drop.
    for (let pass = 0; pass < 3; pass += 1) {
      const pending = readStoredProjects(preferences).projects.filter((project) => !serverProjectIds.has(project.id));
      if (pending.length === 0) break;
      for (const project of pending) {
        let moved: boolean;
        try {
          moved = await migrateProject(project);
        } catch (error) {
          if (signal.aborted) return;
          options.onFailed(error);
          return;
        }
        if (signal.aborted) return;
        if (!moved) continue;
        migratedCount += 1;
        serverProjectIds.add(project.id);
        migratedProjectIds.add(project.id);
      }
    }
    if (signal.aborted) return;

    let adoptedRequestedAt = probeRequestedAt;
    let adopted = listing;
    if (migratedCount > 0) {
      const requestedAt = scheduler.now();
      const relisted = await server.probe().catch(() => null);
      if (relisted) {
        adopted = relisted;
        adoptedRequestedAt = requestedAt;
      }
    }
    if (signal.aborted || !adopted.enabled) return;

    // The browser stayed in charge while the listing was read (#662). Remove what it deleted
    // and upload what it saved meanwhile, still in browser storage, until a pass finds nothing.
    // No pass limit: switching with a browser write unsent would strand it in IndexedDB.
    const caughtUp = new Set<string>();
    const removedFromServer = new Set<string>();
    const conflicts = new Map<string, { project: DashboardProject; record: LoadedProjectRecord; error: ServerProjectConflictError }>();
    for (;;) {
      await Promise.allSettled([...pendingBrowserWrites]);
      if (signal.aborted) return;
      // Deletes made in another tab count too (#670).
      for (const projectId of tombstones()) deletedInBrowser.add(projectId);
      let changedAny = false;
      try {
        for (const projectId of migratedProjectIds) {
          if (!deletedInBrowser.has(projectId) || removedFromServer.has(projectId)) continue;
          await server.remove(projectId);
          if (signal.aborted) return;
          removedFromServer.add(projectId);
          baseRevisions.delete(projectId);
          changedAny = true;
        }
        // The browser list only discovers projects created during the wait: another tab's
        // switch removes it, and the moved projects are known without it.
        const browserList = new Map(readStoredProjects(preferences).projects.map((project) => [project.id, project]));
        for (const project of browserList.values()) {
          if (signal.aborted) return;
          if (serverProjectIds.has(project.id) || deletedInBrowser.has(project.id) || !canWrite(project.id)) continue;
          // Created during the wait: not in the listing, so it would vanish at the switch.
          if (!(await migrateProject(project))) {
            changedAny = true;
            continue;
          }
          migratedCount += 1;
          serverProjectIds.add(project.id);
          migratedProjectIds.add(project.id);
          changedAny = true;
        }
        for (const projectId of migratedProjectIds) {
          if (signal.aborted) return;
          const project = browserList.get(projectId) ?? migratedEntries.get(projectId);
          if (!project || deletedInBrowser.has(projectId) || conflicts.has(projectId) || !canWrite(project.id)) continue;
          const upload = migrated.get(project.id);
          if (!upload) continue;
          const record = await loadRecord(project.id);
          if (!record?.skfPackage || record.revision <= upload.recordRevision) continue;
          try {
            await server.savePackage(project.id, record.skfPackage, record.revision, upload.serverRevision);
          } catch (error) {
            if (error instanceof ServerProjectDeletedError) {
              deletedOnServer(project.id, { project, record }, upload.recordRevision);
              changedAny = true;
              continue;
            }
            if (!(error instanceof ServerProjectConflictError)) throw error;
            // Another tab sharing this IndexedDB already uploaded this very record.
            if (error.storedRevision !== record.revision) {
              conflicts.set(project.id, { project, record, error });
              continue;
            }
          }
          migrated.set(project.id, { recordRevision: record.revision, serverRevision: record.revision });
          migratedEntries.set(project.id, project);
          baseRevisions.set(project.id, record.revision);
          caughtUp.add(project.id);
          changedAny = true;
        }
      } catch (error) {
        if (signal.aborted) return;
        options.onFailed(error);
        return;
      }
      if (signal.aborted) return;
      const deletionPending = [...migratedProjectIds].some((id) => deletedInBrowser.has(id) && !removedFromServer.has(id));
      if (!changedAny && !deletionPending && pendingBrowserWrites.size === 0) break;
    }

    // Read in the same tick as the switch, so no browser edit lands in between.
    const browserProjects = new Map(readStoredProjects(preferences).projects.map((project) => [project.id, project]));
    mode = "server";
    const deletedDuringMove = (projectId: string) => migratedProjectIds.has(projectId) && deletedInBrowser.has(projectId);
    const adoptedProjects = projectsFromServer(adopted.projects).filter((project) => !deletedDuringMove(project.id));
    // Any other listed project is on the server, which outranks a delete made in this browser.
    removeProjectTombstones(preferences, adoptedProjects.map((project) => project.id), adoptedRequestedAt);
    projectsJson = JSON.stringify(adoptedProjects.map(projectForStorage));
    const lateProjects = [...migratedProjectIds]
      .filter((id) => !deletedInBrowser.has(id) && !adoptedProjects.some((candidate) => candidate.id === id))
      .flatMap((id) => {
        const entry = browserProjects.get(id) ?? migratedEntries.get(id);
        return entry ? [entry] : [];
      });
    // Entries that differ from the listing are re-sent by the list sync.
    const serverProjects = [
      ...adoptedProjects.map((project) => (caughtUp.has(project.id) ? browserProjects.get(project.id) ?? project : project)),
      ...lateProjects,
      // Listed only so the "deleted elsewhere" banner can offer the newer browser copy.
      ...[...deletedWithNewerCopy.values()].map(({ project }) => project),
    ];
    options.onSwitched(serverProjects);
    const recordJob = (project: DashboardProject, record: LoadedProjectRecord): ProjectSaveJob => {
      const entry = projectShapeCacheEntry(record.revision, record.shapes ?? [], record.history, record.historyIndex, record.assets, record.parameters, record.configuration);
      return { entry, context: projectShapeSaveContext(project), revision: record.revision, shapeCount: entry.shapes.length };
    };
    deletedWithNewerCopy.forEach(({ project, record }, projectId) => markDeletedElsewhere(projectId, recordJob(project, record)));
    conflicts.forEach(({ project, record, error }, projectId) => markConflicted(projectId, recordJob(project, record), error));
    try {
      const browserList = preferences.getItem(PROJECTS_STORAGE_KEY);
      if (browserList && browserList !== "[]") preferences.setItem(MIGRATED_PROJECTS_STORAGE_KEY, browserList);
      preferences.removeItem(PROJECTS_STORAGE_KEY);
      preferences.removeItem(SERVER_SYNCED_REVISIONS_STORAGE_KEY);
    } catch {
      // The list is on the server either way; a browser that refuses to
      // forget its copy only leaves a stale one behind.
    }
    options.onMigrated(migratedCount, serverProjects);
  }

  // ---- The list ------------------------------------------------------------------------

  /**
   * Stores the dashboard's list: the browser list in browser mode, changed metadata
   * sidecars in server mode. Returns the normalised list when the page should show it instead.
   * `listMode` is the mode of the render that produced `projects`, so a list from before
   * the switch is not posted as server metadata.
   */
  function persistList(projects: DashboardProject[], listMode: ProjectStorageMode): { rewrite: DashboardProject[] | null; error?: unknown } {
    const localSerialized = JSON.stringify(projects);
    // In server mode there is no stored list to merge against: each project's metadata
    // sidecar is the record, and the server rejects a write older than the one it holds.
    const storageProjects = listMode === "server"
      ? projects.map(projectForStorage)
      : withoutDeletedProjects(mergeProjectsForStorage(projects, preferences), tombstones());
    const serialized = JSON.stringify(storageProjects);
    if (projectsJson === serialized) return { rewrite: null };
    if (listMode === "server") {
      storageProjects.forEach((project) => {
        const projectJson = JSON.stringify(project);
        if (serverMetadataJson.get(project.id) === projectJson) return;
        serverMetadataJson.set(project.id, projectJson);
        metadataQueue.enqueue(project.id, { metadata: project as unknown as Record<string, unknown>, synced: syncedMetadata.get(project.id) });
      });
    } else {
      try {
        preferences.setItem(PROJECTS_STORAGE_KEY, serialized);
      } catch (error) {
        try {
          preferences.removeItem(PROJECTS_STORAGE_KEY);
          preferences.setItem(PROJECTS_STORAGE_KEY, serialized);
        } catch {
          return { rewrite: null, error };
        }
      }
    }
    projectsJson = serialized;
    if (serialized === localSerialized) return { rewrite: null };
    // Writing the normalised list back re-runs the list sync, which is fine while
    // normalising settles. A normaliser that alternated between two values would never
    // match; refusing to rewrite the same list twice bounds that to one wasted pass.
    if (projectsRewrite === localSerialized) return { rewrite: null };
    projectsRewrite = localSerialized;
    return { rewrite: storageProjects };
  }

  /** Writes the browser list at once, so a workspace change is stored before the list sync runs. */
  function writeBrowserListNow(projects: DashboardProject[]) {
    // In server mode the list sync owns the write; claiming it here would stop it ever reaching the server.
    if (mode === "server") return;
    try {
      const serialized = JSON.stringify(mergeProjectsForStorage(projects, preferences));
      preferences.setItem(PROJECTS_STORAGE_KEY, serialized);
      projectsJson = serialized;
    } catch {
      // The list sync retries.
    }
  }

  /** A deleted project another client saved again is listed again; saves for it resume (#665). */
  function listed(projects: ReadonlyArray<{ id: string }>) {
    for (const project of projects) {
      if (deletedHere.has(project.id)) setState(project.id, () => deletedHere.delete(project.id));
    }
  }

  /**
   * Re-reads the server listing when the page comes back into view, since server storage
   * has no storage event across clients (#650). `apply` receives the list update.
   */
  function onVisible(apply: (update: (current: DashboardProject[]) => DashboardProject[]) => void) {
    if (mode !== "server" || !server) return;
    const listingRequestedAt = scheduler.now();
    void server.probe().then((listing) => {
      if (!listing.enabled) return;
      const usable = listing.projects.filter((record) => storedProjectIsUsable(record.metadata as StoredDashboardProject));
      const recordsById = new Map(usable.map((record) => [record.projectId, record]));
      const fromServer = usable.map((record, index) => normalizeStoredProject(record.metadata as StoredDashboardProject, index));
      // A rename or settings change elsewhere moves only the metadata revision.
      const metadataIsNewer = (_mine: DashboardProject, theirs: DashboardProject) =>
        serverMetadataRevision(recordsById.get(theirs.id)?.metadata) > (metadataRevisions.get(theirs.id) ?? 0);
      apply((current) => {
        const merged = mergeNewerServerProjects(current, fromServer, metadataIsNewer);
        // Another client saved it after a delete here; it is genuinely back (#670).
        removeProjectTombstones(preferences, merged.changedIds, listingRequestedAt);
        // Already on the server, so the list sync need not post them back.
        for (const id of merged.changedIds) {
          const project = merged.projects.find((candidate) => candidate.id === id);
          if (!project) continue;
          const stored = projectForStorage(project);
          serverMetadataJson.set(id, JSON.stringify(stored));
          rememberServerMetadata(id, recordsById.get(id)?.metadata, stored as unknown as Record<string, unknown>);
        }
        return merged.projects;
      });
    }).catch(() => undefined);
  }

  /** Follows other tabs of this browser: their deletes (#670) and, in browser mode, their list. */
  function watchOtherTabs(handlers: { onDeleted(tombstones: Set<string>): void; onList(projects: DashboardProject[]): void }) {
    return preferences.subscribe((key, newValue) => {
      if (key === PROJECT_TOMBSTONES_STORAGE_KEY) {
        // Deleted in another tab: refuse its late saves here and drop it from this list.
        const deleted = tombstones();
        for (const projectId of deleted) forget(projectId);
        handlers.onDeleted(deleted);
        return;
      }
      if (key !== PROJECTS_STORAGE_KEY || mode === "server") return;
      projectsJson = newValue ?? "[]";
      handlers.onList(readProjects(preferences));
    });
  }

  // ---- Intents -------------------------------------------------------------------------

  /**
   * Loads a project to open it. `cached` is the copy the page already holds. On success,
   * later writes are based on the loaded copy only when it replaces `cached`; newer local
   * edits kept over it are still based on the older copy. On failure, writes are refused.
   * A read the page no longer wants, because the cache or the list changed, aborts `signal`.
   */
  async function open(project: DashboardProject, cached: ProjectShapeCacheEntry | undefined, signal?: AbortSignal): Promise<OpenResult> {
    const projectId = project.id;
    try {
      const record = await loadRecord(projectId);
      if (signal?.aborted) return { kind: "canceled" };
      release(projectId);
      const loadedRevision = record?.revision ?? 0;
      const revision = Math.max(project.revision ?? 0, loadedRevision, 1);
      const loadedEntry = projectShapeCacheEntry(Math.max(loadedRevision, 1), record?.shapes ?? [], record?.history, record?.historyIndex, record?.assets, record?.parameters, record?.configuration);
      const entry = loadedEntry.revision === revision ? loadedEntry : { ...loadedEntry, revision };
      if (mode === "server" && reconcileLoadedProjectShapeCacheEntry(cached, entry, loadedRevision) === entry) {
        const serverRevision = record?.serverRevision;
        if (serverRevision === undefined) baseRevisions.delete(projectId);
        else baseRevisions.set(projectId, serverRevision);
        latestCopies.delete(projectId);
        keptCopies.delete(projectId);
        // Revisions come from this clock. One behind the writer's would make every save look older.
        raiseRevision(Math.max(loadedRevision, serverRevision ?? 0));
      }
      if (record && !record.skfPackage && loadedRevision > 0) {
        // Migrate the data at the revision it was read at. The newer list revision could let
        // stale shapes outrank a live edit.
        void writeWhenIdle(projectId, loadedEntry, projectShapeSaveContext(project)).catch(() => {
          // The legacy record remains readable and migration can retry on the next load.
        });
      }
      return { kind: "loaded", record, entry, loadedRevision };
    } catch (error) {
      if (signal?.aborted) return { kind: "canceled" };
      const failureKind = projectLoadFailureKind(error);
      // A read runs only when the stored revision is newer than the cached copy, so that copy
      // is stale. Writes stop so nothing autosaves over the stored bytes.
      block(projectId, failureKind === "unavailable" ? "unavailable" : "unreadable");
      // Start over must still outrank the served revision when this clock is behind it.
      raiseRevision(servedRevisions.get(projectId) ?? 0);
      return { kind: "failed", failureKind, error };
    }
  }

  /**
   * Queues an editor snapshot for autosave. `build` receives the revision to pack it at.
   * `sequence` counts this project's snapshots in this client, from 1 and never repeating,
   * so a caller can tell its own echoes from another source's change.
   */
  function saveSnapshot(projectId: string, build: (revision: number) => Omit<ProjectSaveJob, "revision">) {
    const revision = nextRevision();
    const job: ProjectSaveJob = { ...build(revision), revision };
    const sequence = (sequences.get(projectId) ?? 0) + 1;
    sequences.set(projectId, sequence);
    // The newest edit, so a refused save can still be downloaded with everything in it.
    latestCopies.set(projectId, job);
    // The editor publishes after a delay, so a snapshot can arrive after its load failed.
    if (!canWrite(projectId)) {
      if (keptCopies.has(projectId)) keptCopies.set(projectId, job);
      return { accepted: false as const, job, sequence };
    }
    saveQueue.enqueue(projectId, job);
    return { accepted: true as const, job, sequence };
  }

  /** Replaces an unreadable stored copy with an empty project, after the user confirmed. */
  async function startOver(project: DashboardProject) {
    const revision = nextRevision((project.revision ?? 0) + 1);
    const entry = projectShapeCacheEntry(revision, []);
    const previous = blockedAs.get(project.id);
    release(project.id);
    // Replace only the copy that was seen; a save made since then is refused.
    const seen = servedRevisions.get(project.id);
    if (seen === undefined) baseRevisions.delete(project.id);
    else baseRevisions.set(project.id, seen);
    try {
      await write(project.id, entry, projectShapeSaveContext(project));
    } catch (error) {
      block(project.id, previous ?? "blocked");
      return { ok: false as const, error };
    }
    return { ok: true as const, entry, revision };
  }

  /** Refuses a project's writes until it is listed again, and drops what is known about it. */
  function forget(projectId: string) {
    setState(projectId, () => {
      blockedAs.delete(projectId);
      deletedHere.add(projectId);
    });
  }

  /** Drops a project deleted elsewhere from this browser, without a delete request. */
  function forgetDeleted(projectId: string) {
    addProjectTombstone(preferences, projectId);
    forget(projectId);
    keptCopies.delete(projectId);
    latestCopies.delete(projectId);
    baseRevisions.delete(projectId);
  }

  /** Deletes a project here and in its store. Other tabs and late saves see the delete record. */
  async function deleteProject(projectId: string) {
    if (mode !== "server") deletedInBrowser.add(projectId);
    addProjectTombstone(preferences, projectId);
    forget(projectId);
    baseRevisions.delete(projectId);
    servedRevisions.delete(projectId);
    keptCopies.delete(projectId);
    latestCopies.delete(projectId);
    if (mode === "server" && server) {
      await server.remove(projectId);
      return;
    }
    await browser.remove(projectId);
  }

  /** The stored bytes unparsed, for repair. */
  async function readStoredCopy(projectId: string) {
    if (mode === "server" && server) {
      const served = await server.fetchPackage(projectId);
      return served.bytes ? { bytes: served.bytes, format: "skf" as const } : null;
    }
    return browser.readCopy(projectId);
  }

  return {
    mode: () => mode,
    status,
    canWrite,
    subscribe(listener: (event: ProjectSyncEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The copy a refused save kept, for Download my copy and Save as new project. */
    keptCopy: (projectId: string) => keptCopies.get(projectId),
    /** The number of `saveSnapshot` calls for a project in this client. */
    localSequence: (projectId: string) => sequences.get(projectId) ?? 0,
    /** Lets the module offer the page's cached copy when a project is deleted elsewhere. */
    readCachedCopiesWith(reader: (projectId: string) => ProjectSaveJob | undefined) {
      cachedCopyReader = reader;
    },
    nextRevision,
    readBrowserList: () => readStoredProjects(preferences),
    start,
    persistList,
    writeBrowserListNow,
    listed,
    onVisible,
    watchOtherTabs,
    open,
    loadRecord,
    readStoredCopy,
    saveSnapshot,
    write,
    startOver,
    deleteProject,
    forgetDeleted,
    /** Resolves once no package or metadata write is running or queued. */
    idle: () => Promise.all([saveQueue.idle(), metadataQueue.idle()]).then(() => undefined),
  };
}
